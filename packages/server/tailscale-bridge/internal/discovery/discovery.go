// Package discovery advertises and probes the credential-free OMPiUI discovery contract.
package discovery

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	Path           = "/.well-known/ompiui-discovery"
	Port           = 18787
	MaxPeers       = 64
	Parallel       = 4
	MaxBody        = 4 * 1024
	RequestTimeout = 2 * time.Second
	TotalTimeout   = 8 * time.Second
	MaxConnections = 16
)

type Advertisement struct {
	Marker           string `json:"marker"`
	DiscoveryVersion int    `json:"discoveryVersion"`
	DisplayName      string `json:"displayName"`
	InstanceID       string `json:"instanceId"`
	Port             int    `json:"port"`
	Pairing          bool   `json:"pairing"`
}

type Result struct {
	Advertisement
	Address string `json:"address"`
}

func New(name, id string, port int) (Advertisement, error) {
	if id == "" {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return Advertisement{}, err
		}
		id = hex.EncodeToString(random[:])
	}
	a := Advertisement{"ompiui", 1, name, id, port, true}
	return a, a.Validate()
}

func (a Advertisement) Validate() error {
	if a.Marker != "ompiui" || a.DiscoveryVersion != 1 || !a.Pairing ||
		!utf8.ValidString(a.DisplayName) || utf8.RuneCountInString(a.DisplayName) > 128 ||
		len(a.InstanceID) != 32 || a.Port < 1 || a.Port > 65535 {
		return errors.New("invalid OMPiUI discovery schema")
	}
	if strings.TrimSpace(a.DisplayName) == "" {
		return errors.New("invalid discovery displayName")
	}
	for _, c := range a.DisplayName {
		if unicode.IsControl(c) {
			return errors.New("invalid discovery displayName")
		}
	}
	for _, c := range a.InstanceID {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return errors.New("invalid discovery instanceId")
		}
	}
	return nil
}

// Decode rejects missing, duplicate, unknown, null and incorrectly typed fields.
func Decode(data []byte) (Advertisement, error) {
	var a Advertisement
	if len(data) > MaxBody || !utf8.Valid(data) {
		return a, errors.New("invalid discovery body")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	token, err := dec.Token()
	if err != nil || token != json.Delim('{') {
		return a, errors.New("expected discovery object")
	}
	fields := map[string]any{"marker": &a.Marker, "discoveryVersion": &a.DiscoveryVersion,
		"displayName": &a.DisplayName, "instanceId": &a.InstanceID, "port": &a.Port, "pairing": &a.Pairing}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return a, err
		}
		name, ok := key.(string)
		dest, exists := fields[name]
		if !ok || !exists {
			return a, errors.New("unknown or duplicate discovery field")
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return a, err
		}
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return a, errors.New("null discovery field")
		}
		if err := json.Unmarshal(raw, dest); err != nil {
			return a, err
		}
		delete(fields, name)
	}
	if len(fields) != 0 {
		return a, errors.New("missing discovery fields")
	}
	if _, err := dec.Token(); err != nil {
		return a, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return a, errors.New("trailing discovery data")
	}
	return a, a.Validate()
}

func Handler(a Advertisement) (http.Handler, error) {
	if err := a.Validate(); err != nil {
		return nil, err
	}
	body, err := json.Marshal(a)
	if err != nil {
		return nil, err
	}
	slots := make(chan struct{}, Parallel)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.Path != Path || r.URL.EscapedPath() != Path || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			http.Error(w, "busy", http.StatusServiceUnavailable)
			return
		}
		// Also bound discovery writes when sharing the application proxy listener.
		controller := http.NewResponseController(w)
		_ = controller.SetWriteDeadline(time.Now().Add(RequestTimeout))
		defer controller.SetWriteDeadline(time.Time{})
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(body)
		_ = controller.Flush()
	}), nil
}

func Server(handler http.Handler) *http.Server {
	return &http.Server{Handler: handler, MaxHeaderBytes: MaxBody,
		ReadHeaderTimeout: RequestTimeout, ReadTimeout: RequestTimeout,
		WriteTimeout: RequestTimeout, IdleTimeout: 5 * time.Second}
}

// LimitListener bounds even connections that have not sent HTTP headers yet.
func LimitListener(listener net.Listener) net.Listener {
	return &limitedListener{Listener: listener, slots: make(chan struct{}, MaxConnections), done: make(chan struct{})}
}

type limitedListener struct {
	net.Listener
	slots chan struct{}
	done  chan struct{}
	once  sync.Once
}

func (l *limitedListener) Accept() (net.Conn, error) {
	select {
	case l.slots <- struct{}{}:
	case <-l.done:
		return nil, net.ErrClosed
	}
	conn, err := l.Listener.Accept()
	if err != nil {
		<-l.slots
		return nil, err
	}
	return &limitedConn{Conn: conn, release: func() { <-l.slots }}, nil
}

func (l *limitedListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return l.Listener.Close()
}

type limitedConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *limitedConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(c.release)
	return err
}

// Status is a snapshot of LocalClient.Status, not public endpoints or subnet routes.
type Status struct {
	BackendState string
	SelfIPs      []netip.Addr
	Peers        []Peer
}

type Peer struct {
	IPs    []netip.Addr
	Online bool
}
type StatusFunc func(context.Context) (Status, error)
type DialFunc func(context.Context, string, string) (net.Conn, error)

func tailnetIP(ip netip.Addr) bool {
	return ip.IsValid() && ip.Zone() == "" &&
		(netip.MustParsePrefix("100.64.0.0/10").Contains(ip) || netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(ip))
}

func PeerAddresses(status Status) []netip.Addr {
	self := make(map[netip.Addr]bool, len(status.SelfIPs))
	for _, ip := range status.SelfIPs {
		self[ip.Unmap()] = true
	}
	unique := map[netip.Addr]bool{}
	for _, peer := range status.Peers {
		if !peer.Online {
			continue
		}
		var best netip.Addr
		for _, ip := range peer.IPs {
			ip = ip.Unmap()
			if !tailnetIP(ip) || self[ip] {
				continue
			}
			if !best.IsValid() || ip.Is4() && !best.Is4() || ip.Is4() == best.Is4() && ip.Less(best) {
				best = ip
			}
		}
		if best.IsValid() {
			unique[best] = true
		}
	}
	addresses := make([]netip.Addr, 0, len(unique))
	for ip := range unique {
		addresses = append(addresses, ip)
	}
	sort.Slice(addresses, func(i, j int) bool { return addresses[i].Less(addresses[j]) })
	if len(addresses) > MaxPeers {
		addresses = addresses[:MaxPeers]
	}
	return addresses
}

func Discover(ctx context.Context, statusFunc StatusFunc, dial DialFunc) ([]Result, error) {
	ctx, cancel := context.WithTimeout(ctx, TotalTimeout)
	defer cancel()
	status, err := statusFunc(ctx)
	if err != nil {
		return nil, fmt.Errorf("Tailscale discovery status unavailable: %w", err)
	}
	if status.BackendState != "Running" {
		return nil, fmt.Errorf("Tailscale discovery requires Running state (current: %s); start or sign in first", status.BackendState)
	}
	addresses := PeerAddresses(status)
	jobs := make(chan int, len(addresses))
	for i := range addresses {
		jobs <- i
	}
	close(jobs)
	found := make([]*Result, len(addresses))
	var workers sync.WaitGroup
	for range Parallel {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for i := range jobs {
				if ctx.Err() != nil {
					return
				}
				if result, err := probe(ctx, addresses[i], dial); err == nil {
					found[i] = &result
				}
			}
		}()
	}
	workers.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	results := make([]Result, 0)
	for _, result := range found {
		if result != nil {
			results = append(results, *result)
		}
	}
	return results, nil
}

func probe(ctx context.Context, ip netip.Addr, dial DialFunc) (Result, error) {
	address := net.JoinHostPort(ip.String(), strconv.Itoa(Port))
	transport := &http.Transport{DisableKeepAlives: true, DisableCompression: true,
		ResponseHeaderTimeout: RequestTimeout, MaxResponseHeaderBytes: MaxBody,
		DialContext: func(ctx context.Context, network, target string) (net.Conn, error) {
			if network != "tcp" || target != address {
				return nil, errors.New("unexpected discovery dial target")
			}
			return dial(ctx, network, target)
		}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: RequestTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+address+Path, nil)
	if err != nil {
		return Result{}, err
	}
	response, err := client.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Result{}, errors.New("discovery endpoint rejected request")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, MaxBody+1))
	if err != nil {
		return Result{}, err
	}
	a, err := Decode(data)
	return Result{Advertisement: a, Address: ip.String()}, err
}

// Requests uses its own lock; cancellation never waits for a node/network lock.
type Requests struct {
	mu     sync.Mutex
	active map[string]*request
}
type request struct{ cancel context.CancelFunc }

func (r *Requests) Begin(id string) (context.Context, func(), error) {
	if id == "" {
		return nil, nil, errors.New("discovery requestID is required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active == nil {
		r.active = map[string]*request{}
	}
	if _, ok := r.active[id]; ok {
		return nil, nil, errors.New("discovery requestID is already active")
	}
	ctx, cancel := context.WithTimeout(context.Background(), TotalTimeout)
	entry := &request{cancel: cancel}
	r.active[id] = entry
	return ctx, func() {
		cancel()
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.active[id] == entry {
			delete(r.active, id)
		}
	}, nil
}

func (r *Requests) Cancel(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if entry := r.active[id]; entry != nil {
		entry.cancel()
	}
}

func (r *Requests) CancelAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, entry := range r.active {
		entry.cancel()
	}
}

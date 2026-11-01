package discovery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testAdvertisement(t *testing.T) Advertisement {
	t.Helper()
	a, err := New("desktop", "0123456789abcdef0123456789abcdef", 8787)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestSchema(t *testing.T) {
	a := testAdvertisement(t)
	body, _ := json.Marshal(a)
	if decoded, err := Decode(body); err != nil || decoded != a {
		t.Fatalf("roundtrip: %+v %v", decoded, err)
	}
	base := string(body)
	invalid := []string{
		strings.Replace(base, `"marker":"ompiui"`, `"marker":"other"`, 1),
		strings.Replace(base, `"discoveryVersion":1`, `"discoveryVersion":2`, 1),
		strings.Replace(base, `"discoveryVersion":1`, `"discoveryVersion":1.0`, 1),
		strings.Replace(base, `"port":8787`, `"port":0`, 1),
		strings.Replace(base, `"port":8787`, `"port":65536`, 1),
		strings.Replace(base, `"port":8787`, `"port":"8787"`, 1),
		strings.Replace(base, `"port":8787`, `"port":8787.5`, 1),
		strings.Replace(base, `"pairing":true`, `"pairing":false`, 1),
		strings.Replace(base, `"instanceId":"0123456789abcdef0123456789abcdef"`, `"instanceId":"0123456789ABCDEF0123456789ABCDEF"`, 1),
		strings.Replace(base, `"instanceId":"0123456789abcdef0123456789abcdef"`, `"instanceId":"short"`, 1),
		strings.Replace(base, `"displayName":"desktop"`, `"displayName":""`, 1),
		strings.Replace(base, `"displayName":"desktop"`, `"displayName":"bad\nname"`, 1),
		strings.Replace(base, `"displayName":"desktop"`, `"displayName":"`+strings.Repeat("名", 129)+`"`, 1),
		strings.Replace(base, `"displayName":"desktop",`, "", 1),
		strings.Replace(base, `"displayName":"desktop"`, `"displayName":null`, 1),
		strings.TrimSuffix(base, "}") + `,"marker":"ompiui"}`,
		strings.TrimSuffix(base, "}") + `,"token":"private"}`,
		base + `{}`, base + `null`, `[]`, `null`, base + strings.Repeat(" ", MaxBody),
	}
	for _, input := range invalid {
		if _, err := Decode([]byte(input)); err == nil {
			t.Errorf("accepted: %.180s", input)
		}
	}
	for _, port := range []int{1, 65535} {
		a, err := New(strings.Repeat("名", 128), "", port)
		if err != nil || len(a.InstanceID) != 32 {
			t.Fatalf("valid bounds/default ID: %+v %v", a, err)
		}
		body, _ := json.Marshal(a)
		if _, err := Decode(body); err != nil {
			t.Fatal(err)
		}
	}
}

func TestEndpoint(t *testing.T) {
	a := testAdvertisement(t)
	handler, err := Handler(a)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, path string
		code         int
	}{
		{"GET", Path, 200}, {"HEAD", Path, 405}, {"POST", Path, 405},
		{"GET", "/", 404}, {"GET", Path + "/", 404}, {"GET", Path + "?token=secret", 404},
		{"GET", "/.well-known/%6fmpiui-discovery", 404},
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(tc.method, tc.path, nil))
		if recorder.Code != tc.code || recorder.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%+v: %d %v", tc, recorder.Code, recorder.Header())
		}
		if tc.code == 200 {
			decoded, err := Decode(recorder.Body.Bytes())
			if err != nil || decoded != a {
				t.Fatalf("endpoint body: %s %v", recorder.Body, err)
			}
			var fields map[string]json.RawMessage
			_ = json.Unmarshal(recorder.Body.Bytes(), &fields)
			if len(fields) != 6 || !strings.HasPrefix(recorder.Header().Get("Content-Type"), "application/json") {
				t.Fatal("wire contract changed")
			}
		}
	}
	server := Server(handler)
	if server.MaxHeaderBytes != MaxBody || server.ReadTimeout != RequestTimeout ||
		server.ReadHeaderTimeout != RequestTimeout || server.WriteTimeout != RequestTimeout || server.IdleTimeout <= 0 {
		t.Fatalf("server is not bounded: %+v", server)
	}
	if _, err := Handler(Advertisement{}); err == nil {
		t.Fatal("invalid advertisement served")
	}
}

type blockingWriter struct {
	*httptest.ResponseRecorder
	entered, release chan struct{}
}

func (w *blockingWriter) Write(body []byte) (int, error) {
	w.entered <- struct{}{}
	<-w.release
	return w.ResponseRecorder.Write(body)
}

func TestHandlerConcurrency(t *testing.T) {
	handler, _ := Handler(testAdvertisement(t))
	entered, release := make(chan struct{}, Parallel), make(chan struct{})
	var workers sync.WaitGroup
	for range Parallel {
		workers.Add(1)
		go func() {
			defer workers.Done()
			handler.ServeHTTP(&blockingWriter{httptest.NewRecorder(), entered, release}, httptest.NewRequest("GET", Path, nil))
		}()
	}
	for range Parallel {
		<-entered
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest("GET", Path, nil))
	close(release)
	workers.Wait()
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatal("handler concurrency not bounded")
	}
}

func TestPeerAddresses(t *testing.T) {
	ip := netip.MustParseAddr
	status := Status{BackendState: "Running", SelfIPs: []netip.Addr{ip("100.64.0.1"), ip("fd7a:115c:a1e0::1")}, Peers: []Peer{
		{IPs: []netip.Addr{ip("fd7a:115c:a1e0::2"), ip("100.64.0.2")}, Online: true},
		{IPs: []netip.Addr{ip("fd7a:115c:a1e0::3")}, Online: true},
		{IPs: []netip.Addr{ip("100.64.0.1"), ip("fd7a:115c:a1e0::1")}, Online: true},
		{IPs: []netip.Addr{ip("100.64.0.4")}, Online: false},
		{IPs: []netip.Addr{ip("100.64.0.2")}, Online: true},
		{IPs: []netip.Addr{ip("192.168.0.2"), ip("8.8.8.8"), ip("2001:db8::1")}, Online: true},
	}}
	addresses := PeerAddresses(status)
	if len(addresses) != 2 || addresses[0] != ip("100.64.0.2") || addresses[1] != ip("fd7a:115c:a1e0::3") {
		t.Fatalf("unexpected peers: %v", addresses)
	}
	for i := range 80 {
		status.Peers = append(status.Peers, Peer{IPs: []netip.Addr{ip(fmt.Sprintf("100.64.1.%d", i+1))}, Online: true})
	}
	if got := PeerAddresses(status); len(got) != MaxPeers {
		t.Fatalf("peer bound: %d", len(got))
	}
}

func testStatus(count int) StatusFunc {
	return func(context.Context) (Status, error) {
		status := Status{BackendState: "Running"}
		for i := range count {
			status.Peers = append(status.Peers, Peer{IPs: []netip.Addr{netip.MustParseAddr(fmt.Sprintf("100.64.0.%d", i+2))}, Online: true})
		}
		return status, nil
	}
}

func testDial(server *httptest.Server) DialFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
}

func TestProbeAndNormalizedResults(t *testing.T) {
	a := testAdvertisement(t)
	handler, _ := Handler(a)
	var active, peak, calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); count > old; old = peak.Load() {
			if peak.CompareAndSwap(old, count) {
				break
			}
		}
		calls.Add(1)
		if r.Host != "100.64.0.2:18787" && !strings.HasSuffix(r.Host, ":18787") || r.Method != "GET" || r.URL.Path != Path {
			t.Errorf("unexpected probe: %s %s %s", r.Host, r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("probe leaked credentials")
		}
		time.Sleep(20 * time.Millisecond)
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	var dials atomic.Int32
	results, err := Discover(context.Background(), testStatus(80), func(ctx context.Context, network, address string) (net.Conn, error) {
		dials.Add(1)
		host, port, err := net.SplitHostPort(address)
		if err != nil || port != "18787" || !tailnetIP(netip.MustParseAddr(host)) {
			t.Errorf("unexpected target %s", address)
		}
		return testDial(server)(ctx, network, address)
	})
	if err != nil || len(results) != MaxPeers || dials.Load() != MaxPeers || calls.Load() != MaxPeers {
		t.Fatalf("probe: %d results, %d dials, %d calls, %v", len(results), dials.Load(), calls.Load(), err)
	}
	if peak.Load() > Parallel || peak.Load() < 2 {
		t.Fatalf("parallelism: %d", peak.Load())
	}
	for _, result := range results {
		if result.Advertisement != a || !tailnetIP(netip.MustParseAddr(result.Address)) {
			t.Fatalf("bad normalized result: %+v", result)
		}
		body, _ := json.Marshal(result)
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(body, &fields)
		if len(fields) != 7 {
			t.Fatalf("unexpected result wire schema: %s", body)
		}
	}
}

func TestProbeRejectsRedirectAndBodies(t *testing.T) {
	good, _ := json.Marshal(testAdvertisement(t))
	for _, tc := range []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"redirect", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/target", http.StatusFound) }},
		{"large", func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, string(good)+strings.Repeat(" ", MaxBody))
		}},
		{"schema", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"marker":"ompiui"}`) }},
		{"status", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusUnauthorized) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); tc.handler(w, r) }))
			defer server.Close()
			results, err := Discover(context.Background(), testStatus(1), testDial(server))
			if err != nil || len(results) != 0 || calls.Load() != 1 {
				t.Fatalf("rejection: %+v %v calls=%d", results, err, calls.Load())
			}
			body, _ := json.Marshal(results)
			if string(body) != "[]" {
				t.Fatalf("empty result: %s", body)
			}
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, string(good)) }))
	defer server.Close()
	result, err := probe(context.Background(), netip.MustParseAddr("fd7a:115c:a1e0::2"), testDial(server))
	if err != nil || result.Address != "fd7a:115c:a1e0::2" {
		t.Fatalf("IPv6 mapping: %+v %v", result, err)
	}
}

func TestProbeRequestDeadline(t *testing.T) {
	started := time.Now()
	_, err := probe(context.Background(), netip.MustParseAddr("100.64.0.2"), func(ctx context.Context, _, _ string) (net.Conn, error) {
		client, server := net.Pipe()
		go func() { defer server.Close(); _, _ = io.Copy(io.Discard, server) }()
		return client, nil
	})
	if err == nil || time.Since(started) > RequestTimeout+time.Second {
		t.Fatalf("request timeout: %v elapsed %v", err, time.Since(started))
	}
}

func TestDiscoverTotalBudget(t *testing.T) {
	noDial := func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("unexpected dial")
		return nil, errors.New("unexpected")
	}
	_, err := Discover(context.Background(), func(ctx context.Context) (Status, error) {
		deadline, ok := ctx.Deadline()
		remaining := time.Until(deadline)
		if !ok || remaining <= 0 || remaining > TotalTimeout {
			t.Fatalf("unbounded status budget: %v %v", deadline, ok)
		}
		return Status{BackendState: "Running"}, nil
	}, noDial)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err = Discover(ctx, func(ctx context.Context) (Status, error) {
		<-ctx.Done()
		return Status{}, ctx.Err()
	}, noDial)
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > time.Second {
		t.Fatalf("caller budget ignored: %v", err)
	}
}

func TestDiscoverStateAndCancellation(t *testing.T) {
	noDial := func(context.Context, string, string) (net.Conn, error) {
		t.Error("unexpected dial")
		return nil, errors.New("unexpected")
	}
	for _, state := range []string{"Stopped", "NeedsLogin", "Starting", "NeedsMachineAuth"} {
		_, err := Discover(context.Background(), func(context.Context) (Status, error) { return Status{BackendState: state}, nil }, noDial)
		if err == nil || !strings.Contains(err.Error(), state) {
			t.Fatalf("state %s: %v", state, err)
		}
	}
	if _, err := Discover(context.Background(), func(context.Context) (Status, error) { return Status{}, errors.New("login unavailable") }, noDial); err == nil {
		t.Fatal("status error lost")
	}
	ctx, cancel := context.WithCancel(context.Background())
	entered := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := Discover(ctx, func(ctx context.Context) (Status, error) { close(entered); <-ctx.Done(); return Status{}, ctx.Err() }, noDial)
		done <- err
	}()
	<-entered
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("status cancel: %v", err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	entered = make(chan struct{}, Parallel)
	go func() {
		_, err := Discover(ctx, testStatus(8), func(ctx context.Context, _, _ string) (net.Conn, error) {
			entered <- struct{}{}
			<-ctx.Done()
			return nil, ctx.Err()
		})
		done <- err
	}()
	for range Parallel {
		<-entered
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("probe cancel: %v", err)
	}
}

func TestRequestRegistry(t *testing.T) {
	var requests Requests
	if _, _, err := requests.Begin(""); err == nil {
		t.Fatal("empty request ID accepted")
	}
	first, finishFirst, err := requests.Begin("first")
	if err != nil {
		t.Fatal(err)
	}
	defer finishFirst()
	deadline, ok := first.Deadline()
	if !ok || time.Until(deadline) > TotalTimeout {
		t.Fatal("total deadline absent")
	}
	if _, _, err := requests.Begin("first"); err == nil {
		t.Fatal("duplicate accepted")
	}
	second, finishSecond, _ := requests.Begin("second")
	defer finishSecond()
	requests.Cancel("missing")
	requests.Cancel("first")
	if first.Err() != context.Canceled || second.Err() != nil {
		t.Fatal("cancellation crossed request IDs")
	}
	if _, _, err := requests.Begin("first"); err == nil {
		t.Fatal("ID reused before canceled request finished")
	}
	finishFirst()
	third, finishThird, err := requests.Begin("first")
	if err != nil {
		t.Fatal(err)
	}
	defer finishThird()
	finishFirst() // stale cleanup must not remove the replacement.
	requests.CancelAll()
	if second.Err() != context.Canceled || third.Err() != context.Canceled {
		t.Fatal("cancel all missed request")
	}
}

type pipeListener struct {
	calls atomic.Int32
	done  chan struct{}
	peers []net.Conn
	mu    sync.Mutex
}

func (l *pipeListener) Accept() (net.Conn, error) {
	l.calls.Add(1)
	client, server := net.Pipe()
	l.mu.Lock()
	l.peers = append(l.peers, server)
	l.mu.Unlock()
	return client, nil
}
func (l *pipeListener) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, peer := range l.peers {
		_ = peer.Close()
	}
	return nil
}
func (l *pipeListener) Addr() net.Addr { return &net.TCPAddr{} }

func TestListenerConnectionLimit(t *testing.T) {
	underlying := &pipeListener{}
	listener := LimitListener(underlying)
	defer listener.Close()
	var conns []net.Conn
	for range MaxConnections {
		conn, err := listener.Accept()
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, conn)
	}
	finished := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if conn != nil {
			conn.Close()
		}
		finished <- err
	}()
	select {
	case <-finished:
		t.Fatal("accepted too many connections")
	case <-time.After(20 * time.Millisecond):
	}
	if underlying.calls.Load() != MaxConnections {
		t.Fatal("limit applied after accepting")
	}
	_ = listener.Close()
	select {
	case err := <-finished:
		if !errors.Is(err, net.ErrClosed) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("close did not unblock accept")
	}
	for _, conn := range conns {
		_ = conn.Close()
		_ = conn.Close()
	}
}

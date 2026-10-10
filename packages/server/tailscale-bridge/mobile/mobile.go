package mobile

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/chenming0v0/ompiui-tailscale-bridge/internal/gateway"
	"tailscale.com/tsnet"
)

type route struct {
	server *http.Server
	url    string
}

var lock sync.Mutex
var node *tsnet.Server
var routes = map[string]route{}

// Start 在应用私有目录中恢复节点，不创建 Android VpnService。
func Start(stateDir, hostname string) (err error) {
	defer recoverNativeError("start", &err)
	lock.Lock()
	defer lock.Unlock()
	if node != nil {
		return nil
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	if err := prepareLogsDirectory(stateDir); err != nil {
		return fmt.Errorf("prepare Tailscale log directory: %w", err)
	}
	s := &tsnet.Server{
		Dir: stateDir, Hostname: hostname,
		UserLogf: func(string, ...any) {}, Logf: func(string, ...any) {},
	}
	if err := s.Start(); err != nil {
		s.Close()
		return err
	}
	node = s
	return nil
}

func Status() (result string, err error) {
	defer recoverNativeError("status", &err)
	lock.Lock()
	s := node
	lock.Unlock()
	if s == nil {
		return `{"BackendState":"Stopped","TailscaleIPs":[]}`, nil
	}
	client, err := s.LocalClient()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	status, err := client.StatusWithoutPeers(ctx)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(status)
	return string(data), err
}

func Login() (err error) {
	defer recoverNativeError("login", &err)
	lock.Lock()
	s := node
	lock.Unlock()
	if s == nil {
		return fmt.Errorf("Tailscale is not started")
	}
	client, err := s.LocalClient()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return client.StartLoginInteractive(ctx)
}

// OpenRoute 为一个 Tailnet 源创建回环入口，HTTP 和 WebSocket 使用同一路径。
func OpenRoute(origin string) (string, error) {
	target, err := tailnetURL(origin)
	if err != nil {
		return "", err
	}
	lock.Lock()
	defer lock.Unlock()
	if node == nil {
		return "", fmt.Errorf("Tailscale is not started")
	}
	key := target.String()
	if existing, ok := routes[key]; ok {
		return existing.url, nil
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	server := &http.Server{
		ReadHeaderTimeout: 10 * time.Second,
		Handler:           gateway.Proxy(target, node.Dial, false),
	}
	result := "http://" + listener.Addr().String()
	routes[key] = route{server: server, url: result}
	go server.Serve(listener)
	return result, nil
}

func Stop() error {
	lock.Lock()
	defer lock.Unlock()
	for _, r := range routes {
		r.server.Close()
	}
	routes = map[string]route{}
	if node == nil {
		return nil
	}
	err := node.Close()
	node = nil
	return err
}

func tailnetURL(origin string) (*url.URL, error) {
	target, err := url.Parse(origin)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.User != nil ||
		(target.Path != "" && target.Path != "/") || target.RawQuery != "" || target.Fragment != "" {
		return nil, fmt.Errorf("expected a Tailnet HTTP origin")
	}
	host := strings.ToLower(target.Hostname())
	ip, err := netip.ParseAddr(host)
	isTailnet := err == nil && (netip.MustParsePrefix("100.64.0.0/10").Contains(ip) ||
		netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(ip))
	if !isTailnet && !strings.HasSuffix(host, ".ts.net") {
		return nil, fmt.Errorf("only Tailscale addresses are allowed")
	}
	target.Path = ""
	return target, nil
}

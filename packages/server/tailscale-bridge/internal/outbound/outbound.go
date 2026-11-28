// Package outbound 让本机应用经内置节点访问 Tailnet 里的 OMPiUI。
package outbound

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/chenming0v0/ompiui-tailscale-bridge/internal/discovery"
	"github.com/chenming0v0/ompiui-tailscale-bridge/internal/gateway"
	"tailscale.com/ipn/ipnstate"
)

// Origin 校验一个 Tailnet HTTP 源，拒绝带路径、查询、凭据或非 Tailnet 主机的地址。
func Origin(origin string) (*url.URL, error) {
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

// DiscoveryStatus 取 LocalClient.Status 的快照并排除本机节点。
func DiscoveryStatus(status *ipnstate.Status) discovery.Status {
	if status == nil {
		return discovery.Status{}
	}
	result := discovery.Status{BackendState: status.BackendState, SelfIPs: append([]netip.Addr(nil), status.TailscaleIPs...)}
	if status.Self != nil {
		result.SelfIPs = append(result.SelfIPs, status.Self.TailscaleIPs...)
	}
	for _, peer := range status.Peer {
		if peer == nil {
			continue
		}
		if status.Self != nil && (peer == status.Self || status.Self.ID != "" && peer.ID == status.Self.ID) {
			continue
		}
		result.Peers = append(result.Peers, discovery.Peer{IPs: append([]netip.Addr(nil), peer.TailscaleIPs...), Online: peer.Online})
	}
	return result
}

type route struct {
	server *http.Server
	url    string
}

// Routes 为每个 Tailnet 源维护一个回环入口，HTTP 和 WebSocket 使用同一路径。
type Routes struct {
	mu     sync.Mutex
	routes map[string]route
}

// Open 返回 target 对应的回环地址；同一个源重复调用复用已有入口。
func (r *Routes) Open(target *url.URL, dial gateway.DialFunc) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := target.String()
	if existing, ok := r.routes[key]; ok {
		return existing.url, nil
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	server := &http.Server{
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       gateway.IdleTimeout,
		Handler:           gateway.Proxy(target, dial, false),
		ConnState:         gateway.IdleConnState,
	}
	result := "http://" + listener.Addr().String()
	if r.routes == nil {
		r.routes = map[string]route{}
	}
	r.routes[key] = route{server: server, url: result}
	go server.Serve(gateway.WithIdleTimeout(listener, gateway.IdleTimeout))
	return result, nil
}

// Close 关闭全部回环入口，之后的 Open 会重新创建。
func (r *Routes) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, entry := range r.routes {
		entry.server.Close()
	}
	r.routes = nil
}

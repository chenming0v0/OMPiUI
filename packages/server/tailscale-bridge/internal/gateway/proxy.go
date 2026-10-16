package gateway

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
)

type DialFunc func(context.Context, string, string) (net.Conn, error)

// 原生网络层只改变连接路径，HTTP 和 WebSocket 共用同一转发入口。
func Proxy(target *url.URL, dial DialFunc, preserveHost bool, forwardingToken ...string) http.Handler {
	transport := &http.Transport{
		DialContext:           dial,
		ForceAttemptHTTP2:     false,
		TLSHandshakeTimeout:   10 * time.Second,
		// 覆盖服务端 packages 命令的 60 秒预算，并保留响应传输余量。
		ResponseHeaderTimeout: 90 * time.Second,
	}
	return &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			if preserveHost {
				r.Out.Host = r.In.Host
			} else {
				r.Out.Host = target.Host
			}
			r.Out.Header.Del("x-ompiui-internal-tunnel")
			r.Out.Header.Del("x-forwarded-proto")
			r.SetXForwarded()
			if len(forwardingToken) > 0 && forwardingToken[0] != "" {
				host, _, err := net.SplitHostPort(r.In.RemoteAddr)
				if err == nil && net.ParseIP(host) != nil {
					r.Out.Header.Set("x-forwarded-for", host)
					r.Out.Header.Set("x-ompiui-internal-tunnel", forwardingToken[0])
				}
			}
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "Tailscale connection unavailable", http.StatusBadGateway)
		},
	}
}

func LoopbackURL(raw string) (*url.URL, error) {
	target, err := url.Parse(raw)
	if err != nil || target.Scheme != "http" || target.User != nil {
		return nil, fmt.Errorf("upstream must be a loopback HTTP origin")
	}
	ip := net.ParseIP(target.Hostname())
	if ip == nil || !ip.IsLoopback() || target.Port() == "" || target.Path != "" || target.RawQuery != "" || target.Fragment != "" {
		return nil, fmt.Errorf("upstream must be a loopback HTTP origin with a port")
	}
	return target, nil
}

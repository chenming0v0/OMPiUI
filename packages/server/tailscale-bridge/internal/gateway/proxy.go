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
func Proxy(target *url.URL, dial DialFunc, preserveHost bool) http.Handler {
	transport := &http.Transport{
		DialContext:           dial,
		ForceAttemptHTTP2:     false,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
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

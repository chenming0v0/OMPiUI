package gateway

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/coder/websocket"
)

func TestProxyPreservesAuthHostAndPairing(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-token" {
			w.WriteHeader(401)
			return
		}
		if r.Host != "100.101.2.3:8787" || r.URL.RawQuery != "pair=test.secret" {
			t.Errorf("lost target host or pairing query: %s %s", r.Host, r.URL)
		}
		if r.Header.Get("x-ompiui-internal-tunnel") != "" {
			t.Error("untrusted internal forwarding marker was retained")
		}
		w.Write([]byte("paired"))
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	bridge := httptest.NewServer(Proxy(target, (&net.Dialer{}).DialContext, true))
	defer bridge.Close()
	req, _ := http.NewRequest("GET", bridge.URL+"/api?pair=test.secret", nil)
	req.Host = "100.101.2.3:8787"
	req.Header.Set("x-ompiui-internal-tunnel", "spoofed")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("auth bypass: %d", resp.StatusCode)
	}
	req.Header.Set("Authorization", "Bearer private-token")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "paired" {
		t.Fatalf("unexpected response: %s", body)
	}
}

func TestProxyWebSocket(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		kind, data, err := conn.Read(r.Context())
		if err == nil {
			conn.Write(r.Context(), kind, data)
		}
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	bridge := httptest.NewServer(Proxy(target, (&net.Dialer{}).DialContext, false))
	defer bridge.Close()
	conn, _, err := websocket.Dial(context.Background(), bridge.URL+"/api/v1/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if err := conn.Write(context.Background(), websocket.MessageText, []byte("event-stream")); err != nil {
		t.Fatal(err)
	}
	_, data, err := conn.Read(context.Background())
	if err != nil || string(data) != "event-stream" {
		t.Fatalf("websocket proxy: %s %v", data, err)
	}
}

func TestLoopbackURL(t *testing.T) {
	for _, input := range []string{"http://127.0.0.1:8787", "http://[::1]:9191"} {
		if _, err := LoopbackURL(input); err != nil {
			t.Fatal(err)
		}
	}
	for _, input := range []string{"https://example.com:443", "http://192.168.1.1:8787", "http://user:pass@127.0.0.1:8787", "http://127.0.0.1:8787/api"} {
		if _, err := LoopbackURL(input); err == nil {
			t.Fatalf("accepted non-loopback origin %s", input)
		}
	}
}

func TestTrustedLocalForwardingOverwritesVisitorIdentity(t *testing.T) {
	var marker, forwarded string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		marker = r.Header.Get("x-ompiui-internal-tunnel")
		forwarded = r.Header.Get("x-forwarded-for")
		w.Write([]byte("ok"))
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	proxy := Proxy(target, (&net.Dialer{}).DialContext, true, "private-start-identity")
	for _, ip := range []string{"100.64.1.1", "100.64.1.2"} {
		req := httptest.NewRequest("GET", "http://tailnet.test/api/v1/host/pair/redeem", nil)
		req.RemoteAddr = net.JoinHostPort(ip, "12345")
		req.Header.Set("x-ompiui-internal-tunnel", "spoofed")
		req.Header.Set("x-forwarded-for", "6.6.6.6")
		proxy.ServeHTTP(httptest.NewRecorder(), req)
		if marker != "private-start-identity" || forwarded != ip {
			t.Fatalf("lost authenticated client identity: marker=%q forwarded=%q", marker, forwarded)
		}
	}
}

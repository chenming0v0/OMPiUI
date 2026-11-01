package main

import (
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/chenming0v0/ompiui-tailscale-bridge/internal/discovery"
)

func TestProxyHeaderDeadlineDoesNotLimitResponseLifetime(t *testing.T) {
	var calls atomic.Int32
	server := proxyHTTPServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		time.Sleep(50 * time.Millisecond)
		w.Write([]byte("complete"))
	}))
	if server.ReadHeaderTimeout != 10*time.Second {
		t.Fatalf("unexpected production header deadline: %v", server.ReadHeaderTimeout)
	}
	server.ReadHeaderTimeout = 25 * time.Millisecond
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	go server.Serve(listener)
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.Write([]byte("G"))
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := io.ReadAll(conn); err != nil {
		t.Fatalf("incomplete connection was not released before the read deadline: %v", err)
	}
	if calls.Load() != 0 {
		t.Fatal("incomplete request reached proxy handler")
	}
	response, err := http.Get("http://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || string(body) != "complete" {
		t.Fatalf("long response was truncated: %q %v", body, err)
	}
}

type discoveryAppListener struct {
	net.Listener
	port int
}

func (l discoveryAppListener) Addr() net.Addr { return &net.TCPAddr{Port: l.port} }

func TestDiscoveryConfiguration(t *testing.T) {
	cfg := config{hostname: "host", listenAddr: ":8787", upstream: "http://127.0.0.1:8787"}
	proxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "application") })
	app := discoveryAppListener{port: discovery.Port}
	unexpectedListen := func(string, string) (net.Listener, error) {
		t.Error("unexpected discovery listener")
		return nil, errors.New("unexpected")
	}
	handler, server, err := configureDiscovery(cfg, app, proxy, unexpectedListen)
	if err != nil || server != nil {
		t.Fatalf("shared-port setup: %v", err)
	}
	for _, tc := range []struct {
		method, path string
		code         int
		application  bool
	}{
		{"GET", discovery.Path, 200, false}, {"POST", discovery.Path, 405, false},
		{"GET", "/api", 200, true}, {"POST", "/rpc", 200, true}, {"GET", discovery.Path + "/other", 200, true},
	} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Code != tc.code || (w.Body.String() == "application") != tc.application {
			t.Errorf("%+v: %d %s", tc, w.Code, w.Body)
		}
		if tc.path == discovery.Path && tc.method == "GET" {
			a, err := discovery.Decode(w.Body.Bytes())
			if err != nil || a.Port != discovery.Port || a.DisplayName != cfg.hostname || len(a.InstanceID) != 32 {
				t.Fatalf("actual app port/defaults: %+v %v", a, err)
			}
		}
	}
	cfg.discoveryDisabled = true
	handler, _, err = configureDiscovery(cfg, app, proxy, unexpectedListen)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", discovery.Path, nil))
	if err != nil || w.Body.String() != "application" {
		t.Fatal("opt-out still advertises")
	}
	cfg.discoveryDisabled = false
	cfg.listenAddr = ""
	if _, _, err := configureDiscovery(cfg, app, proxy, unexpectedListen); err != nil {
		t.Fatal(err)
	}
	cfg.listenAddr = ":8787"
	cfg.upstream = ""
	if _, _, err := configureDiscovery(cfg, app, proxy, unexpectedListen); err != nil {
		t.Fatal(err)
	}
	cfg.upstream = "http://127.0.0.1:8787"
	bindError := errors.New("port occupied")
	handler, server, err = configureDiscovery(cfg, discoveryAppListener{port: 8787}, proxy, func(network, address string) (net.Listener, error) {
		if network != "tcp" || address != ":18787" {
			t.Errorf("wrong discovery bind %s %s", network, address)
		}
		return nil, bindError
	})
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/api", nil))
	if !errors.Is(err, bindError) || server != nil || w.Body.String() != "application" {
		t.Fatal("discovery bind failure broke proxy")
	}
}

func TestDedicatedDiscoveryListener(t *testing.T) {
	cfg := config{hostname: "host", discoveryName: "custom", discoveryID: "0123456789abcdef0123456789abcdef", listenAddr: ":8787", upstream: "http://127.0.0.1:8787"}
	var listener net.Listener
	proxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "application") })
	_, server, err := configureDiscovery(cfg, discoveryAppListener{port: 9999}, proxy, func(network, address string) (net.Listener, error) {
		if network != "tcp" || address != ":18787" {
			t.Fatalf("wrong bind %s %s", network, address)
		}
		var err error
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		return listener, err
	})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	response, err := http.Get("http://" + listener.Addr().String() + discovery.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	a, err := discovery.Decode(body)
	if err != nil || a.Port != 9999 || a.DisplayName != "custom" || a.InstanceID != cfg.discoveryID {
		t.Fatalf("dedicated payload: %+v %v", a, err)
	}
}

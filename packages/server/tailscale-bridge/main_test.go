package main

import (
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
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

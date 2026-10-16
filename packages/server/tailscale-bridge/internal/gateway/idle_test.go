package gateway

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestIdleHTTPConnectionCloses(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{
		IdleTimeout: 50 * time.Millisecond,
		Handler:     http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok") }),
	}
	defer server.Close()
	go server.Serve(WithIdleTimeout(listener, time.Second))
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprint(conn, "GET / HTTP/1.1\r\nHost: local\r\n\r\n")
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := reader.ReadByte(); err != io.EOF {
		t.Fatalf("idle HTTP connection was not closed: %v", err)
	}
}

func TestHijackedConnectionHasIdleDeadlineAndKeepsHeartbeats(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	idleClosed := make(chan error, 1)
	server := &http.Server{ConnState: IdleConnState, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, buffer, err := w.(http.Hijacker).Hijack()
		if err != nil {
			idleClosed <- err
			return
		}
		defer conn.Close()
		fmt.Fprint(buffer, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n")
		buffer.Flush()
		// 模拟 ReverseProxy 的持续双向转发。
		_, err = io.Copy(conn, buffer)
		idleClosed <- err
	})}
	defer server.Close()
	go server.Serve(WithIdleTimeout(listener, 150*time.Millisecond))
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprint(conn, "GET / HTTP/1.1\r\nHost: local\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n")
	reader := bufio.NewReader(conn)
	if _, err := http.ReadResponse(reader, nil); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		time.Sleep(30 * time.Millisecond)
		conn.SetDeadline(time.Now().Add(time.Second))
		fmt.Fprint(conn, "p")
		if value, err := reader.ReadByte(); err != nil || value != 'p' {
			t.Fatalf("active upgraded connection was closed: %v", err)
		}
	}
	select {
	case err := <-idleClosed:
		if timeout, ok := err.(net.Error); !ok || !timeout.Timeout() {
			t.Fatalf("expected idle timeout after heartbeats stop: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("upgraded connection never expired")
	}
}

func TestIdleDeadlinePreservesShorterHeaderDeadline(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	conn := &idleConn{Conn: left, timeout: time.Second}
	conn.SetReadDeadline(time.Now().Add(25 * time.Millisecond))
	start := time.Now()
	_, err := conn.Read(make([]byte, 1))
	if timeout, ok := err.(net.Error); !ok || !timeout.Timeout() || time.Since(start) > 500*time.Millisecond {
		t.Fatalf("short header deadline was overwritten: %v", err)
	}
}

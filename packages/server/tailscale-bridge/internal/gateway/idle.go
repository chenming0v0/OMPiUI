package gateway

import (
	"net"
	"net/http"
	"sync"
	"time"
)

const IdleTimeout = 120 * time.Second

type idleListener struct {
	net.Listener
	timeout time.Duration
}

// 普通 HTTP 期限交给 http.Server；配合 IdleConnState 回收升级后的空闲连接。
func WithIdleTimeout(listener net.Listener, timeout time.Duration) net.Listener {
	return &idleListener{Listener: listener, timeout: timeout}
}

func (l *idleListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &idleConn{Conn: conn, timeout: l.timeout}, nil
}

type idleConn struct {
	net.Conn
	timeout       time.Duration
	mu            sync.Mutex
	readDeadline  time.Time
	writeDeadline time.Time
	idleDeadline  time.Time
}

func (c *idleConn) deadline(requested time.Time) time.Time {
	if c.idleDeadline.IsZero() || (!requested.IsZero() && requested.Before(c.idleDeadline)) {
		return requested
	}
	return c.idleDeadline
}

// 升级后按任意方向的实际进展刷新共同空闲期限，避免单向传输误超时。
func IdleConnState(conn net.Conn, state http.ConnState) {
	if c, ok := conn.(*idleConn); ok && state == http.StateHijacked {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.idleDeadline = time.Now().Add(c.timeout)
		c.applyDeadlines()
	}
}

func (c *idleConn) applyDeadlines() {
	c.Conn.SetReadDeadline(c.deadline(c.readDeadline))
	c.Conn.SetWriteDeadline(c.deadline(c.writeDeadline))
}

func (c *idleConn) progressed() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.idleDeadline.IsZero() {
		c.idleDeadline = time.Now().Add(c.timeout)
		c.applyDeadlines()
	}
}

func (c *idleConn) SetReadDeadline(deadline time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.readDeadline = deadline
	return c.Conn.SetReadDeadline(c.deadline(deadline))
}

func (c *idleConn) SetWriteDeadline(deadline time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.writeDeadline = deadline
	return c.Conn.SetWriteDeadline(c.deadline(deadline))
}

func (c *idleConn) SetDeadline(deadline time.Time) error {
	if err := c.SetReadDeadline(deadline); err != nil {
		return err
	}
	return c.SetWriteDeadline(deadline)
}

func (c *idleConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.progressed()
	}
	return n, err
}

func (c *idleConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	if n > 0 {
		c.progressed()
	}
	return n, err
}

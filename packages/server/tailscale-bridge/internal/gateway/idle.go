package gateway

import (
	"net"
	"sync"
	"time"
)

const IdleTimeout = 120 * time.Second

type idleListener struct {
	net.Listener
	timeout time.Duration
}

// HTTP 升级会清空连接期限，因此在每次底层读写时更新空闲期限。
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
}

func (c *idleConn) deadline(requested time.Time) time.Time {
	idle := time.Now().Add(c.timeout)
	if !requested.IsZero() && requested.Before(idle) {
		return requested
	}
	return idle
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
	c.mu.Lock()
	err := c.Conn.SetReadDeadline(c.deadline(c.readDeadline))
	c.mu.Unlock()
	if err != nil {
		return 0, err
	}
	return c.Conn.Read(p)
}

func (c *idleConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	err := c.Conn.SetWriteDeadline(c.deadline(c.writeDeadline))
	c.mu.Unlock()
	if err != nil {
		return 0, err
	}
	return c.Conn.Write(p)
}

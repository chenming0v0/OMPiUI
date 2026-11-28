package mobile

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/chenming0v0/ompiui-tailscale-bridge/internal/discovery"
	"github.com/chenming0v0/ompiui-tailscale-bridge/internal/outbound"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

var lock sync.Mutex
var node *tsnet.Server
var routes outbound.Routes
var discoveryRequests discovery.Requests

// Discover probes existing Tailnet peers without starting a node or logging in.
func Discover(requestID string) (result string, err error) {
	defer recoverNativeError("discover", &err)
	lock.Lock()
	s := node
	if s == nil {
		lock.Unlock()
		return "", fmt.Errorf("Tailscale discovery unavailable: node is stopped; start and sign in first")
	}
	// Register while holding the node lock so Stop cannot miss this request.
	ctx, finish, err := discoveryRequests.Begin(requestID)
	lock.Unlock()
	if err != nil {
		return "", err
	}
	defer finish()
	results, err := discovery.Discover(ctx, func(ctx context.Context) (discovery.Status, error) {
		client, err := s.LocalClient()
		if err != nil {
			return discovery.Status{}, err
		}
		status, err := client.Status(ctx)
		if err != nil {
			return discovery.Status{}, err
		}
		return discoveryStatus(status), nil
	}, s.Dial)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(results)
	return string(data), err
}

// CancelDiscovery affects only the matching active discovery request.
func CancelDiscovery(requestID string) {
	discoveryRequests.Cancel(requestID)
}

func discoveryStatus(status *ipnstate.Status) discovery.Status {
	return outbound.DiscoveryStatus(status)
}

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

// IsStarted reports whether Start initialized a node, regardless of login state.
func IsStarted() bool {
	lock.Lock()
	defer lock.Unlock()
	return node != nil
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
	return routes.Open(target, node.Dial)
}

func Stop() error {
	lock.Lock()
	defer lock.Unlock()
	discoveryRequests.CancelAll()
	routes.Close()
	if node == nil {
		return nil
	}
	err := node.Close()
	node = nil
	return err
}

func tailnetURL(origin string) (*url.URL, error) {
	return outbound.Origin(origin)
}

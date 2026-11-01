package mobile

import (
	"context"
	"net/netip"
	"strings"
	"testing"

	"github.com/chenming0v0/ompiui-tailscale-bridge/internal/discovery"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/types/key"
)

func TestTailnetOrigins(t *testing.T) {
	for _, input := range []string{"http://100.64.0.1:8787", "https://host.example.ts.net", "http://[fd7a:115c:a1e0::1]:8787/"} {
		if _, err := tailnetURL(input); err != nil {
			t.Errorf("%s: %v", input, err)
		}
	}
	for _, input := range []string{"http://192.168.1.1", "http://100.128.1.1", "http://localhost", "http://public.example", "http://user:pass@host.ts.net", "ftp://host.ts.net", "http://host.ts.net/api", "http://host.ts.net?token=private"} {
		if _, err := tailnetURL(input); err == nil {
			t.Errorf("unexpected origin accepted: %s", input)
		}
	}
}

func TestDiscoveryStatusMapping(t *testing.T) {
	ip := netip.MustParseAddr
	self := &ipnstate.PeerStatus{ID: "self", Online: true, TailscaleIPs: []netip.Addr{ip("fd7a:115c:a1e0::1")}}
	status := &ipnstate.Status{BackendState: "Running", TailscaleIPs: []netip.Addr{ip("100.64.0.1")}, Self: self,
		Peer: map[key.NodePublic]*ipnstate.PeerStatus{
			key.NewNode().Public(): self,
			key.NewNode().Public(): {ID: "self", Online: true, TailscaleIPs: []netip.Addr{ip("100.64.0.8")}},
			key.NewNode().Public(): {ID: "peer", Online: true, TailscaleIPs: []netip.Addr{ip("fd7a:115c:a1e0::2"), ip("100.64.0.2")}, Addrs: []string{"192.168.1.2:1234"}, CurAddr: "8.8.8.8:1234", PeerAPIURL: []string{"http://192.168.1.2:9000"}},
			key.NewNode().Public(): {ID: "offline", Online: false, TailscaleIPs: []netip.Addr{ip("100.64.0.3")}},
			key.NewNode().Public(): nil,
		}}
	mapped := discoveryStatus(status)
	addresses := discovery.PeerAddresses(mapped)
	if len(addresses) != 1 || addresses[0] != ip("100.64.0.2") || len(mapped.SelfIPs) != 2 {
		t.Fatalf("mapping: %+v %v", mapped, addresses)
	}
	status.TailscaleIPs[0] = ip("100.64.0.9")
	if mapped.SelfIPs[0] != ip("100.64.0.1") {
		t.Fatal("snapshot shares mutable status slice")
	}
	if got := discoveryStatus(nil); got.BackendState != "" || len(got.Peers) != 0 {
		t.Fatal("nil status mapping")
	}
}

func TestDiscoverStoppedDoesNotStartNode(t *testing.T) {
	lock.Lock()
	if node != nil {
		lock.Unlock()
		t.Skip("test requires stopped node")
	}
	lock.Unlock()
	result, err := Discover("stopped-test")
	if err == nil || !strings.Contains(err.Error(), "stopped") || result != "" {
		t.Fatalf("stopped discovery: %q %v", result, err)
	}
	lock.Lock()
	defer lock.Unlock()
	if node != nil {
		t.Fatal("discovery started a node")
	}
}

func TestCancelDiscoveryAndStop(t *testing.T) {
	lock.Lock()
	if node != nil {
		lock.Unlock()
		t.Skip("test requires stopped node")
	}
	lock.Unlock()
	first, finishFirst, err := discoveryRequests.Begin("cancel-test")
	if err != nil {
		t.Fatal(err)
	}
	defer finishFirst()
	second, finishSecond, err := discoveryRequests.Begin("stop-test")
	if err != nil {
		t.Fatal(err)
	}
	defer finishSecond()
	CancelDiscovery("cancel-test")
	if first.Err() != context.Canceled || second.Err() != nil {
		t.Fatal("mobile cancel crossed request IDs")
	}
	if err := Stop(); err != nil {
		t.Fatal(err)
	}
	if second.Err() != context.Canceled {
		t.Fatal("Stop did not cancel outstanding discovery")
	}
}

package mobile

import (
	"net"
	"testing"

	"tailscale.com/net/netmon"
)

func TestAndroidNetworkInterfaces(t *testing.T) {
	snapshot := networkSnapshot{Interfaces: []networkInterface{
		{Name: "wlan0", Index: 7, MTU: 1500, Up: true, Multicast: true,
			Addresses: []string{"192.168.1.23/24", "2001:db8::23/64", "fe80::23/64"}},
		{Name: "lo", Index: 1, MTU: 65536, Up: true, Loopback: true, Addresses: []string{"127.0.0.1/8"}},
		{Name: "empty", Index: 99999, Up: false},
	}}
	interfaces, err := snapshot.interfaceList()
	if err != nil {
		t.Fatal(err)
	}
	if interfaces[0].Index != 7 || interfaces[0].MTU != 1500 ||
		interfaces[0].Flags != net.FlagUp|net.FlagRunning|net.FlagMulticast {
		t.Fatalf("lost interface properties: %+v", interfaces[0])
	}
	if !interfaces[1].IsLoopback() || interfaces[2].IsUp() {
		t.Fatal("incorrect loopback or down-interface flags")
	}
	wantAddresses := []string{"192.168.1.23/24", "2001:db8::23/64", "fe80::23/64"}
	addresses, err := interfaces[0].Addrs()
	if err != nil {
		t.Fatal(err)
	}
	for i, address := range addresses {
		if address.String() != wantAddresses[i] {
			t.Fatalf("address %d = %s, want %s", i, address, wantAddresses[i])
		}
	}
	addresses, err = interfaces[2].Addrs()
	if err != nil || len(addresses) != 0 || interfaces[2].AltAddrs == nil {
		t.Fatalf("empty interface attempted a system address lookup: %v, %v", addresses, err)
	}
}

func TestAndroidNetworkSnapshotUpdates(t *testing.T) {
	netmon.RegisterInterfaceGetter(currentNetworkInterfaces)
	t.Cleanup(func() { netmon.RegisterInterfaceGetter(nil) })
	initial := `{"interfaces":[{"name":"wlan0","up":true,"addresses":["192.168.1.23/24"]}]}`
	cellular := `{"interfaces":[{"name":"rmnet0","up":true,"addresses":["10.1.2.3/32"]}]}`
	for _, snapshot := range []struct{ json, name, address string }{
		{initial, "wlan0", "192.168.1.23/24"},
		{cellular, "rmnet0", "10.1.2.3/32"},
		{`{"interfaces":[]}`, "", ""},
	} {
		if err := UpdateNetworkState(snapshot.json); err != nil {
			t.Fatal(err)
		}
		interfaces, err := netmon.GetInterfaceList()
		if err != nil {
			t.Fatal(err)
		}
		if snapshot.name == "" {
			if len(interfaces) != 0 {
				t.Fatal("disconnected network retained old interfaces")
			}
			continue
		}
		if len(interfaces) != 1 || interfaces[0].Name != snapshot.name {
			t.Fatalf("stale network interfaces: %+v", interfaces)
		}
		addresses, err := interfaces[0].Addrs()
		if err != nil || len(addresses) != 1 || addresses[0].String() != snapshot.address {
			t.Fatalf("stale addresses: %v, %v", addresses, err)
		}
	}
	if err := UpdateNetworkState(`{"interfaces":[{"name":"bad","addresses":["invalid"]}]}`); err == nil {
		t.Fatal("invalid network update was accepted")
	}
	interfaces, err := netmon.GetInterfaceList()
	if err != nil || len(interfaces) != 0 {
		t.Fatalf("invalid update changed the last valid snapshot: %v, %v", interfaces, err)
	}
}

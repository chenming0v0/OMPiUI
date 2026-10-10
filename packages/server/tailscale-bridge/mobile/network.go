package mobile

import (
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"sync"

	"tailscale.com/net/netmon"
)

type networkSnapshot struct {
	Interfaces       []networkInterface `json:"interfaces"`
	DefaultInterface string             `json:"defaultInterface"`
	DefaultGateway   string             `json:"defaultGateway"`
}

type networkInterface struct {
	Name         string   `json:"name"`
	Index        int      `json:"index"`
	MTU          int      `json:"mtu"`
	Up           bool     `json:"up"`
	Loopback     bool     `json:"loopback"`
	PointToPoint bool     `json:"pointToPoint"`
	Multicast    bool     `json:"multicast"`
	Addresses    []string `json:"addresses"`
}

var networkLock sync.RWMutex
var networkInterfaces []netmon.Interface

// UpdateNetworkState 在启动前接收 Android 网络信息，避免 Go 访问被系统禁止的 Netlink。
func UpdateNetworkState(snapshotJSON string) error {
	var snapshot networkSnapshot
	if err := json.Unmarshal([]byte(snapshotJSON), &snapshot); err != nil {
		return fmt.Errorf("invalid Android network state: %w", err)
	}
	interfaces, err := snapshot.interfaceList()
	if err != nil {
		return err
	}
	networkLock.Lock()
	networkInterfaces = interfaces
	networkLock.Unlock()
	updateDefaultNetwork(snapshot.DefaultInterface, snapshot.DefaultGateway)

	lock.Lock()
	defer lock.Unlock()
	if node != nil {
		node.Sys().NetMon.Get().InjectEvent()
	}
	return nil
}

func currentNetworkInterfaces() ([]netmon.Interface, error) {
	networkLock.RLock()
	defer networkLock.RUnlock()
	return networkInterfaces, nil
}

func (snapshot networkSnapshot) interfaceList() ([]netmon.Interface, error) {
	interfaces := make([]netmon.Interface, 0, len(snapshot.Interfaces))
	for _, entry := range snapshot.Interfaces {
		var flags net.Flags
		if entry.Up {
			flags |= net.FlagUp | net.FlagRunning
		}
		if entry.Loopback {
			flags |= net.FlagLoopback
		}
		if entry.PointToPoint {
			flags |= net.FlagPointToPoint
		}
		if entry.Multicast {
			flags |= net.FlagMulticast
		}
		// 空地址列表也必须非 nil，否则 netmon 会再次调用系统 Interface.Addrs。
		addresses := make([]net.Addr, 0, len(entry.Addresses))
		for _, address := range entry.Addresses {
			prefix, err := netip.ParsePrefix(address)
			if err != nil {
				return nil, fmt.Errorf("invalid address for Android interface %s: %w", entry.Name, err)
			}
			addresses = append(addresses, &net.IPNet{
				IP:   net.IP(prefix.Addr().AsSlice()),
				Mask: net.CIDRMask(prefix.Bits(), prefix.Addr().BitLen()),
			})
		}
		interfaces = append(interfaces, netmon.Interface{
			Interface: &net.Interface{Name: entry.Name, Index: entry.Index, MTU: entry.MTU, Flags: flags},
			AltAddrs:  addresses,
		})
	}
	return interfaces, nil
}

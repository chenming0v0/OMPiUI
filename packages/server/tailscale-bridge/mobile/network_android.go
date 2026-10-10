package mobile

import "tailscale.com/net/netmon"

func init() {
	netmon.RegisterInterfaceGetter(currentNetworkInterfaces)
}

func updateDefaultNetwork(name, gateway string) {
	netmon.UpdateLastKnownDefaultRouteInterface(name)
	netmon.UpdateLastKnownDefaultGateway(gateway)
}

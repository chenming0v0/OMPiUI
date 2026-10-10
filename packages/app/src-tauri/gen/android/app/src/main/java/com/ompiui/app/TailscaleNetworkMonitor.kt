package com.ompiui.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import com.ompiui.tailscale.mobile.Mobile
import java.net.NetworkInterface
import org.json.JSONArray
import org.json.JSONObject

internal class TailscaleNetworkMonitor(
  context: Context,
  private val onChanged: () -> Unit,
) {
  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  private var registered = false
  private val callback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) = onChanged()
    override fun onLost(network: Network) = onChanged()
    override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) = onChanged()
  }

  fun start() {
    if (registered) return
    connectivity.registerDefaultNetworkCallback(callback)
    registered = true
  }

  fun refresh() {
    val interfaces = JSONArray()
    val enumeration = NetworkInterface.getNetworkInterfaces()
    while (enumeration != null && enumeration.hasMoreElements()) {
      val networkInterface = enumeration.nextElement()
      val addresses = JSONArray()
      for (address in networkInterface.interfaceAddresses) {
        val host = address.address.hostAddress ?: continue
        addresses.put("${host.substringBefore('%')}/${address.networkPrefixLength}")
      }
      interfaces.put(JSONObject()
        .put("name", networkInterface.name)
        .put("index", networkInterface.index)
        .put("mtu", networkInterface.mtu)
        .put("up", networkInterface.isUp)
        .put("loopback", networkInterface.isLoopback)
        .put("pointToPoint", networkInterface.isPointToPoint)
        .put("multicast", networkInterface.supportsMulticast())
        .put("addresses", addresses))
    }
    val properties = connectivity.activeNetwork?.let { connectivity.getLinkProperties(it) }
    val gateway = properties?.routes?.firstOrNull {
      it.isDefaultRoute && it.gateway != null
    }?.gateway?.hostAddress.orEmpty()
    Mobile.updateNetworkState(JSONObject()
      .put("interfaces", interfaces)
      .put("defaultInterface", properties?.interfaceName.orEmpty())
      .put("defaultGateway", gateway.substringBefore('%'))
      .toString())
  }

  fun stop() {
    if (!registered) return
    connectivity.unregisterNetworkCallback(callback)
    registered = false
  }
}

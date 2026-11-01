package com.ompiui.app

import java.net.Inet6Address
import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LanDiscoveryValidationTest {
  private val instanceId = "0123456789abcdef0123456789abcdef"
  private fun txt(vararg changes: Pair<String, String>): Map<String, ByteArray> =
    (mapOf("marker" to "ompiui", "discoveryVersion" to "1", "displayName" to "书房电脑",
      "instanceId" to instanceId, "port" to "8787", "pairing" to "true") + changes.toMap())
      .mapValues { it.value.toByteArray(Charsets.UTF_8) }
  private fun host(address: String) = InetAddress.getByName(address)
  private fun map(attributes: Map<String, ByteArray> = txt(), port: Int = 8787,
    hosts: List<InetAddress> = listOf(host("192.168.1.20"))) =
    LanDiscoveryValidation.map(attributes, port, hosts)

  @Test fun mapsOnlyAcceptedFieldsAndActualHost() {
    val device = map(txt("url" to "https://malicious.invalid", "address" to "100.64.1.2"))!!
    assertEquals("书房电脑", device.displayName)
    assertEquals(instanceId, device.instanceId)
    assertEquals(8787, device.port)
    assertEquals("192.168.1.20", device.address)
  }

  @Test fun requiresExactProtocolAndPairing() {
    for ((key, value) in listOf("marker" to "other", "discoveryVersion" to "2",
      "pairing" to "false", "pairing" to "TRUE", "instanceId" to instanceId.uppercase(),
      "instanceId" to "short", "port" to "8788", "port" to "+8787")) {
      assertNull("$key=$value", map(txt(key to value)))
    }
    for (key in txt().keys) assertNull("missing $key", map(txt() - key))
    assertNull(map(port = 0))
    assertNull(map(txt("port" to "65536"), port = 65536))
    assertNotNull(map(txt("port" to "65535"), port = 65535))
  }

  @Test fun rejectsInvalidUtf8AndUnsafeOrLongDisplayNames() {
    for (name in listOf("", "   ", "line\nbreak", "null\u0000byte", "spoof‮text",
      "line separator", "x".repeat(129))) assertNull(map(txt("displayName" to name)))
    assertNotNull(map(txt("displayName" to "x".repeat(128))))
    assertNotNull(map(txt("displayName" to "😀".repeat(128))))
    assertNull(map(txt() + ("displayName" to byteArrayOf(0xc3.toByte(), 0x28))))
  }

  @Test fun excludesTailnetAndNonLanHosts() {
    for (address in listOf("0.0.0.0", "127.0.0.1", "224.0.0.1", "255.255.255.255",
      "8.8.8.8", "100.64.0.1", "100.127.255.254", "::", "::1", "ff02::1",
      "fd7a:115c:a1e0::1234", "2001:4860:4860::8888", "fe80::1234")) {
      assertFalse(address, LanDiscoveryValidation.isLanHost(host(address)))
      assertNull(map(hosts = listOf(host(address))))
    }
  }

  @Test fun acceptsLanAndPrefersIpv4() {
    for (address in listOf("10.1.2.3", "172.16.2.3", "172.31.2.3", "192.168.2.3",
      "169.254.1.3", "fd12:3456::1")) assertTrue(address, LanDiscoveryValidation.isLanHost(host(address)))
    val ipv4 = host("10.1.2.3")
    val ipv6 = host("fd12:3456::1")
    assertEquals(ipv4.hostAddress, map(hosts = listOf(ipv6, ipv4))!!.address)
    assertEquals(ipv6.hostAddress, map(hosts = listOf(ipv6))!!.address)
    val scoped = Inet6Address.getByAddress(null, host("fe80::1234").address, 3)
    assertTrue(LanDiscoveryValidation.isLanHost(scoped))
    assertEquals(scoped.hostAddress, map(hosts = listOf(scoped))!!.address)
    assertNull(map(hosts = emptyList()))
  }
}

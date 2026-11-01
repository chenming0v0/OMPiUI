package com.ompiui.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.ArrayDeque
import org.json.JSONArray
import org.json.JSONObject

internal data class LanDiscoveredDevice(
  val displayName: String,
  val instanceId: String,
  val port: Int,
  val address: String,
)

/** Pure mapper: advertisements never supply URLs, credentials, or executable text. */
internal object LanDiscoveryValidation {
  private val instancePattern = Regex("[0-9a-f]{32}")
  private val portPattern = Regex("[0-9]{1,5}")

  fun map(attributes: Map<String, ByteArray>, port: Int, hosts: List<InetAddress>): LanDiscoveredDevice? {
    fun text(key: String, maxBytes: Int): String? {
      val bytes = attributes[key] ?: return null
      if (bytes.size > maxBytes) return null
      return try {
        Charsets.UTF_8.newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes)).toString()
      } catch (_: Exception) {
        null
      }
    }
    if (text("marker", 6) != "ompiui" || text("discoveryVersion", 1) != "1" ||
      text("pairing", 4) != "true") return null
    val name = text("displayName", 512) ?: return null
    if (name.isBlank() || name.codePointCount(0, name.length) > 128) return null
    var offset = 0
    while (offset < name.length) {
      val codePoint = name.codePointAt(offset)
      val type = Character.getType(codePoint)
      if (type == Character.CONTROL.toInt() || type == Character.FORMAT.toInt() ||
        type == Character.SURROGATE.toInt() || type == Character.LINE_SEPARATOR.toInt() ||
        type == Character.PARAGRAPH_SEPARATOR.toInt()) return null
      offset += Character.charCount(codePoint)
    }
    val instanceId = text("instanceId", 32) ?: return null
    if (!instancePattern.matches(instanceId)) return null
    val advertisedPort = text("port", 5) ?: return null
    if (!portPattern.matches(advertisedPort) || port !in 1..65535 ||
      advertisedPort.toIntOrNull() != port) return null
    val host = hosts.filter(::isLanHost).sortedBy { if (it is Inet4Address) 0 else 1 }.firstOrNull()
      ?: return null
    return LanDiscoveredDevice(name, instanceId, port, host.hostAddress ?: return null)
  }

  fun isLanHost(host: InetAddress): Boolean {
    if (host.isAnyLocalAddress || host.isLoopbackAddress || host.isMulticastAddress) return false
    val bytes = host.address.map { it.toInt() and 255 }
    if (host is Inet4Address) {
      // RFC1918 / link-local only; excludes public hosts and Tailscale's 100.64.0.0/10.
      return bytes[0] == 10 || (bytes[0] == 172 && bytes[1] in 16..31) ||
        (bytes[0] == 192 && bytes[1] == 168) ||
        (bytes[0] == 169 && bytes[1] == 254 && bytes[2] in 1..254)
    }
    if (host !is Inet6Address) return false
    // Tailnet ULA prefix fd7a:115c:a1e0::/48 is not a LAN endpoint.
    if (bytes.take(6) == listOf(0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0)) return false
    if ((bytes[0] and 0xfe) == 0xfc) return true
    // Link-local IPv6 must retain its interface scope to be connectable.
    return bytes[0] == 0xfe && (bytes[1] and 0xc0) == 0x80 && host.scopeId > 0
  }
}

/** Independent LAN DNS-SD; never starts an agent or the Tailscale backend. */
class DeviceDiscoveryBridge(context: Context, private val webView: WebView) {
  private val context = context.applicationContext
  private val handler = Handler(Looper.getMainLooper())
  private var manager: NsdManager? = null
  private var disposed = false
  private var active: Discovery? = null
  private var registered: Discovery? = null
  // API24 cannot cancel resolveService. Keep this slot until its terminal callback,
  // even across cancellation/new generations, rather than overlapping legacy resolves.
  private var resolving: Resolution? = null

  private class Found(val key: String, val service: NsdServiceInfo)
  private class Discovery(val id: String) {
    lateinit var listener: NsdManager.DiscoveryListener
    lateinit var timeout: Runnable
    val found = LinkedHashMap<String, Found>()
    val queue = ArrayDeque<Found>()
    val results = LinkedHashMap<String, LanDiscoveredDevice>()
    var started = false
    var stopping = false
    var stopAttempts = 0
    var resolveError: String? = null
  }
  private class Resolution(val discovery: Discovery, val found: Found) {
    lateinit var listener: NsdManager.ResolveListener
    var stopping = false
  }

  @JavascriptInterface
  fun request(id: String, method: String, payload: String) {
    handler.post {
      if (disposed) {
        respond(id, error = "discoveryDisposed: Android discovery bridge is closed")
        return@post
      }
      // Follow the native WebView bridge registration model, but only service the
      // bundled Tauri top-level document, never a navigated remote server page.
      if (!trustedDocument()) {
        respond(id, error = "discoveryUntrustedOrigin: LAN discovery requires the bundled UI")
        return@post
      }
      try {
        when (method) {
          "discover" -> {
            if (!webView.hasWindowFocus()) {
              respond(id, error = "discoveryCancelled")
            } else {
              JSONObject(payload.ifBlank { "{}" })
              discover(id)
            }
          }
          "cancel" -> {
            val requestId = JSONObject(payload).get("requestId") as? String
              ?: throw IllegalArgumentException("cancel requires a string requestId")
            active?.takeIf { it.id == requestId }?.let { finish(it, "discoveryCancelled") }
            respond(id) // Idempotent cancel acknowledgement, also for completed IDs.
          }
          else -> respond(id, error = "discoveryUnsupportedMethod: Unknown LAN discovery method")
        }
      } catch (_: SecurityException) {
        respond(id, error = "discoveryPermissionDenied: Android denied local-network discovery")
      } catch (error: Exception) {
        respond(id, error = "discoveryInvalidRequest: ${error.message ?: "Invalid request"}")
      }
    }
  }

  private fun trustedDocument(): Boolean = try {
    val url = URI(webView.url ?: "")
    ((url.scheme == "http" || url.scheme == "https") && url.host == "tauri.localhost") ||
      (url.scheme == "tauri" && url.host == "localhost")
  } catch (_: Exception) {
    false
  }

  private fun discover(id: String) {
    if (Build.VERSION.SDK_INT < 24) {
      respond(id, error = "discoveryUnsupported: LAN discovery requires Android 7 or newer")
      return
    }
    // Target36 needs INTERNET only. ACCESS_LOCAL_NETWORK becomes a runtime
    // permission for target37+; use its name so this still compiles against SDK36.
    val permissionDenied = context.checkSelfPermission(Manifest.permission.INTERNET) != PackageManager.PERMISSION_GRANTED ||
      (Build.VERSION.SDK_INT >= 37 && context.applicationInfo.targetSdkVersion >= 37 &&
        context.checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") != PackageManager.PERMISSION_GRANTED)
    if (permissionDenied) {
      respond(id, error = "discoveryPermissionDenied: Allow Android local-network access")
      return
    }
    if (active != null || registered != null) {
      registered?.takeIf { active == null }?.let(::stopDiscovery)
      respond(id, error = "discoveryBusy: Wait for the previous LAN scan to stop, then retry")
      return
    }
    val nsd = try {
      manager ?: (context.getSystemService(Context.NSD_SERVICE) as? NsdManager)?.also { manager = it }
    } catch (_: SecurityException) {
      respond(id, error = "discoveryPermissionDenied: Android denied NSD access")
      return
    }
    if (nsd == null) {
      respond(id, error = "discoveryUnsupported: Android NSD service is unavailable")
      return
    }
    val discovery = Discovery(id)
    discovery.timeout = Runnable {
      if (active === discovery) {
        finish(discovery, discovery.resolveError.takeIf { discovery.results.isEmpty() })
      }
    }
    discovery.listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(type: String) { handler.post {
        discovery.started = true
        if (active !== discovery || disposed) stopDiscovery(discovery)
      } }
      override fun onServiceFound(service: NsdServiceInfo) { handler.post {
        if (active !== discovery || disposed || !serviceTypeMatches(service.serviceType)) return@post
        val key = serviceKey(service)
        if (discovery.found.containsKey(key) || discovery.found.size >= MAX_SERVICES) return@post
        val found = Found(key, service)
        discovery.found[key] = found
        discovery.queue.addLast(found)
        resolveNext()
      } }
      override fun onServiceLost(service: NsdServiceInfo) { handler.post {
        if (active !== discovery) return@post
        val key = serviceKey(service)
        discovery.found.remove(key)?.let { discovery.queue.remove(it) }
        discovery.results.remove(key)
      } }
      override fun onDiscoveryStopped(type: String) { handler.post {
        if (registered === discovery) registered = null
        if (active === discovery) finish(discovery, "discoveryStopped: Android stopped the LAN scan")
      } }
      override fun onStartDiscoveryFailed(type: String, code: Int) { handler.post {
        // Framework removes failed-start listeners; do not stop an unregistered listener.
        if (registered === discovery) registered = null
        if (active === discovery) finish(discovery, nsdError("start", code))
      } }
      override fun onStopDiscoveryFailed(type: String, code: Int) { handler.post {
        discovery.stopping = false
        if (registered !== discovery) return@post
        if (active === discovery) finish(discovery, nsdError("stop", code))
        if (discovery.stopAttempts < 2) stopDiscovery(discovery)
        // Retain the registration after repeated failure so later discover/dispose
        // can retry cleanup, rather than silently leaking another discovery listener.
      } }
    }
    active = discovery
    registered = discovery
    handler.postDelayed(discovery.timeout, DISCOVERY_MS)
    try {
      nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discovery.listener)
    } catch (_: SecurityException) {
      registered = null
      finish(discovery, "discoveryPermissionDenied: Android denied LAN discovery")
    } catch (error: Exception) {
      registered = null
      finish(discovery, "discoveryStartFailed: ${error.message ?: "Android NSD could not start"}")
    }
  }

  @Suppress("DEPRECATION")
  private fun resolveNext() {
    if (disposed || resolving != null) return
    val discovery = active ?: return
    val found = discovery.queue.pollFirst() ?: return
    val resolution = Resolution(discovery, found)
    resolution.listener = object : NsdManager.ResolveListener {
      override fun onServiceResolved(service: NsdServiceInfo) { handler.post {
        if (resolving !== resolution) return@post
        resolving = null
        if (active === discovery && discovery.found[found.key] === found && !disposed) {
          try {
            val hosts = if (Build.VERSION.SDK_INT >= 34) service.hostAddresses else listOfNotNull(service.host)
            LanDiscoveryValidation.map(service.attributes, service.port, hosts)?.let {
              discovery.results[found.key] = it
            }
          } catch (_: SecurityException) {
            finish(discovery, "discoveryPermissionDenied: Android denied LAN service resolution")
          } catch (_: Exception) {
            // Ignore malformed/unusable advertisements rather than trusting them.
          }
        }
        resolveNext()
      } }
      override fun onResolveFailed(service: NsdServiceInfo, code: Int) { handler.post {
        if (resolving !== resolution) return@post
        resolving = null
        if (active === discovery) discovery.resolveError = nsdError("resolve", code)
        resolveNext()
      } }
      override fun onResolutionStopped(service: NsdServiceInfo) { handler.post {
        if (resolving !== resolution) return@post
        resolving = null
        resolveNext()
      } }
      override fun onStopResolutionFailed(service: NsdServiceInfo, code: Int) { handler.post {
        if (resolving === resolution) resolution.stopping = false
        // Keep the serial slot until resolve's actual terminal callback.
      } }
    }
    resolving = resolution
    try {
      manager!!.resolveService(found.service, resolution.listener)
    } catch (_: SecurityException) {
      resolving = null
      finish(discovery, "discoveryPermissionDenied: Android denied LAN service resolution")
    } catch (error: Exception) {
      resolving = null
      discovery.resolveError = "discoveryResolveFailed: ${error.message ?: "Android NSD resolve failed"}"
      handler.post { resolveNext() }
    }
  }

  private fun finish(discovery: Discovery, error: String? = null) {
    if (active !== discovery) return
    active = null // Invalidate all late found/lost/resolve callbacks before cleanup.
    handler.removeCallbacks(discovery.timeout)
    discovery.queue.clear()
    discovery.found.clear()
    stopDiscovery(discovery)
    stopResolution()
    val unique = LinkedHashMap<String, LanDiscoveredDevice>()
    discovery.results.values.forEach { device ->
      val old = unique[device.instanceId]
      if (old == null || (old.address.contains(':') && !device.address.contains(':'))) {
        unique[device.instanceId] = device
      }
    }
    val result = JSONArray()
    unique.values.take(MAX_SERVICES).forEach { device ->
      result.put(JSONObject().put("marker", "ompiui").put("discoveryVersion", 1)
        .put("displayName", device.displayName).put("instanceId", device.instanceId)
        .put("port", device.port).put("pairing", true).put("address", device.address))
    }
    discovery.results.clear()
    respond(discovery.id, result, error)
  }

  private fun stopDiscovery(discovery: Discovery) {
    if (registered !== discovery || discovery.stopping || !discovery.started) return
    discovery.stopping = true
    discovery.stopAttempts++
    try {
      manager?.stopServiceDiscovery(discovery.listener)
    } catch (_: IllegalArgumentException) {
      // Listener already removed by Android.
      if (registered === discovery) registered = null
    } catch (_: Exception) {
      discovery.stopping = false
    }
  }

  private fun stopResolution() {
    val resolution = resolving ?: return
    if (Build.VERSION.SDK_INT >= 34 && !resolution.stopping) {
      resolution.stopping = true
      try {
        manager?.stopServiceResolution(resolution.listener)
      } catch (_: Exception) {
        resolution.stopping = false
      }
    }
  }

  private fun nsdError(operation: String, code: Int): String {
    val hint = when (code) {
      NsdManager.FAILURE_ALREADY_ACTIVE -> "NSD is already resolving or scanning; retry shortly"
      NsdManager.FAILURE_MAX_LIMIT -> "Android NSD operation limit reached; retry shortly"
      NsdManager.FAILURE_INTERNAL_ERROR -> "Check local-network permissions and network availability"
      else -> "Check Android local-network permissions and NSD availability"
    }
    return "discoveryNsdFailed: $operation failed ($code). $hint"
  }

  private fun respond(id: String, result: JSONArray = JSONArray(), error: String? = null) {
    val response = JSONObject().put("id", id).put("result", result)
    if (error != null) response.put("error", error)
    val json = JSONObject.quote(response.toString()).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    try {
      webView.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('ompiui-discovery-result',{detail:JSON.parse($json)}));", null)
    } catch (_: Exception) {
      // Activity/WebView may already be destroyed during disposal.
    }
  }

  fun cancelDiscoveries() = onMain {
    active?.let { finish(it, "discoveryCancelled") }
    registered?.let(::stopDiscovery)
    stopResolution()
  }

  fun dispose() = onMain {
    if (!disposed) {
      disposed = true
      cancelDiscoveries()
      webView.removeJavascriptInterface("__ompiui_device_discovery")
    }
  }

  private fun onMain(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) action() else handler.post { action() }
  }

  private fun serviceKey(service: NsdServiceInfo) = "${service.serviceName}\u0000${service.serviceType.trimEnd('.').lowercase()}"
  private fun serviceTypeMatches(type: String) = type.trimEnd('.').equals(SERVICE_TYPE.trimEnd('.'), ignoreCase = true)

  private companion object {
    const val SERVICE_TYPE = "_ompiui._tcp."
    const val DISCOVERY_MS = 6_000L
    const val MAX_SERVICES = 64
  }
}

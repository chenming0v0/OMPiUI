package com.ompiui.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.ompiui.tailscale.mobile.Mobile
import java.io.File
import java.util.concurrent.Executors
import org.json.JSONObject
import org.json.JSONArray

class TailscaleBridge(private val context: Context, private val webView: WebView) {
  private val executor = Executors.newSingleThreadExecutor()
  private val discoveryExecutor = Executors.newSingleThreadExecutor()
  private val discoveryRequests = java.util.Collections.synchronizedSet(mutableSetOf<String>())
  private val handler = Handler(Looper.getMainLooper())
  private val preferences = context.getSharedPreferences("ompiui-tailscale", Context.MODE_PRIVATE)
  @Volatile private var disposed = false
  private val diagnostics = TailscaleDiagnostics(context)
  private var diagnosticsPrepared = false
  private val networkMonitor = TailscaleNetworkMonitor(context, ::refreshNetworkState)

  private fun refreshNetworkState() {
    synchronized(executor) {
      if (!disposed) executor.execute {
        try {
          core("network") { networkMonitor.refresh() }
        } catch (error: Exception) {
          Log.w("OMPiUITailscale", "Failed to refresh network state", error)
        }
      }
    }
  }

  private fun start() {
    check(!diagnostics.startupBlocked) {
      "Tailscale automatic recovery is paused. Export login diagnostics or log in manually to retry."
    }
    if (!diagnosticsPrepared) {
      core("prepare-log") { Mobile.prepareDiagnostics(diagnostics.directory.absolutePath) }
      diagnosticsPrepared = true
    }
    networkMonitor.start()
    try {
      core("network") { networkMonitor.refresh() }
      core("start") { Mobile.start(File(context.filesDir, "tailscale").absolutePath, "ompiui-android") }
    } catch (error: Exception) {
      networkMonitor.stop()
      throw error
    }
  }

  private fun status(): JSONObject {
    if (diagnostics.startupBlocked) {
      return JSONObject().put("enabled", false).put("BackendState", "Stopped")
        .put("startupInterrupted", true)
    }
    val enabled = preferences.getBoolean("enabled", false)
    if (enabled) start()
    return JSONObject(core("status") { Mobile.status() }).put("enabled", enabled)
  }

  private fun <T> core(stage: String, action: () -> T): T {
    diagnostics.begin("core.$stage")
    try {
      val result = action()
      diagnostics.finish("core.$stage")
      return result
    } catch (error: Exception) {
      diagnostics.finish("core.$stage", error)
      throw error
    }
  }

  @JavascriptInterface
  fun request(id: String, method: String, payload: String) {
    if (method == "cancelDiscovery") {
      if (disposed) return
      synchronized(discoveryRequests) {
        val requestId = try { JSONObject(payload).getString("requestId") } catch (_: Exception) { return }
        discoveryRequests.remove(requestId)
        Mobile.cancelDiscovery(requestId)
      }
      handler.post { sendResponse(JSONObject().put("id", id).put("result", JSONObject().put("ok", true))) }
      return
    }
    if (method == "discover") {
      if (disposed || !preferences.getBoolean("enabled", false)) {
        handler.post { sendResponse(JSONObject().put("id", id).put("error", "discoveryTailscaleLogin")) }
        return
      }
      synchronized(discoveryRequests) {
        if (discoveryRequests.isNotEmpty()) {
          handler.post { sendResponse(JSONObject().put("id", id).put("error", "discoveryBusy")) }
          return
        }
        discoveryRequests.add(id)
      }
      discoveryExecutor.execute {
        val response = JSONObject().put("id", id)
        try {
          if (!discoveryRequests.contains(id)) return@execute
          response.put("result", JSONArray(Mobile.discover(id)))
        } catch (error: Exception) {
          response.put("error", error.message ?: "discoveryFailed")
        } finally {
          discoveryRequests.remove(id)
        }
        handler.post { if (!disposed) sendResponse(response) }
      }
      return
    }
    if (method in listOf("openLogin", "copyDiagnostics", "exportDiagnostics")) {
      handler.post {
        val response = JSONObject().put("id", id)
        try {
          when (method) {
            "openLogin" -> core("browser") { TailscaleBrowser.open(context, JSONObject(payload).getString("url")) }
            "copyDiagnostics" -> diagnostics.copy()
            "exportDiagnostics" -> diagnostics.share()
          }
          response.put("result", JSONObject().put("ok", true))
        } catch (error: Exception) {
          Log.w("OMPiUITailscale", "Native operation failed: $method", error)
          response.put("error", error.message ?: "Native operation failed")
        }
        sendResponse(response)
      }
      return
    }
    executor.execute {
      val response = JSONObject().put("id", id)
      try {
        val result: Any = when (method) {
          "status" -> status()
          "login" -> {
            diagnostics.resumeStartup()
            start()
            preferences.edit().putBoolean("enabled", true).apply()
            val current = JSONObject(core("status") { Mobile.status() })
            if (current.optString("BackendState") != "Running" && current.optString("AuthURL").isEmpty()) {
              core("login") { Mobile.login() }
            }
            status()
          }
          "disconnect" -> {
            preferences.edit().putBoolean("enabled", false).apply()
            networkMonitor.stop()
            cancelDiscoveries()
            core("stop") { Mobile.stop() }
            JSONObject().put("ok", true)
          }
          "route" -> {
            if (!preferences.getBoolean("enabled", false)) {
              throw IllegalStateException("Sign in to Tailscale on this phone first")
            }
            start()
            core("route") { Mobile.openRoute(JSONObject(payload).getString("origin")) }
          }
          else -> throw IllegalArgumentException("Unknown Tailscale operation")
        }
        response.put("result", result)
      } catch (error: Exception) {
        Log.w("OMPiUITailscale", "Tailscale operation failed: $method", error)
        response.put("error", error.message ?: "Tailscale operation failed")
      }
      handler.post { sendResponse(response) }
    }
  }

  private fun sendResponse(response: JSONObject) {
    val json = JSONObject.quote(response.toString()).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    webView.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('ompiui-tailscale-result',{detail:JSON.parse($json)}));",
      null
    )
  }

  fun cancelDiscoveries() {
    val ids = synchronized(discoveryRequests) { discoveryRequests.toList().also { discoveryRequests.clear() } }
    ids.forEach { Mobile.cancelDiscovery(it) }
  }

  fun dispose() {
    cancelDiscoveries()
    discoveryExecutor.shutdownNow()
    synchronized(executor) {
      disposed = true
      executor.execute {
        networkMonitor.stop()
        core("stop") { Mobile.stop() }
      }
      executor.shutdown()
    }
  }
}

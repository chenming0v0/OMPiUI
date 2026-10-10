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

class TailscaleBridge(private val context: Context, private val webView: WebView) {
  private val executor = Executors.newSingleThreadExecutor()
  private val handler = Handler(Looper.getMainLooper())
  private val preferences = context.getSharedPreferences("ompiui-tailscale", Context.MODE_PRIVATE)
  private var disposed = false
  private val networkMonitor = TailscaleNetworkMonitor(context, ::refreshNetworkState)

  private fun refreshNetworkState() {
    synchronized(executor) {
      if (!disposed) executor.execute {
        try {
          networkMonitor.refresh()
        } catch (error: Exception) {
          Log.w("OMPiUITailscale", "Failed to refresh network state", error)
        }
      }
    }
  }

  private fun start() {
    networkMonitor.start()
    try {
      networkMonitor.refresh()
      Mobile.start(File(context.filesDir, "tailscale").absolutePath, "ompiui-android")
    } catch (error: Exception) {
      networkMonitor.stop()
      throw error
    }
  }

  private fun status(): JSONObject {
    val enabled = preferences.getBoolean("enabled", false)
    if (enabled) start()
    return JSONObject(Mobile.status()).put("enabled", enabled)
  }

  @JavascriptInterface
  fun request(id: String, method: String, payload: String) {
    if (method == "openLogin") {
      handler.post {
        val response = JSONObject().put("id", id)
        try {
          TailscaleBrowser.open(context, JSONObject(payload).getString("url"))
          response.put("result", JSONObject().put("ok", true))
        } catch (error: Exception) {
          Log.w("OMPiUITailscale", "Failed to open authorization browser", error)
          response.put("error", error.message ?: "Failed to open authorization browser")
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
            start()
            preferences.edit().putBoolean("enabled", true).apply()
            val current = JSONObject(Mobile.status())
            if (current.optString("BackendState") != "Running" && current.optString("AuthURL").isEmpty()) {
              Mobile.login()
            }
            status()
          }
          "disconnect" -> {
            preferences.edit().putBoolean("enabled", false).apply()
            networkMonitor.stop()
            Mobile.stop()
            JSONObject().put("ok", true)
          }
          "route" -> {
            if (!preferences.getBoolean("enabled", false)) {
              throw IllegalStateException("Sign in to Tailscale on this phone first")
            }
            start()
            Mobile.openRoute(JSONObject(payload).getString("origin"))
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
    webView.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('ompiui-tailscale-result',{detail:$response}));",
      null
    )
  }

  fun dispose() {
    synchronized(executor) {
      disposed = true
      executor.execute {
        networkMonitor.stop()
        Mobile.stop()
      }
      executor.shutdown()
    }
  }
}

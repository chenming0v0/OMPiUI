package com.ompiui.app

import android.content.Context
import android.os.Handler
import android.os.Looper
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

  private fun start() {
    Mobile.start(File(context.filesDir, "tailscale").absolutePath, "ompiui-android")
  }

  private fun status(): JSONObject {
    val enabled = preferences.getBoolean("enabled", false)
    if (enabled) start()
    return JSONObject(Mobile.status()).put("enabled", enabled)
  }

  @JavascriptInterface
  fun request(id: String, method: String, payload: String) {
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
        response.put("error", error.message ?: "Tailscale operation failed")
      }
      val json = response.toString()
      handler.post {
        webView.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('ompiui-tailscale-result',{detail:$json}));",
          null
        )
      }
    }
  }

  fun dispose() {
    executor.execute { Mobile.stop() }
    executor.shutdown()
  }
}

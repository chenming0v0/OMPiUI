package com.ompiui.app

import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.ComponentActivity
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject

class QrScannerBridge(
  private val activity: ComponentActivity,
  private val webView: () -> WebView?
) {
  private var pendingId: String? = null
  private val launcher = activity.registerForActivityResult(ScanContract()) { result ->
    val id = pendingId
    pendingId = null
    if (id != null) {
      val response = JSONObject().put("id", id)
      when {
        result.contents != null -> response.put("contents", result.contents)
        result.originalIntent?.getBooleanExtra(Intents.Scan.MISSING_CAMERA_PERMISSION, false) == true ->
          response.put("error", "scanPermissionDenied")
      }
      sendResponse(response)
    }
  }

  @JavascriptInterface
  fun scan(id: String, prompt: String) {
    activity.runOnUiThread {
      if (pendingId != null) {
        sendResponse(JSONObject().put("id", id).put("error", "scanFailed"))
        return@runOnUiThread
      }
      pendingId = id
      try {
        launcher.launch(ScanOptions()
          .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
          .setPrompt(prompt)
          .setBeepEnabled(false)
          .addExtra(Intents.Scan.SHOW_MISSING_CAMERA_PERMISSION_DIALOG, false)
          .setOrientationLocked(false))
      } catch (_: Exception) {
        pendingId = null
        sendResponse(JSONObject().put("id", id).put("error", "scanFailed"))
      }
    }
  }

  private fun sendResponse(response: JSONObject) {
    val json = JSONObject.quote(response.toString())
    webView()?.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('ompiui-qr-result', {detail: JSON.parse($json)}));",
      null
    )
  }
}

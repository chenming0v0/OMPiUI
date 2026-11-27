package com.ompiui.app

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

/**
 * 在 App 自己的界面里打开 DS 远程的电脑页面。
 *
 * 跳到系统浏览器时 App 会退到后台，撑着远程连接的那条控制连接就可能被系统暂停。
 * 页面开在同一个 Activity 里，App 一直在前台，连接不会断。
 * 远程页面用的是独立的 WebView，拿不到 App 的任何原生接口。
 */
class DshRemoteViewerBridge(
  private val activity: ComponentActivity,
  private val appWebView: () -> WebView?
) {
  private class Session(
    val id: String,
    val overlay: View,
    val web: WebView,
    val back: OnBackPressedCallback
  ) {
    var delivered = false
  }

  private val main = Handler(Looper.getMainLooper())
  private var session: Session? = null
  private var filePicker: ValueCallback<Array<Uri?>?>? = null
  private val fileLauncher = activity.registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
    filePicker?.onReceiveValue(uris.toTypedArray<Uri?>())
    filePicker = null
  }

  @JavascriptInterface
  fun open(id: String, request: String) {
    main.post {
      session?.let { dismiss(it) }
      val input = try { JSONObject(request) } catch (_: Exception) { null }
      val url = input?.optString("url").orEmpty()
      val grant = input?.optString("browserGrant").orEmpty()
      val expiresAt = input?.optLong("expiresAt") ?: 0L
      if (!ROOT.matches(url) || !GRANT.matches(grant)) {
        emit(id, "closed", "unavailable")
        return@post
      }
      if (expiresAt <= System.currentTimeMillis()) {
        emit(id, "closed", "grant-expired")
        return@post
      }
      try {
        show(id, url, grant, input?.optString("title").orEmpty(), input?.optString("closeLabel").orEmpty())
      } catch (_: Exception) {
        session?.let { dismiss(it) }
        emit(id, "closed", "unavailable")
      }
    }
  }

  @JavascriptInterface
  fun close(id: String) {
    main.post { session?.takeIf { it.id == id }?.let { dismiss(it) } }
  }

  fun dispose() {
    session?.let { dismiss(it) }
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun show(id: String, rootUrl: String, grant: String, title: String, closeLabel: String) {
    val content = activity.findViewById<ViewGroup>(android.R.id.content)
    val host = Uri.parse(rootUrl).host
    val background = (activity.window.decorView.background as? ColorDrawable)?.color ?: Color.WHITE
    val light = 0.299 * Color.red(background) + 0.587 * Color.green(background) + 0.114 * Color.blue(background) > 153
    val foreground = if (light) Color.BLACK else Color.WHITE
    val density = activity.resources.displayMetrics.density
    val dp = { value: Int -> (value * density).toInt() }

    val web = WebView(activity)
    val back = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val current = session ?: return
        if (current.delivered && current.web.canGoBack()) current.web.goBack() else end(id, "closed")
      }
    }
    val bar = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    bar.addView(TextView(activity).apply {
      text = "✕"
      textSize = 18f
      gravity = Gravity.CENTER
      setTextColor(foreground)
      contentDescription = closeLabel
      setOnClickListener { end(id, "closed") }
    }, LinearLayout.LayoutParams(dp(48), dp(44)))
    bar.addView(TextView(activity).apply {
      text = title
      textSize = 15f
      maxLines = 1
      ellipsize = TextUtils.TruncateAt.END
      setTextColor(foreground)
    }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

    val overlay = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(background)
      // 盖在 App 界面上面时，点击不能漏到下面去。
      isClickable = true
      isFocusable = true
    }
    overlay.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    overlay.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    // 内容区的左右和底部已经由 MainActivity 让开了，这里只需要让开顶部的状态栏。
    fun applyTopInset() {
      val top = ViewCompat.getRootWindowInsets(content)
        ?.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())?.top ?: 0
      if (bar.paddingTop != top || bar.paddingLeft == 0) bar.setPadding(dp(4), top, dp(12), 0)
    }
    applyTopInset()
    overlay.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> applyTopInset() }

    val current = Session(id, overlay, web, back)
    web.setBackgroundColor(background)
    web.settings.javaScriptEnabled = true
    web.settings.domStorageEnabled = true
    web.settings.setSupportMultipleWindows(false)
    web.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val target = request.url
        // 顶层页面只能停在这次远程的地址上；别的链接交给系统浏览器。
        if (target.scheme == "https" && target.host == host && target.port == -1) return false
        if (request.isForMainFrame && request.hasGesture() && (target.scheme == "https" || target.scheme == "http")) {
          try { activity.startActivity(Intent(Intent.ACTION_VIEW, target)) } catch (_: Exception) { }
        }
        return true
      }

      // 换票成功后会跳到远程地址的首页；首页一开始显示就算打开了，不必等它全部加载完。
      private fun arrived(view: WebView, url: String?) {
        if (current.delivered || session !== current) return
        val page = url?.let { Uri.parse(it) } ?: return
        if (page.scheme != "https" || page.host != host || page.path?.startsWith("/__remote/") == true) return
        current.delivered = true
        // 换票用的那一页不留在后退记录里。
        view.clearHistory()
        emit(id, "delivered", null)
      }

      override fun onPageCommitVisible(view: WebView, url: String?) = arrived(view, url)

      override fun onPageFinished(view: WebView, url: String?) = arrived(view, url)

      override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame && !current.delivered) main.post { end(id, "unavailable") }
      }

      override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
        if (request.isForMainFrame && !current.delivered) main.post { end(id, "unavailable") }
      }

      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        main.post { end(id, "unavailable") }
        return true
      }
    }
    web.webChromeClient = object : WebChromeClient() {
      override fun onShowFileChooser(
        view: WebView,
        callback: ValueCallback<Array<Uri?>?>,
        params: FileChooserParams
      ): Boolean {
        filePicker?.onReceiveValue(null)
        filePicker = callback
        return try {
          fileLauncher.launch(params.acceptTypes.firstOrNull { it.contains('/') } ?: "*/*")
          true
        } catch (_: Exception) {
          filePicker = null
          false
        }
      }
    }

    session = current
    content.addView(overlay, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    activity.onBackPressedDispatcher.addCallback(back)
    web.requestFocus()
    // 一次性授权由远程地址自己的页面用表单提交：原生 POST 带不上正确的来源，会被拒绝。
    // 授权只在这一页里出现一次，不进地址栏，也不落盘。
    web.loadDataWithBaseURL(
      "${rootUrl}__remote/session-bootstrap",
      "<!doctype html><meta name=\"referrer\" content=\"same-origin\">" +
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; form-action 'self'\">" +
        "<form method=\"post\" action=\"/__remote/session\"><input type=\"hidden\" name=\"browserGrant\" value=\"$grant\"></form>" +
        "<script>document.forms[0].submit()</script>",
      "text/html",
      "utf-8",
      null
    )
    // 一次性授权很快过期：到时候还没进到远程页面，就当这次没打开。
    main.postDelayed({ if (session === current && !current.delivered) end(id, "grant-expired") }, OPEN_TIMEOUT_MS)
  }

  /** 页面这边结束（用户关掉、打不开）：收起界面并告诉 App 去释放远程连接。 */
  private fun end(id: String, reason: String) {
    val current = session?.takeIf { it.id == id } ?: return
    dismiss(current)
    emit(id, "closed", reason)
  }

  private fun dismiss(current: Session) {
    if (session === current) session = null
    current.back.remove()
    filePicker?.onReceiveValue(null)
    filePicker = null
    (current.overlay.parent as? ViewGroup)?.removeView(current.overlay)
    current.web.stopLoading()
    current.web.destroy()
  }

  private fun emit(id: String, type: String, reason: String?) {
    val detail = JSONObject().put("id", id).put("type", type)
    if (reason != null) detail.put("reason", reason)
    val json = JSONObject.quote(detail.toString())
    appWebView()?.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('ompiui-dsh-viewer', {detail: JSON.parse($json)}));",
      null
    )
  }

  private companion object {
    val ROOT = Regex("^https://[a-z0-9]{12}\\.(?:hostc|tun|hostc-test|tun-test)\\.4ba\\.io/$")
    val GRANT = Regex("^[A-Za-z0-9_-]{43}$")
    const val OPEN_TIMEOUT_MS = 60_000L
  }
}

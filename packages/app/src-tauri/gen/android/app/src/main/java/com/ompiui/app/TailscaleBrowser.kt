package com.ompiui.app

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

internal object TailscaleBrowser {
  fun open(context: Context, url: String) {
    val uri = Uri.parse(url)
    require(uri.scheme == "https" && uri.host == "login.tailscale.com" && uri.userInfo == null) {
      "Invalid Tailscale authorization URL"
    }
    val browser = Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
    // 由系统提供浏览器选择，不将授权页面加载到应用自身的 WebView。
    val chooser = Intent.createChooser(browser, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(chooser)
    } catch (error: ActivityNotFoundException) {
      throw IllegalStateException("No browser is available to open Tailscale authorization", error)
    }
  }
}

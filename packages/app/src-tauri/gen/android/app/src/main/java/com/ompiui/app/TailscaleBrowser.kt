package com.ompiui.app

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent

internal object TailscaleBrowser {
  fun open(context: Context, url: String) {
    val uri = Uri.parse(url)
    // 授权链接可能来自自建控制服务器（Headscale 等），只要求 https 且不含用户信息。
    require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null) {
      "Invalid Tailscale authorization URL"
    }
    // 复用默认浏览器的账号与 Cookie，授权页面留在当前应用的任务栈中。
    val browser = CustomTabsIntent.Builder()
      .setShowTitle(true)
      .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
      .build()
    CustomTabsClient.getPackageName(context, null)?.let { browser.intent.setPackage(it) }
    try {
      browser.launchUrl(context, uri)
    } catch (error: ActivityNotFoundException) {
      try {
        context.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
      } catch (fallback: ActivityNotFoundException) {
        throw IllegalStateException("No browser is available to open Tailscale authorization", fallback)
      }
    }
  }
}

package com.ompiui.app

internal enum class TailscaleExit { NORMAL, NATIVE_CRASH, CRASH, UNKNOWN }

internal object TailscaleRecoveryPolicy {
  fun pause(pending: Boolean, stage: String, exit: TailscaleExit): Boolean {
    val nativeStage = stage.startsWith("core.") && stage != "core.browser"
    return when (exit) {
      TailscaleExit.NORMAL -> false
      TailscaleExit.NATIVE_CRASH -> nativeStage
      TailscaleExit.CRASH -> pending && nativeStage
      // 旧系统没有退出原因，只对中断的初始化保留防崩溃循环保护。
      TailscaleExit.UNKNOWN -> pending && stage in setOf("core.start", "core.prepare-log")
    }
  }
}

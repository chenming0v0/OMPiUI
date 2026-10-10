package com.ompiui.app

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import androidx.core.content.FileProvider
import java.io.File
import java.io.RandomAccessFile
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.json.JSONArray
import org.json.JSONObject

internal class TailscaleDiagnostics(private val context: Context) {
  companion object {
    private var exceptionHandlerInstalled = false
  }

  private val preferences = context.getSharedPreferences("ompiui-tailscale-diagnostics", Context.MODE_PRIVATE)
  private val activityManager = context.getSystemService(ActivityManager::class.java)
  val directory = File(context.filesDir, "tailscale-diagnostics")
  var startupBlocked = preferences.getBoolean("blocked", false)
    private set

  init {
    if (preferences.getInt("pid", 0) != Process.myPid()) {
      val previousStart = preferences.getLong("startedAt", 0L)
      val previousCrash = if (Build.VERSION.SDK_INT >= 30) {
        exitRecords().firstOrNull()?.let {
          it.timestamp >= previousStart && (it.reason == ApplicationExitInfo.REASON_CRASH ||
            it.reason == ApplicationExitInfo.REASON_CRASH_NATIVE ||
            // Go 后台 panic 通常直接 exit(2)，系统不一定将它分类为 native crash。
            (it.reason == ApplicationExitInfo.REASON_EXIT_SELF && it.status != 0) ||
            (it.reason == ApplicationExitInfo.REASON_SIGNALED && it.status in listOf(6, 11)))
        } ?: false
      } else false
      startupBlocked = startupBlocked || preferences.getBoolean("pending", false) || previousCrash
      preferences.edit().putInt("pid", Process.myPid())
        .putLong("startedAt", System.currentTimeMillis()).putBoolean("blocked", startupBlocked).commit()
      record("app.reopened", if (startupBlocked) "previous attempt interrupted" else "ready")
    }
    synchronized(TailscaleDiagnostics::class.java) {
      val previous = Thread.getDefaultUncaughtExceptionHandler()
      if (!exceptionHandlerInstalled && previous != null) {
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
          try {
            record("java.uncaught", sanitize(error.stackTraceToString()).take(16 * 1024))
          } finally {
            previous.uncaughtException(thread, error)
          }
        }
        exceptionHandlerInstalled = true
      }
    }
  }

  fun resumeStartup() {
    startupBlocked = false
    preferences.edit().putBoolean("blocked", false).commit()
  }

  @Synchronized
  fun begin(stage: String) {
    preferences.edit().putBoolean("pending", true).putString("lastStage", stage).commit()
    record(stage, "begin")
    if (Build.VERSION.SDK_INT >= 30) {
      // 系统可能限制摘要更新频率，不能让可选诊断阻断正常登录。
      try {
        activityManager.setProcessStateSummary(stage.toByteArray(Charsets.UTF_8))
      } catch (_: RuntimeException) {
        // 步骤已同步写入应用私有存储。
      }
    }
  }

  @Synchronized
  fun finish(stage: String, error: Exception? = null) {
    preferences.edit().putBoolean("pending", false).commit()
    record(stage, error?.let { sanitize(it.stackTraceToString()) } ?: "ok")
  }

  @Synchronized
  private fun record(stage: String, result: String) {
    val events = JSONArray(preferences.getString("events", "[]"))
    events.put(JSONObject().put("time", System.currentTimeMillis()).put("stage", stage).put("result", result))
    val bounded = JSONArray()
    for (index in maxOf(0, events.length() - 60) until events.length()) {
      bounded.put(events.get(index))
    }
    preferences.edit().putString("events", bounded.toString()).commit()
  }

  private fun exitRecords(): List<ApplicationExitInfo> {
    if (Build.VERSION.SDK_INT < 30) return emptyList()
    return try {
      activityManager.getHistoricalProcessExitReasons(context.packageName, 0, 3)
    } catch (_: Exception) {
      emptyList()
    }
  }

  fun report(): String {
    val exits = JSONArray()
    for (exit in exitRecords()) {
      exits.put(JSONObject().put("time", exit.timestamp).put("reason", exit.reason)
        .put("status", exit.status).put("description", sanitize(exit.description.orEmpty()))
        .put("lastStage", exit.processStateSummary?.toString(Charsets.UTF_8).orEmpty()))
    }
    return JSONObject()
      .put("version", BuildConfig.VERSION_NAME)
      .put("androidApi", Build.VERSION.SDK_INT)
      .put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
      .put("automaticRestorePaused", startupBlocked)
      .put("operationPending", preferences.getBoolean("pending", false))
      .put("lastStage", preferences.getString("lastStage", "not started"))
      .put("events", JSONArray(preferences.getString("events", "[]")))
      .put("exits", exits)
      .put("nativeLog", logTail(File(directory, "native-stderr.log")))
      .put("previousNativeLog", logTail(File(directory, "native-stderr.log.previous")))
      .toString(2)
  }

  fun copy() {
    context.getSystemService(ClipboardManager::class.java)
      .setPrimaryClip(ClipData.newPlainText("OMPiUI login diagnostics", report()))
  }

  fun share() {
    val output = File(context.cacheDir, "ompiui-login-diagnostics.zip")
    ZipOutputStream(output.outputStream()).use { archive ->
      archive.putNextEntry(ZipEntry("report.json"))
      archive.write(report().toByteArray(Charsets.UTF_8))
      archive.closeEntry()
      // Android 可能提供原生退出转储；作为附件保存，不能当作普通文本解码。
      for ((index, exit) in exitRecords().withIndex()) {
        val trace = try { exit.traceInputStream } catch (_: Exception) { null }
        trace?.use {
          archive.putNextEntry(ZipEntry("exit-$index.trace"))
          it.copyTo(archive)
          archive.closeEntry()
        }
      }
    }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", output)
    val send = Intent(Intent.ACTION_SEND).setType("application/zip")
      .putExtra(Intent.EXTRA_STREAM, uri)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  private fun logTail(file: File): String {
    if (!file.exists()) return ""
    return RandomAccessFile(file, "r").use {
      val size = minOf(it.length(), 128 * 1024L).toInt()
      it.seek(it.length() - size)
      val bytes = ByteArray(size)
      it.readFully(bytes)
      sanitize(bytes.toString(Charsets.UTF_8))
    }
  }

  private fun sanitize(text: String): String =
    text.replace(Regex("https?://[^\\s\"<>]+"), "[url removed]")
}

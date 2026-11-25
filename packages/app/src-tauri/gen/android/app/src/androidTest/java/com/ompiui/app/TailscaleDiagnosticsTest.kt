package com.ompiui.app

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TailscaleDiagnosticsTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext
  private val preferences = context.getSharedPreferences("ompiui-tailscale-diagnostics", Context.MODE_PRIVATE)

  @Before
  fun reset() {
    preferences.edit().clear().commit()
  }

  @After
  fun cleanup() {
    preferences.edit().clear().commit()
  }

  @Test
  fun quietStatusPreservesSynchronousRecoveryMarkersWithoutRepeatingEvents() {
    val diagnostics = TailscaleDiagnostics(context)
    val events = preferences.getString("events", "[]")
    diagnostics.begin("core.status", recordEvents = false)
    assertTrue(preferences.getBoolean("pending", false))
    assertEquals("core.status", preferences.getString("lastStage", ""))
    assertEquals(events, preferences.getString("events", "[]"))

    diagnostics.finish("core.status", recordEvents = false)
    assertFalse(preferences.getBoolean("pending", true))
    assertEquals(events, preferences.getString("events", "[]"))
  }

  @Test
  fun interruptedQuietStatusWithoutCrashEvidenceAllowsAutomaticRecovery() {
    val diagnostics = TailscaleDiagnostics(context)
    diagnostics.begin("core.status", recordEvents = false)
    // 模拟状态轮询期间被回收，排除测试设备上更早的退出记录。
    preferences.edit().putInt("pid", 0).putLong("startedAt", Long.MAX_VALUE).commit()
    val reopened = TailscaleDiagnostics(context)
    assertFalse(reopened.startupBlocked)
    assertFalse(preferences.getBoolean("blocked", true))
    assertEquals("core.status", preferences.getString("lastStage", ""))
  }

  @Test
  fun quietStatusStillRecordsFailuresAndClearsThePendingMarker() {
    val diagnostics = TailscaleDiagnostics(context)
    diagnostics.begin("core.status", recordEvents = false)
    diagnostics.finish("core.status", IllegalStateException("status failed"), recordEvents = false)
    assertFalse(preferences.getBoolean("pending", true))
    val events = preferences.getString("events", "[]").orEmpty()
    assertTrue(events.contains("core.status"))
    assertTrue(events.contains("status failed"))
  }
}

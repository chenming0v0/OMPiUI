package com.ompiui.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TailscaleRecoveryPolicyTest {
  @Test
  fun normalProcessReclamationDoesNotRequireSigningInAgain() {
    for (stage in listOf("core.start", "core.status", "core.network", "core.browser")) {
      assertFalse(TailscaleRecoveryPolicy.pause(true, stage, TailscaleExit.NORMAL))
    }
  }

  @Test
  fun missingExitRecordsDoNotTurnInterruptedPollingIntoAStartupFailure() {
    assertFalse(TailscaleRecoveryPolicy.pause(true, "core.status", TailscaleExit.UNKNOWN))
    assertFalse(TailscaleRecoveryPolicy.pause(true, "core.network", TailscaleExit.UNKNOWN))
    assertTrue(TailscaleRecoveryPolicy.pause(true, "core.start", TailscaleExit.UNKNOWN))
  }

  @Test
  fun nativeCrashLoopsRemainPausedEvenAfterTheLastCallReturned() {
    assertTrue(TailscaleRecoveryPolicy.pause(false, "core.status", TailscaleExit.NATIVE_CRASH))
    assertTrue(TailscaleRecoveryPolicy.pause(true, "core.start", TailscaleExit.CRASH))
    assertFalse(TailscaleRecoveryPolicy.pause(false, "core.status", TailscaleExit.CRASH))
    assertFalse(TailscaleRecoveryPolicy.pause(true, "core.browser", TailscaleExit.CRASH))
  }
}

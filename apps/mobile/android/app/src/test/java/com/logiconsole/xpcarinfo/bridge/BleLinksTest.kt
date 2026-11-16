package com.logiconsole.xpcarinfo.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BleLinksTest {
    @Test
    fun rejectsSecondLinkToTheSameAddress() {
        assertFalse(BleLinks.admit(listOf("AA:BB:CC:DD:EE:01"), "AA:BB:CC:DD:EE:01"))
        assertFalse(BleLinks.admit(listOf("AA:BB:CC:DD:EE:01"), "AA:BB:CC:DD:EE:01"))
    }

    @Test
    fun admitsTheChargingPileWhileTheVehicleLinkIsHeld() {
        assertTrue(BleLinks.admit(listOf("AA:BB:CC:DD:EE:01"), "AA:BB:CC:DD:EE:02"))
    }

    @Test
    fun admitsTheFirstLink() {
        assertTrue(BleLinks.admit(emptyList(), "AA:BB:CC:DD:EE:01"))
    }
}

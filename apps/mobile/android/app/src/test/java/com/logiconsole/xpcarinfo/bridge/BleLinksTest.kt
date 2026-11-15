package com.logiconsole.xpcarinfo.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BleLinksTest {
    @Test
    fun rejectsSecondLinkToTheSameAddress() {
        assertFalse(BleLinks.admit(listOf("00:60:37:85:B9:D0"), "00:60:37:85:B9:D0"))
        assertFalse(BleLinks.admit(listOf("00:60:37:85:B9:D0"), "00:60:37:85:b9:d0"))
    }

    @Test
    fun admitsTheChargingPileWhileTheVehicleLinkIsHeld() {
        assertTrue(BleLinks.admit(listOf("00:60:37:85:B9:D0"), "94:70:6C:44:E3:3F"))
    }

    @Test
    fun admitsTheFirstLink() {
        assertTrue(BleLinks.admit(emptyList(), "00:60:37:85:B9:D0"))
    }
}

package com.logiconsole.xpcarinfo.bridge

import androidx.test.runner.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.PromiseImpl
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.JavaScriptModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.LinkedBlockingQueue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class BleBridgeTest {
    @Test
    fun connectCccdQueuesWritesAndRejectsWriteAfterDisconnect() {
        val dataEvents = LinkedBlockingQueue<ReadableMap>()
        val disconnectEvents = LinkedBlockingQueue<ReadableMap>()
        // This captures native emitter calls; it does not run or validate a real JS bridge.
        val emitter = DeviceEventManagerModule.RCTDeviceEventEmitter { name, data ->
            when (name) {
                "xpeng-ble-data" -> dataEvents.add(data as ReadableMap)
                "xpeng-ble-disconnect" -> disconnectEvents.add(data as ReadableMap)
                else -> throw AssertionError("Unexpected native event: $name")
            }
        }
        val context = object : BridgeReactContext(InstrumentationRegistry.getInstrumentation().targetContext) {
            override fun hasActiveReactInstance() = true

            override fun <T : JavaScriptModule> getJSModule(jsInterface: Class<T>): T {
                check(jsInterface == DeviceEventManagerModule.RCTDeviceEventEmitter::class.java) {
                    "Unexpected JS module request: ${jsInterface.name}"
                }
                return jsInterface.cast(emitter)!!
            }
        }
        val module = XpengBleModule(context)
        val mac = InstrumentationRegistry.getArguments().getString("mac") ?: run {
            val scan = PromiseResult()
            module.scan(3000.0, scan.promise)
            scan.assertResolved("scan fake vehicle")
            val devices = scan.value as ReadableArray
            assertEquals("Expected exactly one fake ED28 vehicle in the emulator", 1, devices.size())
            devices.getMap(0)!!.getString("mac")!!
        }
        val completions = Collections.synchronizedList(mutableListOf<String>())
        var disconnected = false

        try {
            val connection = PromiseResult()
            module.connect(mac, connection.promise)
            // The real module resolves connect only after the GATT CCCD write succeeds.
            connection.assertResolved("connect/CCCD")

            val firstWrite = PromiseResult { completions.add("first") }
            val secondWrite = PromiseResult { completions.add("second") }
            // Placeholder frames exercise GATT at nonce/command lengths, not protocol or keys.
            val firstFrame = "ef0104" + "01020304"
            val secondFrame = "ed118b" + "00".repeat(139)
            assertEquals(7, firstFrame.length / 2)
            assertEquals(142, secondFrame.length / 2)
            module.write(firstFrame, firstWrite.promise)
            module.write(secondFrame, secondWrite.promise)
            firstWrite.assertResolved("first queued GATT write")
            secondWrite.assertResolved("second queued GATT write")
            assertEquals(listOf("first", "second"), completions.toList())
            val notification = dataEvents.poll(15, TimeUnit.SECONDS)
            assertTrue("Native notification event timed out", notification != null)
            assertEquals(mac, notification!!.getString("mac"))
            val reply = notification.getString("hex")!!
            assertTrue("Expected four raw nonce reply bytes", reply.matches(Regex("[0-9a-f]{8}")))

            val disconnect = PromiseResult()
            module.disconnect(disconnect.promise)
            disconnect.assertResolved("disconnect")
            disconnected = true
            val disconnectEvent = disconnectEvents.poll(15, TimeUnit.SECONDS)
            assertTrue("Native disconnect event timed out", disconnectEvent != null)
            assertEquals(mac, disconnectEvent!!.getString("mac"))
            assertEquals("Disconnected by client", disconnectEvent.getString("reason"))

            val afterDisconnect = PromiseResult()
            module.write("090a0b0c", afterDisconnect.promise)
            afterDisconnect.assertRejected("write after disconnect", "E_NOT_READY")
        } finally {
            if (!disconnected) {
                val cleanup = PromiseResult()
                module.disconnect(cleanup.promise)
                cleanup.assertResolved("cleanup disconnect")
            }
        }
    }

    private class PromiseResult(onResolve: () -> Unit = {}) {
        private val completed = CountDownLatch(1)
        private var resolved = false
        private var rejection: ReadableMap? = null
        var value: Any? = null
            private set
        val promise = PromiseImpl(
            Callback { args ->
                value = args.firstOrNull()
                resolved = true
                onResolve()
                completed.countDown()
            },
            Callback { args ->
                rejection = args.firstOrNull() as? ReadableMap
                completed.countDown()
            },
        )

        fun assertResolved(operation: String) {
            await(operation)
            assertTrue("$operation rejected: $rejection", resolved)
        }

        fun assertRejected(operation: String, code: String) {
            await(operation)
            assertTrue("$operation unexpectedly resolved", !resolved)
            assertEquals("$operation rejection code", code, rejection?.getString("code"))
        }

        private fun await(operation: String) {
            assertTrue("$operation Promise callback timed out", completed.await(15, TimeUnit.SECONDS))
        }
    }
}

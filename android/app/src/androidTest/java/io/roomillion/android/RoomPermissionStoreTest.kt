package io.roomillion.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class RoomPermissionStoreTest {
    @Test fun grantsAreLimitedToDeclaredCapabilitiesAndExpireWhenManifestChanges() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "permission-test-${System.nanoTime()}")
        val room = InstrumentationRegistry.getInstrumentation().context.assets.open("inventory.room").use {
            RoomPackageStore(root).install(it)
        }
        val permissions = RoomPermissionStore(context)
        permissions.revoke(room)
        assertNull(permissions.read(room))
        val declared = permissions.requested(room)
        assertTrue(declared.pick && declared.export && declared.ai)
        permissions.save(room, RoomGrants(ai = true))
        assertTrue(permissions.read(room)!!.ai)
        assertFalse(permissions.read(room)!!.pick)
        File(room.program, "manifest.json").appendText(" ")
        assertNull(permissions.read(room))
        permissions.revoke(room)
        root.deleteRecursively()
    }
}

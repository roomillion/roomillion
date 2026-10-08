package io.roomillion.android

import java.io.ByteArrayOutputStream
import java.io.InputStream

/** Bounded InputStream read that also works on Android 12's Java runtime. */
internal fun InputStream.readUpTo(limit: Int): ByteArray {
    require(limit >= 0) { "读取长度无效" }
    val output = ByteArrayOutputStream(minOf(limit, 8192))
    val buffer = ByteArray(minOf(limit, 8192))
    while (output.size() < limit) {
        val count = read(buffer, 0, minOf(buffer.size, limit - output.size()))
        if (count < 0) break
        if (count == 0) {
            val one = read()
            if (one < 0) break
            output.write(one)
        } else output.write(buffer, 0, count)
    }
    return output.toByteArray()
}

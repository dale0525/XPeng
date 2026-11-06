package com.logiconsole.xpcarinfo.bridge

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

/**
 * `session.v1` 的磁盘信封：AES-256-GCM 密钥存在 AndroidKeyStore，密文 + IV 编码成单个字符串。
 *
 * 只包这一个 value：`device.id` 与 token 绑定，密钥失效时只能删会话、不能动设备号。
 * 不启用用户认证：无屏锁设备也要能续期，且避免锁屏凭据变更导致密钥作废。
 */
object SessionEnvelope {
    private const val MAGIC = "enc:v1:"
    private const val ALIAS = "xpeng.session.v1"
    private const val TAG_BITS = 128

    private fun secretKey(): java.security.Key {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!ks.containsAlias(ALIAS)) {
            val spec = KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(spec)
                generateKey()
            }
        }
        return ks.getKey(ALIAS, null)
    }

    fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val iv = cipher.iv
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return MAGIC + Base64.encodeToString(iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(ct, Base64.NO_WRAP)
    }

    fun isEnvelope(value: String): Boolean = value.startsWith(MAGIC)

    /** 只接受信封；解不开由调用方清会话。 */
    fun decrypt(value: String): String {
        val parts = value.removePrefix(MAGIC).split(':')
        require(parts.size == 2) { "信封格式错误" }
        val iv = Base64.decode(parts[0], Base64.NO_WRAP)
        val ct = Base64.decode(parts[1], Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
        return String(cipher.doFinal(ct), Charsets.UTF_8)
    }
}

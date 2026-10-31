#!/usr/bin/env python3
"""从模拟器本地存储还原 eyJ 令牌，无需 App 运行、无需重新登录。

原理（2026-10-29 实测）：
  1. App 把 accessToken/refreshToken 用 AES-CBC 加密后存进
     /data/data/com.xiaopeng.mycarinfo/files/mmkv/tee
  2. AES 密钥本身被 RSA-2048/PKCS1v15 加密，存为 `XTeeEncryptAesKey`
  3. RSA 私钥在 Android KeyStore（alias XTeeSecurityAlias），模拟器
     userdebug 下可从 /data/misc/keystore/persistent.sqlite 的 blobentry
     取出（id=33, subcomponent_type=0），切片 b[5:5+4+int(b[7:9])] 即 DER
  4. IV 存在 `XTeeSecurityIv`（base64，16 字节）

用法:
  ./scripts/unseal-token.py            # 解出并打印，不落盘
  ./scripts/unseal-token.py --save     # 解出并写入 work/live/*.txt
"""
import base64
import os
import re
import sqlite3
import subprocess
import sys

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

ADB = '/Volumes/LogicExt/Git/BookReader/.android-sdk/platform-tools/adb'
PKG = 'com.xiaopeng.mycarinfo'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEE = os.path.join(ROOT, 'work/live/tee.bin')
KS = '/tmp/ks.sqlite'


def adb(*args):
    return subprocess.run([ADB, *args], capture_output=True)


def pull_tee():
    """拉取 MMKV tee 文件。"""
    adb('pull', f'/data/data/{PKG}/files/mmkv/tee', TEE)
    if not os.path.exists(TEE):
        raise RuntimeError('拉取 tee 失败：检查 adb root 是否已获取')


def sync_device_id():
    """把 work/local.env 的 XP_DI 对齐到模拟器里 App 当前的 deviceId。

    deviceId 存在 shared_prefs/device_id.xml.xml，App 每重装一次就换一个。
    token 与该 deviceId 绑定：用旧 DI 签名，真 token 也会被拒（实测
    `12010104 登录状态已过期`，而空 token 是 `12010103`——两者不同就说明
    信封解开了、token 读到了，纯粹是身份对不上）。
    """
    out = adb('shell', f'cat /data/data/{PKG}/shared_prefs/device_id.xml.xml')
    m = re.search(rb'name="device_id">([0-9a-f]{32})<', out.stdout)
    if not m:
        print('未找到 App 的 deviceId，跳过同步')
        return None
    di = m.group(1).decode()
    env = os.path.join(ROOT, 'work/local.env')
    if not os.path.exists(env):
        print(f'没有 {env}，跳过同步')
        return di
    lines = open(env).read().splitlines()
    old = next((l.split('=', 1)[1] for l in lines if l.startswith('XP_DI=')), None)
    if old == di:
        return di
    lines = [f'XP_DI={di}' if l.startswith('XP_DI=') else l for l in lines]
    open(env, 'w').write('\n'.join(lines) + '\n')
    print(f'XP_DI 已更新: {old} → {di}')
    return di


def pull_keystore():
    adb('pull', '/data/misc/keystore/persistent.sqlite', KS)
    if not os.path.exists(KS):
        raise RuntimeError('拉取 keystore 失败')


def rsa_key():
    """从 keystore blobentry 取 RSA 私钥（模拟器 userdebug 可用）。

    blobentry.id 每次重装 App 都会变（5.19.0 是 33，4.2.0 是 36），
    所以按 alias 反查，不要写死 id。
    """
    con = sqlite3.connect(KS)
    row = con.execute(
        "select b.blob from blobentry b"
        " join keyentry k on k.id = b.keyentryid"
        " where k.alias='XTeeSecurityAlias' and b.subcomponent_type=0"
        " order by length(b.blob) desc limit 1"
    ).fetchone()
    if not row:
        raise RuntimeError('keystore 里没找到 XTeeSecurityAlias 的私钥条目，'
                           '真机上私钥在 TEE 内，此路不通')
    b = bytes(row[0])
    n = int.from_bytes(b[7:9], 'big')
    der = b[5:5 + 4 + n]
    return serialization.load_der_private_key(der, password=None)


def mmkv_read(buf, name):
    """按 MMKV 布局读一个键的原始字节值。

    MMKV 是追加写：同一个键在文件里会留下多份历史值，最新的在最后。
    必须用 rfind 取最后一次出现，否则会读到登录前那份已失效的旧 token
    （2026-10-30 实测：accessToken 在 tee 里出现 4 次，find 取到最旧的）。
    """
    i = buf.rfind(name)
    if i < 0:
        return None
    p = i + len(name)

    def rd(off):
        v = s = 0
        while True:
            c = buf[off]
            v |= (c & 0x7F) << s
            off += 1
            if not c & 0x80:
                break
            s += 7
        return v, off

    outer, p = rd(p)
    inner, q = rd(p)
    return buf[q:q + inner]


def unseal(name, key, iv, buf):
    b64 = mmkv_read(buf, name)
    if b64 is None:
        raise RuntimeError(f'{name} 不在 tee 里')
    ct = base64.b64decode(b64 + b'=' * (-len(b64) % 4))
    dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    out = dec.update(ct) + dec.finalize()
    pad = out[-1]
    if not (1 <= pad <= 16 and out[-pad:] == bytes([pad]) * pad):
        raise RuntimeError(f'{name} 解密后 padding 非法，密钥或 IV 不匹配')
    return out[:-pad].decode()


def unseal_bytes(name, key, iv, buf):
    """与 unseal 相同，但返回原始字节。XmartV1LocalKey* 需要它。"""
    b64 = mmkv_read(buf, name)
    if b64 is None:
        raise RuntimeError(f'{name} 不在 tee 里')
    ct = base64.b64decode(b64 + b'=' * (-len(b64) % 4))
    dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    out = dec.update(ct) + dec.finalize()
    pad = out[-1]
    if not (1 <= pad <= 16 and out[-pad:] == bytes([pad]) * pad):
        raise RuntimeError(f'{name} 解密后 padding 非法，密钥或 IV 不匹配')
    return out[:-pad]


def local_keys(key, iv, buf):
    """解出 10 把 XmartV1LocalKey。

    tee 里存的是 base64 文本；AES-CBC 解开后得到的仍是 base64 字符串，
    必须再解码一次才是真正的 16 字节密钥（2026-10-30 实测确认）。
    """
    out = {}
    for i in range(10):
        name = f'XmartV1LocalKey{i}'.encode()
        if mmkv_read(buf, name) is None:
            continue
        inner = unseal_bytes(name, key, iv, buf)
        out[i] = base64.b64decode(inner)
    return out


def main():
    save = '--save' in sys.argv
    pull_tee()
    pull_keystore()
    sync_device_id()

    buf = open(TEE, 'rb').read()
    iv_b64 = mmkv_read(buf, b'XTeeSecurityIv')
    iv = base64.b64decode(iv_b64)
    wrapped = base64.b64decode(mmkv_read(buf, b'XTeeEncryptAesKey'))
    key = rsa_key().decrypt(wrapped, padding.PKCS1v15())

    at = unseal(b'accessToken', key, iv, buf)
    rt = unseal(b'refreshToken', key, iv, buf)
    print(f'accessToken : {len(at)} B  {at[:48]}…')
    print(f'refreshToken: {len(rt)} B  {rt[:48]}…')
    print(f'两者不同     : {at != rt}')

    if save:
        live = os.path.join(ROOT, 'work/live')
        open(os.path.join(live, 'access_token.txt'), 'w').write(at)
        open(os.path.join(live, 'refresh_token.txt'), 'w').write(rt)
        print('已写入 work/live/')
    return at, rt


if __name__ == '__main__':
    main()

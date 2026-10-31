"""小鹏 App 接口探测工具。

凭据（国内）：
    APPID  = xp_xmart_android
    SECRET = 见 work/local.env 的 XP_SECRET
来源见 docs/research/xpeng-app-teardown.md §2.2——两者都不在 APK 静态内容里，
只能从运行进程的 Dalvik 堆中取出（scripts/heap-hunt.sh）。版本更新后需重新取证。

海外链路另有 appId/secret 与 mTLS 客户端证书，证书在 work/certs/。
"""

import base64
import hashlib
import hmac
import json
import os
import re
import socket
import ssl
import time
import uuid

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.asymmetric import padding as _padding

import local_env

# ---- 国内凭据（运行时取得，见模块 docstring）----
APPID = "xp_xmart_android"
SECRET = local_env.get("XP_SECRET")
BRAND = "xiaopeng"          # 服务端精确比对；'Xpeng'/'xpeng' 会被判 12110005
HOST = "apps.xiaopeng.com"  # 国内主机不要求 mTLS

# 设备指纹里的 di，必须与解密 secreteKey 时用的设备号一致，否则密钥池解不出来
DI = local_env.get("XP_DI")
CLIENT = (
    f"ve=5.19.0;br=google;mo=sdk_gphone64_arm64;st=1;sv=17;no=null;"
    f"pn=com.xiaopeng.mycarinfo;cn=gw;re=1080x2209;ma=;ro=Other;me=4.10G;"
    f"cp=0;cr=1;rvc=0;pvc=;nt=WIFI;t=0;gp=;di={DI}"
)

# ---- 海外链路（用于对照，需要 mTLS 客户端证书）----
GLOBAL_APPID = "xp_app_norway_android"
GLOBAL_SECRET = local_env.get("XP_GLOBAL_SECRET", "")
GLOBAL_HOST = "apps-global.xiaopeng.com"
CERT = "work/certs/client-cert-0.pem"
KEY = "work/certs/client-key.pem"


def md5h(s):
    return hashlib.md5(s.encode()).hexdigest()


def canon(method, body, xp):
    """签名用的 canonical 串：METHOD & 排序后的 XP-* 头 & body 的 md5（仅 POST/PUT）。"""
    p = {k.upper(): v for k, v in xp.items()
         if k.upper().startswith("XP-") and k.upper() != "XP-SIGNATURE"}
    tail = md5h(body) if body and method in ("POST", "PUT") else ""
    return f"{method}&" + "&".join(f"{k}={v}" for k, v in sorted(p.items())) + f"&{tail}"


def _ctx(mtls=False):
    c = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    if mtls:
        c.load_cert_chain(CERT, KEY)
    return c


def http(host, path, headers, body="{}", mtls=False):
    hdr = (f"POST {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n"
           f"Content-Type: application/json; charset=utf-8\r\nContent-Length: {len(body)}\r\n")
    for k, v in headers.items():
        hdr += f"{k}: {v}\r\n"
    hdr += "\r\n"
    with socket.create_connection((host, 443), timeout=15) as s:
        with _ctx(mtls).wrap_socket(s, server_hostname=host) as ss:
            ss.sendall(hdr.encode() + body.encode())
            d = b""
            while True:
                b = ss.recv(16384)
                if not b:
                    break
                d += b
    return d.decode("utf-8", "replace")


def dechunk(raw):
    """HTTP/1.1 分块响应 → 纯 body。"""
    if "\r\n\r\n" not in raw:
        return raw
    head, rest = raw.split("\r\n\r\n", 1)
    if "transfer-encoding: chunked" not in head.lower():
        return rest
    out = []
    while rest:
        line, _, rest = rest.partition("\r\n")
        try:
            n = int(line.strip() or "0", 16)
        except ValueError:
            break
        if n == 0:
            break
        out.append(rest[:n])
        rest = rest[n + 2:]
    return "".join(out)


def json_body(raw):
    """从响应里取第一个完整 JSON 对象（服务端偶尔在 JSON 后追加杂字节）。"""
    s = dechunk(raw)
    depth = start = 0
    for i, ch in enumerate(s):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(s[start:i + 1])
    return None


def base_headers(ts=None):
    ts = ts or int(time.time() * 1000)
    return {
        "Xp-Appid": APPID,
        "Xp-Brand": BRAND,
        "Xp-Client-Encoding": "None",
        "Xp-Client-Type": "1",
        "Xp-Uid": "0",
        "Xp-Client": CLIENT,
        "Xp-Nonce": f"{ts}0001",
        "Xp-Encryption-Type": "2",
        "Xp-Tee-Version": "2",
    }


def signed(path, body="{}", extra=None, host=HOST, secret=None, appid=None, mtls=False):
    """发一条带外层签名的请求（不含 Xp-Authorization），返回原始响应文本。"""
    xp = base_headers()
    if appid:
        xp["Xp-Appid"] = appid
    if extra:
        xp.update(extra)
    h = dict(xp)
    h["Xp-Signature"] = hmac.new((secret or SECRET).encode(),
                                 canon("POST", body, xp).encode(),
                                 hashlib.sha256).hexdigest()
    return http(host, path, h, body, mtls=mtls)


def tenant():
    """取国内 tenant 的 secreteKey。注意每次返回的密文都不同。"""
    return json_body(signed("/biz/v5/secure/teeIndiv4App"))["data"]


def strip_pkcs7(d):
    p = d[-1]
    return d[:-p] if 1 <= p <= 16 and d[-p:] == bytes([p]) * p else d


def keypool(secrete_b64, device_id):
    """secreteKey → {index: 16 字节 AES 密钥}。密钥是 md5(device_id) 的 AES-ECB。

    注意：这里解出的是「中转」密钥，不是 Xp-Authorization 实际使用的密钥。
    真正使用的是本地 XmartV1LocalKey*，见 unwrap_local_keys()。
    """
    key = hashlib.md5(device_id.encode()).digest()
    ct = base64.b64decode(secrete_b64)
    dec = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    pt = strip_pkcs7(dec.update(ct) + dec.finalize()).decode("utf-8")
    pool = {int(m.group(1)): base64.b64decode(m.group(2))
            for m in re.finditer(r'(\d+):\{"index":\d+,"key":"([^"]+)"\}', pt)}
    return pool, pt


def unwrap_local_keys(rsa_key, mmkv_path):
    """从 files/mmkv/tee 解出真正用于 Xp-Authorization 的本地密钥。

    rsa_key 是 Android KeyStore alias XTeeSecurityAlias 的私钥对象；
    mmkv_path 指向设备上的 files/mmkv/tee。返回 {index: 16 字节密钥}。
    """
    d = open(mmkv_path, "rb").read()
    iv = base64.b64decode(re.search(
        rb"XTeeSecurityIv[^\x00]{0,3}?([A-Za-z0-9+/]{16,32}={0,2})", d).group(1))

    j = d.find(b"XTeeEncryptAesKey") + len(b"XTeeEncryptAesKey")
    i = j
    while not (65 <= d[i] <= 90 or 97 <= d[i] <= 122 or 48 <= d[i] <= 57 or d[i] in b"+/"):
        i += 1
    enc = base64.b64decode(d[i:d.find(b"==", i) + 2])
    wrap = rsa_key.decrypt(enc, _padding.PKCS1v15())

    def cbc(b64):
        dec = Cipher(algorithms.AES(wrap), modes.CBC(iv)).decryptor()
        return strip_pkcs7(dec.update(base64.b64decode(b64)) + dec.finalize())

    keys = {}
    for m in re.finditer(rb"XmartV1LocalKey(\d)-,([A-Za-z0-9+/=]{20,60})", d):
        keys[int(m.group(1))] = base64.b64decode(cbc(m.group(2).decode()))
    return keys


def build_auth(tee_id, device_id, idx, key, plain, version=2,
               nonce_length=36, ts_ms=None, iv=None, marker=b"XA"):
    """构造 Xp-Authorization。

    布局：[1B tee_len][tee_id][2B 标记][1B ver][1B idx][1B dev_len][device_id]
          [1B nonce_len][8B ts BE][1B iv_len][iv][AES-GCM 密文]
    标记国内版是 b'XA'（海外版文档记为 b'OA'）。

    **tee_id 传 None 或空串时不写 tee_len 段**——2026-10-30 实测这是唯一
    能被服务端解开的形式（带 tee_id 段一律 12110009）。4.2.0 本地存储里
    根本没有 tee_id，印证了这一点。
    """
    ts_ms = ts_ms or int(time.time() * 1000)
    iv = iv or os.urandom(12)
    enc = AESGCM(key).encrypt(iv, plain, None)
    raw = bytearray()
    if tee_id:
        raw.append(len(tee_id))
        raw += tee_id.encode()
    raw += marker
    raw.append(version & 0xFF)
    raw.append(idx & 0xFF)
    raw.append(len(device_id))
    raw += device_id.encode()
    raw.append(nonce_length & 0xFF)
    raw += ts_ms.to_bytes(8, "big")
    raw.append(len(iv))
    raw += iv
    raw += enc
    return base64.b64encode(bytes(raw)).decode()


def authed(path, tee_id, local_keys, body="{}", idx=3, host=HOST):
    """带完整双层签名的请求。

    内层 canonical 含 XP-TEE-ID、不含 XP-AUTHORIZATION；
    外层 canonical 含 XP-AUTHORIZATION。两层都用 secret 做 HMAC-SHA256。
    实测这样构造可以过掉服务端的身份与 TEE 校验（返回 12010103 即只剩账号 token）。
    """
    ts = int(time.time() * 1000)
    xp = base_headers(ts)
    xp["Xp-Tee-Id"] = tee_id

    inner = hmac.new(SECRET.encode(), canon("POST", body, xp).encode(),
                     hashlib.sha256).hexdigest()
    nonce = str(uuid.uuid4())
    plain = nonce.encode() + base64.b64encode(
        json.dumps({"xpSign": inner}, separators=(",", ":")).encode())
    xp["Xp-Authorization"] = build_auth(tee_id, DI, idx, local_keys[idx],
                                        plain, ts_ms=ts, nonce_length=len(nonce))

    h = dict(xp)
    h["Xp-Signature"] = hmac.new(SECRET.encode(), canon("POST", body, h).encode(),
                                 hashlib.sha256).hexdigest()
    return http(host, path, h, body)


if __name__ == "__main__":
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else "/biz/v5/secure/teeIndiv4App"
    print(dechunk(signed(path)))

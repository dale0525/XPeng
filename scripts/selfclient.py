#!/usr/bin/env python3
"""自研客户端身份：独立于官方 App 的 deviceId + 密钥池。

为什么需要这个：官方 App 的 ``files/mmkv/tee`` 里的 ``XmartV1LocalKey0..9``
是**登录时服务端下发**的，App 在后台每约 3 小时换一次。复用它的 tee 会被
轮换打断（表现为 WEEB 解不开、``InvalidTag``），且和 App 抢会话。

本模块的做法：自己生成 deviceId，自己调 ``teeIndiv4App`` 拿密钥池，服务端
把它当成另一台设备。已实测：

- 新 deviceId 调 ``teeIndiv4App`` 返回 ``code:200``，无需 token
- 不同 deviceId 拿到的密钥池互不相同
- 用新密钥池签名的请求返回 ``12010103``（信封解开、缺 token），
  而不是 ``12110005``/``12110009``（签名或信封失败）

**密钥池不能缓存**：``teeIndiv4App`` 每次返回一次性密钥，服务端只认最近
一次。实测用上一次的密钥签名 → ``12110009``，用当次的 → ``12010103``。
所以 ``keys()`` 每次都重新拉取。
"""
import base64
import hashlib
import hmac
import json
import time
import uuid

import probe

# 自研客户端的设备标识；持久化后服务端才会把它当固定设备
DEVICE_SEED = 'xpeng-selfclient'


def device_id(seed=DEVICE_SEED):
    """稳定的 deviceId（32 hex）。换 seed 等于换一台设备。"""
    return hashlib.md5(seed.encode()).hexdigest()


def _signed_post(path, di, body='{}'):
    """只带外层签名的请求（teeIndiv4App 这类不需要 token 的接口）。"""
    ts = int(time.time() * 1000)
    xp = probe.base_headers(ts)
    xp['Xp-Client'] = xp['Xp-Client'].replace(probe.DI, di)
    hh = dict(xp)
    hh['Xp-Signature'] = hmac.new(
        probe.SECRET.encode(), probe.canon('POST', body, hh).encode(),
        hashlib.sha256).hexdigest()
    raw = probe.dechunk(probe.http(probe.HOST, path, hh, body))
    s = raw if isinstance(raw, str) else raw.decode('utf8', 'replace')
    return json.loads(s[:s.rindex('}') + 1])


def keys(di=None):
    """拉一套当次有效的密钥池 ``{index: 16B}``。不要缓存。"""
    di = di or device_id()
    r = _signed_post('/biz/v5/secure/teeIndiv4App', di)
    if r.get('code') != 200:
        raise RuntimeError(f"teeIndiv4App 失败: {r.get('code')} {r.get('desc')}")
    pool, _ = probe.keypool(r['data']['secreteKey'], di)
    return pool


def call(path, di=None, body='{}', token=None, idx=3):
    """用自研身份打一个业务接口。

    token 为 None 时只验签名（预期返回 12010103）。
    """
    di = di or device_id()
    pool = keys(di)
    ts = int(time.time() * 1000)
    xp = probe.base_headers(ts)
    xp['Xp-Client'] = xp['Xp-Client'].replace(probe.DI, di)
    inner = hmac.new(
        probe.SECRET.encode(), probe.canon('POST', body, xp).encode(),
        hashlib.sha256).hexdigest()
    plain = (str(uuid.uuid4())
             + base64.b64encode(json.dumps({'xpSign': inner},
                                           separators=(',', ':')).encode()).decode())
    if token:
        plain += '&accessToken=' + token
    xp['Xp-Authorization'] = probe.build_auth(
        None, di, idx, pool[idx], plain.encode(),
        version=2, nonce_length=36, ts_ms=ts)
    hh = dict(xp)
    hh['Xp-Signature'] = hmac.new(
        probe.SECRET.encode(), probe.canon('POST', body, hh).encode(),
        hashlib.sha256).hexdigest()
    raw = probe.dechunk(probe.http(probe.HOST, path, hh, body))
    s = raw if isinstance(raw, str) else raw.decode('utf8', 'replace')
    return json.loads(s[:s.rindex('}') + 1])


if __name__ == '__main__':
    di = device_id()
    print(f'deviceId: {di}')
    p = keys(di)
    print(f'密钥槽: {sorted(p)}')
    print(f'槽3: {p[3].hex()}')
    r = call('/biz/v5/vehicle/v2/myVehicles', di)
    print(f'myVehicles -> code={r.get("code")} {r.get("desc") or ""}')
    print('  12010103 = 签名与信封均通过，只差账号 token')

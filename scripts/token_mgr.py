#!/usr/bin/env python3
"""小鹏 App 会话令牌管理：自动续期，避免 2 小时过期导致链路中断。

用法：
    from token_mgr import get_token, force_refresh
    at = get_token()          # 必要时自动 refresh
    at = force_refresh()      # 强制换新

令牌持久化在 work/live/access_token.txt 与 refresh_token.txt。
refreshToken 有效期 90 天，accessToken 2 小时。
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import uuid

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import probe
import local_env
from probe import (
    SECRET, DI, base_headers, build_auth, canon, dechunk, http,
)

UID = local_env.get('XP_UID')
ROOT = os.path.dirname(_HERE)
AT_PATH = os.path.join(ROOT, 'work/live/access_token.txt')
RT_PATH = os.path.join(ROOT, 'work/live/refresh_token.txt')
TEE_PATH = os.path.join(ROOT, 'work/live/tee')
KEYHEX = '/tmp/k3.hex'
META_PATH = os.path.join(ROOT, 'work/live/token_meta.json')

_KEYS = None
# 本机设备标识，写进 `work/local.env` 的 `XP_TEE`，不入版本库。
_TEE = local_env.get('XP_TEE')


def _keys():
    """解出本地密钥池（TEE 包装的 XmartV1LocalKey0..9）。"""
    global _KEYS
    if _KEYS is None:
        from cryptography.hazmat.primitives.serialization import load_der_private_key
        b = bytes.fromhex(open(KEYHEX).read().strip())
        rsa = load_der_private_key(b[5:5 + 4 + int.from_bytes(b[7:9], 'big')], None)
        _KEYS = probe.unwrap_local_keys(rsa, TEE_PATH)
    return _KEYS


def _headers(body, extra_plain=None):
    """构造完整签名头；extra_plain 追加到内层明文（如 &refreshToken=…）。"""
    keys = _keys()
    ts = int(time.time() * 1000)
    xp = base_headers(ts)
    xp['Xp-Uid'] = UID
    xp['appVersion'] = '5.19.0'
    xp['brand'] = 'google'
    xp['deviceModel'] = 'sdk_gphone64_arm64'
    xp['osVersion'] = '17'
    xp['versionCode'] = '10639'

    inner = hmac.new(SECRET.encode(), canon('POST', body, xp).encode(),
                     hashlib.sha256).hexdigest()
    nonce = str(uuid.uuid4())
    plain = nonce + base64.b64encode(
        json.dumps({'xpSign': inner}, separators=(',', ':')).encode()
    ).decode() + (extra_plain or '')
    xp['Xp-Authorization'] = build_auth(
        _TEE, DI, 7, keys[7], plain.encode(),
        ts_ms=ts, nonce_length=len(nonce),
    )
    h = dict(xp)
    h['Xp-Signature'] = hmac.new(
        SECRET.encode(), canon('POST', body, h).encode(), hashlib.sha256
    ).hexdigest()
    return h


def _read(path):
    try:
        return open(path).read().strip() or None
    except FileNotFoundError:
        return None


def _meta():
    try:
        return json.load(open(META_PATH))
    except (FileNotFoundError, ValueError):
        return {}


def refresh(rt=None):
    """用 refreshToken 换令牌。

    **重要（2026-10-29 实测）**：服务端返回的 accessToken/refreshToken 是
    `WEEB…` 开头的加密信封（base64 解开为 XA + ver + idx + deviceId +
    32B 含时间戳 + iv + AES-GCM 密文），**不是** `eyJ…` JWT，直接当 token 用会
    返回 12010104，且其解包逻辑尚未还原。

    因此本函数**不覆盖**原始的 eyJ refreshToken（它可反复使用），只把原始
    refreshToken 的有效期信息落盘；返回的 WEEB 信封单独存到 at_weeb.txt 供
    后续研究，不参与鉴权。

    实测约束：同一个 eyJ refreshToken 可连刷 5 次成功，但高频调用后会返回
    12010202（登录状态已过期）。应把刷新频率控制在临近过期时才刷。
    """
    rt = rt or _read(RT_PATH)
    if not rt:
        raise RuntimeError('缺少 refreshToken：需重新登录后抓取')
    if not rt.startswith('eyJ'):
        raise RuntimeError(
            f'refreshToken 格式异常（应以 eyJ 开头，实际 {rt[:12]}…）：'
            'WEEB 信封不能作为 refresh 输入'
        )
    body = '{}'
    h = _headers(body, extra_plain='&refreshToken=' + rt)
    raw = dechunk(http('apps.xiaopeng.com', '/sso/app/v3/token/refresh', h, body))
    resp = json.loads(raw[:raw.rindex('}') + 1])
    if resp.get('code') != 200:
        raise RuntimeError(f"refresh 失败: {resp.get('code')} {resp.get('desc')}")
    d = resp['data']
    # WEEB 信封单独留档，绝不写回 RT_PATH
    open(os.path.join(ROOT, 'work/live/at_weeb.txt'), 'w').write(d['accessToken'])
    json.dump({
        'expiresIn': d.get('expiresIn'),
        'refreshExpiresIn': d.get('refreshExpiresIn'),
        'refreshedAt': int(time.time()),
        'refreshExpiresAt': int(time.time()) + int(d.get('refreshExpiresIn') or 7776000),
        'note': 'WEEB 信封未解包，refreshToken 保持原 eyJ 值不变',
    }, open(META_PATH, 'w'))
    return d['accessToken']


def get_token(margin=300):
    """取可用 accessToken；距过期不足 margin 秒则自动续期。"""
    at = _read(AT_PATH)
    m = _meta()
    if not at:
        return refresh()
    exp = m.get('expiresAt')
    if exp and time.time() > exp - margin:
        return refresh()
    return at


def is_valid(token=None):
    """用业务接口实测令牌是否有效。"""
    token = token or _read(AT_PATH)
    if not token:
        return False
    body = '{}'
    h = _headers(body, extra_plain='&accessToken=' + token)
    raw = dechunk(http('apps.xiaopeng.com', '/biz/v5/vehicle/v2/myVehicles', h, body))
    try:
        return json.loads(raw[:raw.rindex('}') + 1]).get('code') == 200
    except ValueError:
        return False


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if cmd == 'refresh':
        print('新 accessToken 长度:', len(refresh()))
    elif cmd == 'valid':
        print('令牌有效' if is_valid() else '令牌无效')
    else:
        m = _meta()
        at = _read(AT_PATH)
        print(f"accessToken 长度: {len(at) if at else 0}")
        if m.get('expiresAt'):
            left = m['expiresAt'] - time.time()
            print(f"剩余有效期: {int(left // 60)} 分钟")
        print('实测:', '有效' if is_valid() else '无效')

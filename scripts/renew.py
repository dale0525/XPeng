#!/usr/bin/env python3
"""accessToken 自动续期——一次登录后长期免重登。

链路：refreshToken → /sso/app/v3/token/refresh → WEEB 信封 → AES-GCM 解开
      → 新的 accessToken + refreshToken（都是 968 B JWT）

WEEB 信封（base64 解码后 1075 B）：
  [0:2]  "XA"        [2] ver=1     [3] keyIndex
  [4]    devlen=32   [5:37] deviceId
  [37]   nonceLen=32 [38:46] ts_ms BE
  [46]   ivLen=12    [47:59] iv
  [59:]  AES-GCM ct（1016 B）→ 明文 1000 B

明文 = 32 B 随机前缀 + 968 B JWT。

**keyIndex 直接就是密钥槽的槽位号**，用哪把密钥由信封自己带，不需要猜。

**密钥来自服务端下发的池，不是本地 tee**（2026-11-01 修正）：每次请求
`teeIndiv4App` 都会得到一套新池，签发该 token 的那次请求用的池才能解开它。
事后再取一套新池、或用设备本地的 XmartV1LocalKey，都会 `InvalidTag`。
请求信封同理——带 `tee_id` 段会直接 `12110009`（信封解不开）。

用法：
    pixi run -e rev python scripts/renew.py status    # 看当前 token 是否可用
    pixi run -e rev python scripts/renew.py renew     # 续期并保存
    pixi run -e rev python scripts/renew.py auto      # 快过期才续期

token 落在 work/live/{access,refresh}_token.txt，不进版本库。
"""

import base64
import hashlib
import hmac
import json
import os
import sys
import time
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import probe  # noqa: E402
import local_env  # noqa: E402

ROOT = os.path.dirname(_HERE)

LIVE = os.path.join(ROOT, 'work/live')
AT_PATH = os.path.join(LIVE, 'access_token.txt')
RT_PATH = os.path.join(LIVE, 'refresh_token.txt')

UID = local_env.get('XP_UID')
# accessToken 实测寿命约 2.5 h（§2.10），留 10 分钟余量
AT_LIFETIME = 2.5 * 3600
RENEW_MARGIN = 600


def _keys(di=None):
    """取一套当次有效的服务端密钥池 ``{index: 16B}``。**每次调用都不同，不要缓存。**

    以前这里读本地 tee，那条路走不通：服务端加密 token 与请求信封用的是它
    当次下发的池，不是设备本地的 XmartV1LocalKey。用本地 tee 只会拿到
    ``12110009``（信封解不开）或 ``InvalidTag``（token 解不开）。
    """
    import selfclient
    return selfclient.keys(di or probe.DI)


def unwrap_weeb(weeb, pool=None):
    """解开 WEEB 信封，返回 (jwt, key_index)。

    keyIndex 直接索引密钥槽；AAD 为空。``pool`` 必须是**签发该 token 的那次
    请求**所用的池，事后重取的新池解不开（``InvalidTag``）。
    """
    raw = base64.b64decode(weeb)
    if len(raw) < 60:
        raise ValueError(f'WEEB 太短: {len(raw)} B')
    if raw[:2] != b'XA':
        raise ValueError(f'WEEB 标记不是 XA: {raw[:2]!r}')
    idx = raw[3]
    iv = raw[47:59]
    ct = raw[59:]
    keys = pool or _keys()
    if idx not in keys:
        raise ValueError(f'keyIndex={idx} 不在密钥池里（有 {sorted(keys)}）')
    pt = AESGCM(keys[idx]).decrypt(iv, ct, None)
    if len(pt) != 1000:
        raise ValueError(f'明文长度异常: {len(pt)} B（预期 1000）')
    jwt = pt[32:].decode()
    if not jwt.startswith('eyJ'):
        raise ValueError(f'明文 [32:] 不是 JWT: {jwt[:20]!r}')
    return jwt, idx


def _post(path, extra_plain, pool=None):
    """打一个 SSO 接口，返回 (响应 dict, 本次用的密钥池)。

    池必须连同响应一起返回：响应里的 WEEB 只能用**本次请求**的池解开，
    事后再取一个新池解不开（2026-11-01 实测）。

    ``tee_id`` 传 None：信封带 tee_id 段时服务端一律 ``12110009``。
    """
    body = '{}'
    ts = int(time.time() * 1000)
    xp = probe.base_headers(ts)
    xp['Xp-Uid'] = UID
    xp['appVersion'] = '5.19.0'
    xp['versionCode'] = '10639'
    inner = hmac.new(probe.SECRET.encode(),
                     probe.canon('POST', body, xp).encode(),
                     hashlib.sha256).hexdigest()
    plain = (str(uuid.uuid4())
             + base64.b64encode(json.dumps({'xpSign': inner},
                                           separators=(',', ':')).encode()).decode()
             + extra_plain).encode()
    pool = pool or _keys()
    xp['Xp-Authorization'] = probe.build_auth(
        None, probe.DI, 7, pool[7], plain,
        version=2, nonce_length=36, ts_ms=ts)
    hh = dict(xp)
    hh['Xp-Signature'] = hmac.new(probe.SECRET.encode(),
                                  probe.canon('POST', body, hh).encode(),
                                  hashlib.sha256).hexdigest()
    raw = probe.dechunk(probe.http('apps.xiaopeng.com', path, hh, body))
    s = raw if isinstance(raw, str) else raw.decode('utf8', 'replace')
    i, j = s.find('{'), s.rfind('}')
    return json.loads(s[i:j + 1]), pool


def call(path, token, body='{}'):
    """用给定 accessToken 打一个业务接口。"""
    ts = int(time.time() * 1000)
    xp = probe.base_headers(ts)
    xp['Xp-Uid'] = UID
    xp['appVersion'] = '5.19.0'
    xp['versionCode'] = '10639'
    inner = hmac.new(probe.SECRET.encode(),
                     probe.canon('POST', body, xp).encode(),
                     hashlib.sha256).hexdigest()
    plain = (str(uuid.uuid4())
             + base64.b64encode(json.dumps({'xpSign': inner},
                                           separators=(',', ':')).encode()).decode()
             + '&accessToken=' + token).encode()
    pool = _keys()
    xp['Xp-Authorization'] = probe.build_auth(
        None, probe.DI, 7, pool[7], plain,
        version=2, nonce_length=36, ts_ms=ts)
    hh = dict(xp)
    hh['Xp-Signature'] = hmac.new(probe.SECRET.encode(),
                                  probe.canon('POST', body, hh).encode(),
                                  hashlib.sha256).hexdigest()
    raw = probe.dechunk(probe.http('apps.xiaopeng.com', path, hh, body))
    s = raw if isinstance(raw, str) else raw.decode('utf8', 'replace')
    i, j = s.find('{'), s.rfind('}')
    return json.loads(s[i:j + 1])


def _load(path):
    return open(path).read().strip() if os.path.exists(path) else None


def _save(at, rt):
    os.makedirs(LIVE, exist_ok=True)
    open(AT_PATH, 'w').write(at)
    open(RT_PATH, 'w').write(rt)
    os.chmod(AT_PATH, 0o600)
    os.chmod(RT_PATH, 0o600)
    open(AT_PATH + '.ts', 'w').write(str(int(time.time())))


def get_token():
    """返回一个可用的 accessToken；本地这份失效时才续期。

    续期有频率限制（十几次后 RT 作废），所以默认先用磁盘上那份。
    """
    at = _load(AT_PATH)
    if at and call('/biz/v5/vehicle/v2/myVehicles', at).get('code') == 200:
        return at
    at, _ = renew()
    return at


def renew():
    """用 refreshToken 换一对新 token。返回 (at, rt)。"""
    rt = _load(RT_PATH)
    if not rt:
        raise RuntimeError(f'没有 refreshToken，先跑 unseal-token.py 或登录一次\n'
                           f'预期位置: {RT_PATH}')
    r, pool = _post('/sso/app/v3/token/refresh', '&refreshToken=' + rt)
    if r.get('code') != 200:
        raise RuntimeError(f"续期失败: {r.get('code')} {r.get('desc')}")
    d = r['data']
    at_new, idx_a = unwrap_weeb(d['accessToken'], pool=pool)
    rt_new, idx_r = unwrap_weeb(d['refreshToken'], pool=pool)
    _save(at_new, rt_new)
    print(f'续期成功  AT idx={idx_a} 尾={at_new[-16:]}  '
          f'RT idx={idx_r} 尾={rt_new[-16:]}  expiresIn={d.get("expiresIn")}')
    return at_new, rt_new


def status():
    """看当前 accessToken 是否还能用。"""
    at = _load(AT_PATH)
    if not at:
        print(f'没有 accessToken: {AT_PATH}')
        return False
    r = call('/biz/v5/vehicle/v2/myVehicles', at)
    ok = r.get('code') == 200
    print(f"accessToken 尾={at[-16:]}  状态={'可用' if ok else '失效'}  "
          f"code={r.get('code')} {r.get('desc') or ''}")
    if ok:
        v = r['data']['vehicles'][0]
        print(f"  车辆: {v['vin']} {v.get('plateNo')} {v.get('vehicleTypeName')}")
    return ok


def auto():
    """按时间戳判断是否该续期，需要才续。"""
    ts_path = AT_PATH + '.ts'
    if os.path.exists(ts_path):
        age = time.time() - int(open(ts_path).read().strip())
        if age < AT_LIFETIME - RENEW_MARGIN and status():
            print(f'剩余约 {(AT_LIFETIME - age) / 60:.0f} 分钟，暂不续期')
            return _load(AT_PATH)
    print('需要续期')
    return renew()[0]


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if cmd == 'status':
        status()
    elif cmd == 'renew':
        renew()
    elif cmd == 'auto':
        auto()
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""手机号登录：发码 → 校验验证码 → 换 token → 落盘。

链路（全部在同一个 ``Xp-Xid`` 会话里）：

1. ``POST /verification/app/v5/sms/code``        发短信，响应下发 ``XP-Xid``
2. ``POST /verification/app/v3/sms/validate``    校验验证码，把通过状态写进会话
3. ``POST /sso/app/v5/smsLogin``                 只带 mobile，从会话取状态换 token

**为什么验证码不能直接交给 smsLogin**：实测只传 ``mobile`` 时 smsLogin 也返回
``12001402 短信验证码错误``，而不是「code 不能为空」；换 ``code``/``smsCode``/
``verifyCode`` 三种字段名结果一致。而 ``sms/validate`` 缺字段时会明确报
``code不能为空``/``smsType不能为空``。即验证码由 sms/validate 消化，smsLogin
只认会话状态。

**滑块**：发码那一步需要易盾票据，本脚本不做——票据绑定服务端会话与轨迹风控，
脚本生成的轨迹过不了。拿到票据的方式是让官方 App 发码，再把 ``XP-Xid`` 与
验证码喂进来（见 ``--xid``）。

用法：
    # 官方 App 已发码，从抓包或 App 拿到 xid 与验证码
    pixi run -e rev python scripts/login.py --xid <uuid> --code 1234

    # 自研侧直接发码（需要预先拿到易盾票据 validate）
    pixi run -e rev python scripts/login.py --validate <票据>
"""

import argparse
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

import probe  # noqa: E402
import selfclient  # noqa: E402

ROOT = os.path.dirname(_HERE)
LIVE = os.path.join(ROOT, 'work/live')
UC = 'apps-uc.xiaopeng.com'

SMS_TYPE = '11'  # 登录场景；服务端对 1/2/11/21/31 不校验取值，只要求非空

# 易盾验证码 ID，来自 App 运行时内存里的 NetEaseCaptchaId（2026-10-31 取证）。
# drag/validate 必须带上它，否则服务端无法定位是哪个验证码实例。
CAPTCHA_ID = 'f6c14777879d4a75b683b29be6709db6'

# smsLogin 请求体里的设备信息，取自 4.2.0 真机抓包。服务端据此回填
# sData.lastDeviceModel / lastDeviceBrand（缺这两项时这两个字段为空）。
# 注意：它**不是**业务接口 12010101 的成因——那个是请求头缺 Xp-Uid 导致的。
DEVICE_MODEL = 'sdk_gphone64_arm64'
DEVICE_BRAND = 'google'

# drag/validate 的 sceneType 白名单。未知场景返回 12051100，已知场景返回 200。
# 2026-11-01 从 4.2.0 真实登录流量里看到第二道滑块用的是 **LGN**，不是 SMS：
#   smsLogin → 12040101 → drag/validate{sceneType:"LGN"} → 200{valid:true} → smsLogin 200。
# 此前枚举漏了 LGN，导致第二道滑块票据一直被以错误场景提交。
SECOND_DRAG_SCENES = ('LGN', 'SMS', 'RESET', 'REG', 'RESET_PASSWORD', 'CANCEL_ACCOUNT')

# 第二道滑块（smsLogin 返回 12040101 之后那道）的真实场景。
SECOND_DRAG_SCENE = 'LGN'

# 第二道滑块票据在内层明文里的候选字段名。依据：accessToken/refreshToken 就是
# 以 `&accessToken=…` 形式追加在内层明文末尾的（研究文档 §4.4、§4.6）。
INNER_TICKET_FIELDS = ('validate', 'ptoken', 'captchaValidate')

# 旧版 smsLogin 端点。实测 v3/v4 仍可用（返 12001402 而非 12001100），
# 但 dex 字符串池里只有 v5/smsLogin —— 说明 v3/v4 是服务端保留的旧路由，
# App 从不调用。旧版可能没有第二道滑块，故列为待验候选。
OLD_SMSLOGIN_VERSIONS = (3, 4)


TRACE_DIR = os.path.join(LIVE, 'trace')
_TRACE_SEQ = [0]


def _trace(path, body, pool, raw, parsed):
    """把一次请求的完整上下文落盘，供事后离线诊断。

    为什么必须存 **密钥池**：``sData`` 是用服务端当次下发的密钥池加密的，
    而 ``selfclient.keys()`` 每次调用都可能返回不同的一套。若不在请求时刻
    存下来，事后拿到 ``sData`` 也无从解密——只能再发一条短信重来。
    """
    try:
        os.makedirs(TRACE_DIR, exist_ok=True)
        _TRACE_SEQ[0] += 1
        name = os.path.basename(path).replace('/', '_') or 'root'
        fn = os.path.join(TRACE_DIR, f'{int(time.time()*1000)}_{_TRACE_SEQ[0]:03d}_{name}.json')
        with open(fn, 'w') as f:
            json.dump({
                'path': path,
                'body': body,
                'keypool': {str(k): v.hex() for k, v in (pool or {}).items()},
                'response': parsed,
                'raw': raw[:200000],
            }, f, ensure_ascii=False)
        return fn
    except Exception:
        return None


def _call(path, body, xid=None, inner_extra=''):
    """带双层签名的 POST，返回 (json, set_cookie 列表)。

    ``inner_extra`` 追加到 ``Xp-Authorization`` 内层明文末尾（形如
    ``&validate=…``）。内层是唯一客户端可控、且实测仍能正常解封的载体——
    已知 accessToken/refreshToken 就走这条路。
    """
    di = selfclient.device_id()
    pool = selfclient.keys(di)
    ts = int(time.time() * 1000)
    xp = probe.base_headers(ts)
    xp['Xp-Client'] = xp['Xp-Client'].replace(probe.DI, di)
    if xid:
        xp['Xp-Xid'] = xid
    inner = hmac.new(probe.SECRET.encode(), probe.canon('POST', body, xp).encode(),
                     hashlib.sha256).hexdigest()
    plain = (str(uuid.uuid4())
             + base64.b64encode(json.dumps({'xpSign': inner},
                                           separators=(',', ':')).encode()).decode()
             + inner_extra)
    xp['Xp-Authorization'] = probe.build_auth(
        None, di, 3, pool[3], plain.encode(), version=2, nonce_length=36, ts_ms=ts)
    hh = dict(xp)
    hh['Xp-Signature'] = hmac.new(probe.SECRET.encode(),
                                  probe.canon('POST', body, hh).encode(),
                                  hashlib.sha256).hexdigest()
    raw = probe.http(UC, path, hh, body, mtls=True)
    cookies = [line.split(':', 1)[1].strip()
               for line in raw.split('\r\n')
               if line.lower().startswith('set-cookie:')]
    s = probe.dechunk(raw)
    parsed = json.loads(s[:s.rindex('}') + 1])
    _trace(path, body, pool, raw, parsed)
    return parsed, cookies


def _call_pooled(path, body, xid=None, inner_extra=''):
    """同 ``_call``，但额外返回**本次请求用的密钥池**。

    ``sData`` 是用「服务端当次下发的密钥池」加密的，而该池每次调用
    ``/biz/v5/secure/teeIndiv4App`` 都会变（2026-11-01 实测两次取池不同）。
    所以必须把「发 smsLogin 那次用的池」与响应绑定返回，不能事后再取一份。
    """
    captured = {}

    orig = selfclient.keys

    def _spy(di=None):
        p = orig(di)
        captured['pool'] = p
        return p

    selfclient.keys = _spy
    try:
        r, cookies = _call(path, body, xid=xid, inner_extra=inner_extra)
    finally:
        selfclient.keys = orig
    return r, cookies, captured.get('pool')


def _xid_of(cookies):
    for c in cookies:
        name, _, rest = c.partition('=')
        if name.strip().lower().endswith('xid'):
            return rest.split(';')[0].strip()
    return None


def send_code(mobile, validate=None):
    """发短信，返回会话 xid。validate 为易盾票据时先过滑块校验。

    三步走（2026-10-31 从 App 堆快照取证）：

    1. 建会话：不带票据调 ``sms/code``，预期 ``12040101``，但响应会下发
       ``XP-Xid`` cookie。
    2. 校验滑块：``drag/validate``，body 是
       ``{sceneType:"SMS", mobile, captchaId, validate}``。票据放这里，**不是**
       放 ``sms/code``——后者根本不读 ``validate``，这正是长期卡在
       ``12040106`` 的原因。返回 ``data.valid`` 为 true 才继续。
    3. 发码：同一会话再调 ``sms/code``（body 只有 mobile + smsType）。

    票据是一次性的：``drag/validate`` 成功即消费，重复提交必返回 false。
    """
    base = {'mobile': mobile, 'smsType': SMS_TYPE}
    base_json = json.dumps(base)

    if not validate:
        r, cookies = _call('/verification/app/v5/sms/code', base_json)
        if r.get('code') != 200:
            raise RuntimeError(f"发码失败: {r.get('code')} {r.get('desc') or r.get('msg')}")
        xid = _xid_of(cookies)
        if not xid:
            raise RuntimeError('发码成功但响应里没有 XP-Xid，无法继续')
        return xid

    # 1. 建会话。预期 12040101（还没过滑块），但 cookie 会下发。
    _, cookies = _call('/verification/app/v5/sms/code', base_json)
    xid = _xid_of(cookies)
    if not xid:
        raise RuntimeError('发码接口没有下发 XP-Xid，无法建立会话')

    # 2. 校验滑块票据。票据只能成功一次，失败即无法重试。
    drag_body = json.dumps({
        'sceneType': 'SMS',
        'mobile': mobile,
        'captchaId': CAPTCHA_ID,
        'validate': validate,
    }, separators=(',', ':'))
    r, _ = _call('/verification/app/v3/drag/validate', drag_body, xid=xid)
    if r.get('code') != 200:
        raise RuntimeError(
            f"滑块校验请求失败: {r.get('code')} {r.get('desc') or r.get('msg')}")
    if not (r.get('data') or {}).get('valid'):
        raise RuntimeError(
            '滑块票据未通过（validate 只能用一次：可能已被消费或已过期），'
            '请重新拖一次滑块')

    # 3. 同一会话发码。
    r, cookies2 = _call('/verification/app/v5/sms/code', base_json, xid=xid)
    if r.get('code') != 200:
        raise RuntimeError(f"发码失败: {r.get('code')} {r.get('desc') or r.get('msg')}")
    return _xid_of(cookies2) or xid


def verify_code(mobile, code, xid):
    """校验验证码；通过后状态记在服务端会话里。"""
    r, _ = _call('/verification/app/v3/sms/validate',
                 json.dumps({'mobile': mobile, 'smsType': SMS_TYPE, 'code': code}),
                 xid=xid)
    if r.get('code') != 200:
        raise RuntimeError(f"验证码校验失败: {r.get('code')} {r.get('desc') or r.get('msg')}")
    return r.get('data')


def try_second_drag(mobile, xid, validate, captcha_id=None):
    """第二道滑块：把票据提交给 ``drag/validate``，场景必须是 ``LGN``。

    **2026-11-01 从 4.2.0 真实登录流量取证确定**（此前结论被推翻）：
    ``drag/validate`` 在 ``sceneType:"LGN"`` 下**确实会写会话**——真实时序为

        smsLogin → 12040101
        drag/validate{sceneType:"LGN", mobile, captchaId, validate} → 200 {valid:true}
        smsLogin → 200 {sData: "WEEB…"}

    2026-10-31 之所以判定它「只判定、不写会话」，是因为当时用 ``sceneType:"SMS"``
    提交：SMS 是**发码前那道**滑块的场景，用它提交第二道滑块的票据不会解锁
    ``smsLogin``。LGN 当时不在枚举出的白名单里，被漏掉了。

    返回 ``(out, data)``；``data`` 非 ``None`` 表示已换到 token。
    """
    out = []
    drag_body = json.dumps({
        'sceneType': SECOND_DRAG_SCENE,
        'mobile': mobile,
        'captchaId': captcha_id or CAPTCHA_ID,
        'validate': validate,
    }, separators=(',', ':'))
    r, _ = _call('/verification/app/v3/drag/validate', drag_body, xid=xid)
    out.append(f'drag/validate({SECOND_DRAG_SCENE}): {r.get("code")} '
               f'valid={(r.get("data") or {}).get("valid")}')
    if r.get('code') != 200 or not (r.get('data') or {}).get('valid'):
        return out, None
    # smsLogin 按版本依次试：4.2.0 真机走 v3（2026-11-01 抓包确认），v5 是
    # 5.19.0 的路径。两版服务端都可能只认自己那条，故 v3 优先、v5 兜底。
    body = smslogin_body(mobile)
    for v in (3, 5):
        r2, _, pool2 = _call_pooled(f'/sso/app/v{v}/smsLogin', body, xid=xid)
        d = r2.get('data')
        keys = sorted(d.keys()) if isinstance(d, dict) else type(d).__name__
        out.append(f'v{v}/smsLogin: {r2.get("code")} data_keys={keys}')
        if r2.get('code') == 200:
            # 把这次的密钥池挂到 data 上，解密 sData 时必须用同一套
            if isinstance(d, dict):
                d['_keypool'] = pool2
                try:
                    d['_uid'] = unwrap_sdata(d['sData'], pool=pool2).get('uid')
                except Exception:
                    pass
            return out, d
    return out, None


def unwrap_sdata(sdata, tee_path=None, pool=None):
    """解开 ``smsLogin`` 返回的 ``sData`` 信封，返回内层 dict。

    ``sData`` 是「外层 WEEB 套内层 JSON」：外层解开后是 ``32B 随机 + JSON``，
    JSON 里的 ``accessToken``/``refreshToken`` 本身又是 WEEB 信封（各 1436 字符），
    需再用同一套 keypool 解一次才是 JWT。

    外层布局与 ``renew.unwrap_weeb`` 相同（``XA`` + ver + keyIndex@3 +
    iv@47..59 + ct@59..），区别是明文不固定 1000 B、且前 32 B 是随机数。

    **密钥来源是服务端当次下发的密钥池，不是本地 tee**（2026-11-01 实测）：
    ``selfclient.keys()`` 每次调 ``/biz/v5/secure/teeIndiv4App`` 取一套，
    请求信封用的就是这套，服务端也用同一套加 ``sData``。用本地 tee 的
    keypool 解会报 ``InvalidTag``——tee 里那套是设备自己存的另一份，
    与服务端按 deviceId 下发的不一定同步。

    ``pool`` 由调用方从请求 trace 里带进来（最可靠：就是那次请求用的池）。
    缺省时现取一份；``tee_path`` 仅作最后兜底。
    """
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    raw = base64.b64decode(sdata)
    if raw[:2] != b'XA':
        raise ValueError(f'sData 标记不是 XA: {raw[:2]!r}')
    idx = raw[3]

    keys = pool
    if not keys or idx not in keys:
        try:
            keys = selfclient.keys()
        except Exception:
            keys = None
    if not keys or idx not in keys:
        import importlib.util
        from cryptography.hazmat.primitives.asymmetric import padding
        spec = importlib.util.spec_from_file_location(
            'unseal_token', os.path.join(_HERE, 'unseal-token.py'))
        unseal = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(unseal)
        buf = open(tee_path or os.path.join(LIVE, 'tee.bin'), 'rb').read()
        key = unseal.rsa_key().decrypt(
            base64.b64decode(unseal.mmkv_read(buf, b'XTeeEncryptAesKey')),
            padding.PKCS1v15())
        iv0 = base64.b64decode(unseal.mmkv_read(buf, b'XTeeSecurityIv'))
        keys = unseal.local_keys(key, iv0, buf)

    if idx not in keys:
        raise ValueError(f'keyIndex={idx} 不在 keypool（有 {sorted(keys)}）')
    pt = AESGCM(keys[idx]).decrypt(raw[47:59], raw[59:], None)
    return json.loads(pt[32:].decode())


def unwrap_token_weeb(weeb, tee_path=None, pool=None):
    """把 ``sData`` 内层的 ``accessToken``/``refreshToken`` 信封解成 JWT。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        'renew', os.path.join(_HERE, 'renew.py'))
    renew = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renew)
    if pool:
        # token 信封同样用「服务端当次下发的密钥池」加密，与 sData 一致。
        # renew.unwrap_weeb 内部调 renew._keys()，把它替换成用传入的池。
        renew._keys = lambda: pool
    elif tee_path:
        # renew._keys() 读的是 unseal.TEE（不是 renew.TEE），必须改到源头
        renew.unseal.TEE = tee_path
    jwt, _ = renew.unwrap_weeb(weeb)
    return jwt


def tokens_of(data, tee_path=None):
    """从 ``smsLogin`` 的 data 取 (accessToken, refreshToken)。

    兼容两种返回结构：

    - 5.19.0：``{"accessToken": "WEEB…", "refreshToken": "WEEB…"}``
    - 4.2.0：``{"sData": "XA…"}`` —— 需解外层信封才能拿到内层同名字段

    返回的是**信封字符串**（不是 JWT），与既有 ``save()`` 落盘口径一致。
    """
    if not isinstance(data, dict):
        return None, None
    if data.get('accessToken'):
        return data['accessToken'], data.get('refreshToken')
    if data.get('sData'):
        inner = unwrap_sdata(data['sData'], tee_path, pool=data.get('_keypool'))
        return inner.get('accessToken'), inner.get('refreshToken')
    return None, None


def smslogin_body(mobile):
    """``smsLogin`` 的请求体，字段与顺序对齐 4.2.0 真机抓包。

    带上 ``deviceModel``/``deviceBrand`` 才能让服务端回填 ``sData`` 里的设备
    字段（见 ``DEVICE_MODEL`` 处注释）。
    """
    return json.dumps({
        'ext': '',
        'deviceUserName': None,
        'mobile': mobile,
        'deviceModel': DEVICE_MODEL,
        'deviceBrand': DEVICE_BRAND,
    }, separators=(',', ':'))


def login(mobile, xid):
    """换 token。返回 (accessToken, refreshToken)。"""
    r, _, pool = _call_pooled('/sso/app/v5/smsLogin', smslogin_body(mobile), xid=xid)
    if r.get('code') != 200:
        raise RuntimeError(f"登录失败: {r.get('code')} {r.get('desc') or r.get('msg')}")
    at, rt = tokens_of({**(r.get('data') or {}), '_keypool': pool})
    if not at:
        raise RuntimeError(f"登录返回 200 但取不到 token：keys={sorted(r['data'])}")
    return at, rt


def save(at, rt, uid=None):
    """落盘 token（信封形式，与既有 renew/unseal 口径一致）。

    ``uid`` 一并存：业务请求的 ``Xp-Uid`` 必须是 token 所属账号，
    否则带 token 也恒 ``12010101``（2026-11-01 实测）。
    """
    os.makedirs(LIVE, exist_ok=True)
    atp, rtp = os.path.join(LIVE, 'access_token.txt'), os.path.join(LIVE, 'refresh_token.txt')
    open(atp, 'w').write(at)
    open(rtp, 'w').write(rt)
    os.chmod(atp, 0o600)
    os.chmod(rtp, 0o600)
    open(atp + '.ts', 'w').write(str(int(time.time())))
    if uid:
        open(os.path.join(LIVE, 'uid.txt'), 'w').write(str(uid))


def main():
    ap = argparse.ArgumentParser(description='手机号登录拿 token')
    ap.add_argument('--mobile', default='13000000000')
    ap.add_argument('--code', help='短信验证码')
    ap.add_argument('--xid', help='发码会话的 XP-Xid（官方 App 发码时拿到）')
    ap.add_argument('--validate', help='易盾票据；给了就由本脚本发码')
    a = ap.parse_args()

    xid = a.xid
    if not xid:
        if not a.validate:
            ap.error('要么给 --xid（复用官方 App 的发码会话），要么给 --validate 自行发码')
        xid = send_code(a.mobile, a.validate)
        print(f'已发码  xid={xid}')
    if not a.code:
        print(f'下一步：拿到验证码后重跑 --xid {xid} --code <验证码>')
        return 0

    verify_code(a.mobile, a.code, xid)
    print('验证码通过')
    at, rt = login(a.mobile, xid)
    save(at, rt)
    print(f'登录成功  AT 尾={at[-16:]}  RT 尾={rt[-16:]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

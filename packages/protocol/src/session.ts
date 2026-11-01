/**
 * 登录与会话。
 *
 * 登录是**三步 + 两道滑块**，全部在同一个 `XP-Xid` 会话里：
 *
 *   1. `sms/code`（无票据）→ 预期 12040101，但响应下发 `XP-Xid` cookie
 *   2. `drag/validate{sceneType:"SMS"}` → 票据通过（`data.valid`）后同一会话再发码
 *   3. `sms/validate` → 校验验证码，状态写进服务端会话
 *   4. `smsLogin` → 12040101 表示「验证码已过、待第二道滑块」
 *   5. `drag/validate{sceneType:"LGN"}` → 通过后重试 `smsLogin` → 200 `{sData}`
 *
 * 判据只看 `code`：12001402=验证码未过，12040101=待第二道滑块，12040106=滑块机会已用完。
 */
import {
  CAPTCHA_ID,
  HOST_BIZ,
  HOST_UC,
  SCENE_LOGIN,
  SCENE_SEND_CODE,
  SMS_TYPE,
  DEVICE_MODEL,
  DEVICE_BRAND,
} from './config.ts';
import { ApiError, XpApi, type CallResult } from './api.ts';
import type { KeyPool } from './keypool.ts';
import { unwrapEnvelope, unwrapJwt } from './sign.ts';
import { utf8Decode } from './bytes.ts';

export const CODE_OK = 200;
export const CODE_NEED_SLIDER = 12040101;
export const CODE_SLIDER_FAILED = 12040106;
export const CODE_SMS_INVALID = 12001402;
export const CODE_TOKEN_EXPIRED = 12010101;

/** 登录成功后落盘的会话。 */
export interface Session {
  /** 968 B JWT，业务接口与 MQTT 凭据都靠它。 */
  accessToken: string;
  /** 信封形式，放进 `/sso/app/v3/token/refresh` 的内层明文。 */
  refreshToken: string;
  /** 业务请求的 `Xp-Uid` 必须等于它。 */
  uid: number;
  /** 登录时刻（毫秒）。真实寿命约 2.5 h，比声明的 7200 s 宽约 33 分钟。 */
  issuedAt: number;
}

export interface LoginStep {
  /** 需要用户做的事。 */
  need: 'slider-send-code' | 'sms-code' | 'slider-login' | 'done';
  /** 会话钥匙，后续步骤都要带上。 */
  xid?: string;
  /** 给人看的状态说明。 */
  message?: string;
}

export class LoginFlow {
  private xid?: string;
  private mobile?: string;
  private readonly api: XpApi;
  private readonly deviceId: string;

  constructor(api: XpApi, deviceId: string) {
    this.api = api;
    this.deviceId = deviceId;
  }

  /** 第一步：用发码那道的滑块票据换一次真实下发短信的机会。 */
  async startWithSlider(validate: string, mobile: string): Promise<LoginStep> {
    this.mobile = mobile;
    const body = JSON.stringify({ mobile, smsType: SMS_TYPE });
    // 1. 建会话：不带票据调 sms/code，预期 12040101，但 cookie 会下发
    const first = await this.api.post(HOST_UC, '/verification/app/v5/sms/code', this.deviceId, body, {
      keyIndex: 3,
      mtls: true,
    });
    this.xid = xidOf(first);
    if (!this.xid) throw new Error('发码接口没有下发 XP-Xid，无法建立会话');

    // 2. 票据走 drag/validate，不是 sms/code —— 后者根本不读 validate 字段
    const dragBody = JSON.stringify({
      sceneType: SCENE_SEND_CODE,
      mobile,
      captchaId: CAPTCHA_ID,
      validate,
    });
    const drag = await this.api.post(
      HOST_UC,
      '/verification/app/v3/drag/validate',
      this.deviceId,
      dragBody,
      { keyIndex: 3, mtls: true, extraHeaders: { 'Xp-Xid': this.xid } },
    );
    if (drag.json.code !== CODE_OK) {
      throw new Error(`滑块校验请求失败: ${drag.json.code} ${drag.json.desc ?? ''}`);
    }
    if (!drag.json.data?.valid) {
      throw new Error('滑块票据未通过（票据只能用一次，可能已被消费或过期）');
    }

    // 3. 同一会话发码
    const sent = await this.api.post(HOST_UC, '/verification/app/v5/sms/code', this.deviceId, body, {
      keyIndex: 3,
      mtls: true,
      extraHeaders: { 'Xp-Xid': this.xid },
    });
    if (sent.json.code !== CODE_OK) {
      throw new Error(`发码失败: ${sent.json.code} ${sent.json.desc ?? ''}`);
    }
    this.xid = xidOf(sent) ?? this.xid;
    return { need: 'sms-code', xid: this.xid, message: '验证码已发送' };
  }

  /** 第二步：校验验证码。通过后服务端会话进入「待第二道滑块」。 */
  async submitCode(code: string): Promise<LoginStep> {
    if (!this.xid || !this.mobile) throw new Error('先走 startWithSlider');
    const body = JSON.stringify({ mobile: this.mobile, smsType: SMS_TYPE, code });
    const r = await this.api.post(HOST_UC, '/verification/app/v3/sms/validate', this.deviceId, body, {
      keyIndex: 3,
      mtls: true,
      extraHeaders: { 'Xp-Xid': this.xid },
    });
    if (r.json.code !== CODE_OK) {
      throw new Error(`验证码校验失败: ${r.json.code} ${r.json.desc ?? ''}`);
    }
    return { need: 'slider-login', xid: this.xid, message: '验证码通过，请再拖一次滑块' };
  }

  /**
   * 第三步：先试一次 smsLogin 探到 12040101，再提交第二道滑块票据，最后换 token。
   *
   * 必须先探一次：服务端只有在「验证码已过」的会话上才把 12040101 当作
   * 「滑块窗口已开」。每调一次 smsLogin 消耗一次滑块机会，所以只探一次。
   */
  async finishWithSlider(validate: string): Promise<Session> {
    if (!this.xid || !this.mobile) throw new Error('先走 startWithSlider');
    const body = smsLoginBody(this.mobile);
    const probe = await this.smsLogin(body);
    if (probe.json.code === CODE_OK) {
      // 某些会话（同一设备短期内重复登录）不再要求第二道滑块
      return this.extractSession(probe);
    }
    if (probe.json.code !== CODE_NEED_SLIDER) {
      throw new Error(`登录失败: ${probe.json.code} ${probe.json.desc ?? ''}`);
    }

    const dragBody = JSON.stringify({
      sceneType: SCENE_LOGIN,
      mobile: this.mobile,
      captchaId: CAPTCHA_ID,
      validate,
    });
    const drag = await this.api.post(
      HOST_UC,
      '/verification/app/v3/drag/validate',
      this.deviceId,
      dragBody,
      { keyIndex: 3, mtls: true, extraHeaders: { 'Xp-Xid': this.xid } },
    );
    if (drag.json.code !== CODE_OK || !drag.json.data?.valid) {
      throw new Error('第二道滑块未通过，请重新拖一次');
    }

    // 4.2.0 真机走 v3，5.19.0 走 v5；两条都可能只认自己那条，故都试
    for (const version of [3, 5]) {
      const r = await this.smsLogin(body, version);
      if (r.json.code === CODE_OK) return this.extractSession(r);
    }
    throw new Error('滑块已通过但换 token 失败，请重新登录');
  }

  private smsLogin(body: string, version = 5): Promise<CallResult> {
    return this.api.post(
      HOST_UC,
      `/sso/app/v${version}/smsLogin`,
      this.deviceId,
      body,
      { keyIndex: 3, mtls: true, extraHeaders: { 'Xp-Xid': this.xid! } },
    );
  }

  /**
   * 从 smsLogin 的响应里取 token。`sData` 是「外层 WEEB 套内层 JSON」，
   * 内外两层都用**这次请求的**密钥池，所以必须与响应绑定。
   */
  private extractSession(r: CallResult): Session {
    const data = r.json.data ?? {};
    const pool = r.pool;
    let inner: any;
    if (data.sData) {
      inner = this.api.unwrapJson(data.sData, pool);
    } else {
      inner = data;
    }
    if (!inner.accessToken) {
      throw new Error(`登录返回 200 但取不到 token：keys=${Object.keys(data).join(',')}`);
    }
    return {
      accessToken: unwrapJwt(inner.accessToken, pool).jwt,
      refreshToken: inner.refreshToken,
      uid: inner.uid,
      issuedAt: Date.now(),
    };
  }
}

function smsLoginBody(mobile: string): string {
  return JSON.stringify({
    ext: '',
    deviceUserName: null,
    mobile,
    deviceModel: DEVICE_MODEL,
    deviceBrand: DEVICE_BRAND,
  });
}

function xidOf(r: CallResult): string | undefined {
  for (const line of r.raw.setCookie) {
    const name = line.split('=')[0].trim().toLowerCase();
    if (name.endsWith('xid')) return line.split('=')[1].split(';')[0].trim();
  }
  return undefined;
}

/** 用 refreshToken 换一对新 token。返回的 token 信封同样只能用本次的池解开。 */
export async function refreshSession(
  api: XpApi,
  deviceId: string,
  session: Session,
): Promise<Session> {
  const r = await api.post(HOST_BIZ, '/sso/app/v3/token/refresh', deviceId, '{}', {
    keyIndex: 7,
    uid: session.uid,
    innerExtra: '&refreshToken=' + session.refreshToken,
  });
  if (r.json.code !== CODE_OK) {
    throw new ApiError(r.json.code, r.json.desc ?? r.json.msg ?? '', '/sso/app/v3/token/refresh');
  }
  const d = r.json.data;
  return {
    accessToken: unwrapJwt(d.accessToken, r.pool).jwt,
    refreshToken: d.refreshToken,
    uid: session.uid,
    issuedAt: Date.now(),
  };
}

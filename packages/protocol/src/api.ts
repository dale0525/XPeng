/**
 * 业务接口封装：所有请求都走「现取密钥池 → 双层签名 → 带 accessToken」。
 *
 * 三个必须记住的约束（都踩过，见 docs/research/xpeng-app-teardown.md）：
 * 1. 密钥池每次请求现取，不能复用（复用 → 12110009 信封解不开）。
 * 2. `Xp-Uid` 必须是 token 所属账号，且在算内层签名之前设好（否则恒 12010101）。
 * 3. 信封不带 `tee_id` 段（带了 → 12110009）。
 */
import { HOST_BIZ, HOST_UC } from './config.ts';
import type { HttpClient, HttpResponse } from './http.ts';
import { parseJsonLoose } from './http.ts';
import type { KeyPool } from './keypool.ts';
import { parseKeyPool } from './keypool.ts';
import {
  baseHeaders,
  buildAuth,
  innerPlain,
  unwrapEnvelope,
  withOuterSignature,
  type HeaderMap,
} from './sign.ts';
import { utf8Decode } from './bytes.ts';

/**
 * 业务层错误：`code` 是服务端返回码，`desc` 是它的中文描述。
 *
 * 不用 TS 的构造函数参数属性（`constructor(readonly code: number)`）：Node 的
 * TS 剥离模式与部分工具链不支持它，写成显式赋值两边都能跑。
 */
export class ApiError extends Error {
  readonly code: number;
  readonly desc: string;
  readonly path: string;

  constructor(code: number, desc: string, path: string) {
    super(`${path} 失败: ${code} ${desc}`);
    this.code = code;
    this.desc = desc;
    this.path = path;
  }
}

export interface CallOptions {
  /** 只有 `call` 用它；`post` 把设备号作为独立参数收。 */
  deviceId?: string;
  accessToken?: string;
  uid?: string | number;
  /** 复用一份已取好的池（只有「取池的那次请求」本身需要）。 */
  pool?: KeyPool;
  /** 信封用哪个槽位；业务接口固定 7，登录链路用 3。 */
  keyIndex?: number;
  mtls?: boolean;
  host?: string;
  /** 追加到内层明文末尾，形如 `&refreshToken=…`。 */
  innerExtra?: string;
  /** 额外请求头（登录链路要 `Xp-Xid`）。 */
  extraHeaders?: HeaderMap;
}

export interface CallResult {
  json: any;
  raw: HttpResponse;
  /** 本次请求用的密钥池——响应里的 WEEB/sData 只能用这一套解开。 */
  pool: KeyPool;
}

export class XpApi {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  /**
   * 取一套当次有效的密钥池。**不要缓存。**
   *
   * 这里不能走 `post()`：`post()` 在没有池时也会调 `keys()`，会无限递归。取池
   * 的那次请求本身用不到信封（服务端只验外层签名），所以单独发一次。
   */
  async keys(deviceId: string): Promise<KeyPool> {
    const body = '{}';
    const headers = withOuterSignature(body, baseHeaders(deviceId, 0));
    const raw = await this.http.post(
      HOST_BIZ,
      '/biz/v5/secure/teeIndiv4App',
      headers,
      body,
      false,
    );
    const res = { json: parseJsonLoose(raw.body) };
    if (res.json.code !== 200) {
      throw new ApiError(res.json.code, res.json.desc ?? res.json.msg ?? '', '/biz/v5/secure/teeIndiv4App');
    }
    return parseKeyPool(res.json.data.secreteKey, deviceId);
  }

  /** 打一个带完整双层签名的接口，返回解析后的 JSON 与本次用的池。 */
  async post(
    host: string,
    path: string,
    deviceId: string,
    body: string,
    opts: CallOptions = {} as CallOptions,
  ): Promise<CallResult> {
    const pool = opts.pool ?? (await this.keys(deviceId));
    const keyIndex = opts.keyIndex ?? 7;
    const headers = baseHeaders(deviceId, opts.uid);
    Object.assign(headers, opts.extraHeaders ?? {});
    const { plain, nonceLength } = innerPlain(body, headers, {
      accessToken: opts.accessToken,
    });
    headers['Xp-Authorization'] = buildAuth({
      deviceId,
      keyIndex,
      key: pool[keyIndex],
      plain: plain + (opts.innerExtra ?? ''),
      nonceLength,
    });
    const signed = withOuterSignature(body, headers);
    const raw = await this.http.post(host, path, signed, body, opts.mtls ?? host === HOST_UC);
    return { json: parseJsonLoose(raw.body), raw, pool };
  }

  /**
   * 打一个业务接口。token 失效（12010101）时抛 ApiError，由上层决定是否续期。
   */
  async call(
    path: string,
    opts: CallOptions & { deviceId: string; body?: unknown },
  ): Promise<CallResult> {
    const body = JSON.stringify(opts.body ?? {});
    const res = await this.post(opts.host ?? HOST_BIZ, path, opts.deviceId, body, opts);
    if (res.json.code !== 200) {
      throw new ApiError(res.json.code, res.json.desc ?? res.json.msg ?? '', path);
    }
    return res;
  }

  /** 解开 WEEB 信封里的 JSON（sData 内层）。 */
  unwrapJson(b64: string, pool: KeyPool): any {
    const { payload } = unwrapEnvelope(b64, pool);
    return JSON.parse(utf8Decode(payload));
  }
}

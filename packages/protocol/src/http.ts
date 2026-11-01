/**
 * HTTP 传输层的接口。协议逻辑（签名、信封、报文）与具体传输解耦：
 * 安卓侧由原生模块提供「带 mTLS 客户端证书的 TLS POST」，测试与桌面环境用
 * `fetch` 实现。
 */
export interface HttpResponse {
  status: number;
  /** 原始响应体（已去掉 chunked 分帧与 HTTP 头）。 */
  body: string;
  /** `Set-Cookie` 行。登录链路靠它拿 `XP-Xid` 会话钥匙。 */
  setCookie: string[];
}

export interface HttpClient {
  /**
   * @param host 目标主机，如 `apps.xiaopeng.com`
   * @param path 路径，如 `/biz/v5/vehicle/v2/myVehicles`
   * @param headers 请求头（已含签名）
   * @param body 请求体
   * @param mtls 是否带客户端证书（`apps-uc.xiaopeng.com` 强制要求）
   */
  post(
    host: string,
    path: string,
    headers: Record<string, string>,
    body: string,
    mtls: boolean,
  ): Promise<HttpResponse>;
}

/** 从 JSON 响应里取出第一个完整对象；服务端偶尔在 JSON 后追加杂字节。 */
export function parseJsonLoose(s: string): any {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`响应不是 JSON: ${s.slice(0, 120)}`);
  return JSON.parse(s.slice(start, end + 1));
}

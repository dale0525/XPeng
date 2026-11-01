/**
 * 把 `HttpClient` 接口接到原生实现上。
 *
 * 协议层（`@xpeng/protocol`）不知道证书从哪来、请求怎么发；这里补上这两件事：
 * 登录主机带 mTLS 客户端证书，业务主机不带。
 */
import { CLIENT_CERT_PEM, CLIENT_KEY_PEM } from '@xpeng/protocol/src/generated/clientCert';
import type { HttpClient, HttpResponse } from '@xpeng/protocol/src/http';
import { HOST_UC } from '@xpeng/protocol/src/config';
import { native } from './native';

export const nativeHttp: HttpClient = {
  async post(host, path, headers, body, mtls): Promise<HttpResponse> {
    const res = await native.post(
      host,
      path,
      headers,
      body,
      mtls ? CLIENT_CERT_PEM : null,
      mtls ? CLIENT_KEY_PEM : null,
    );
    return { status: res.status, body: res.body, setCookie: res.setCookie };
  },
};

/** 只有登录/发码主机需要客户端证书。 */
export function needsMtls(host: string): boolean {
  return host === HOST_UC;
}

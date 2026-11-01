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

/**
 * 一次请求的总时限。
 *
 * 原生层只设了 `soTimeout`（单次 read 的阻塞上限），它挡不住「服务端每隔几秒
 * 挤一点数据」这种慢速响应——每次 read 都能成功返回，循环可以拖到任意久，界面
 * 上的「校验中…」和 60s 倒计时就一起冻住。协议层没有超时概念，所以在这里兜。
 *
 * 25s 取值依据：`sms/validate` 前面还要先取一次密钥池，两次往返串行；模拟器上
 * 正常往返约 1~2s，25s 已留足余量，又能保证卡住时用户最多等 25s 就能看到错误。
 */
const REQUEST_TIMEOUT_MS = 25_000;

export const nativeHttp: HttpClient = {
  async post(host, path, headers, body, mtls): Promise<HttpResponse> {
    const req = native.post(
      host,
      path,
      headers,
      body,
      mtls ? CLIENT_CERT_PEM : null,
      mtls ? CLIENT_KEY_PEM : null,
    );
    // 超时后原 promise 仍会完成，但已经没人 await 它；这里只负责让调用方拿到错误。
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s）：${path}`)), REQUEST_TIMEOUT_MS);
    });
    const res = await Promise.race([req, timeout]);
    return { status: res.status, body: res.body, setCookie: res.setCookie };
  },
};

/** 只有登录/发码主机需要客户端证书。 */
export function needsMtls(host: string): boolean {
  return host === HOST_UC;
}

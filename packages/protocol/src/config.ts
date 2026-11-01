/**
 * 国内链路的客户端常量。
 *
 * appId 与 secret 来自官方 App 运行进程的 Dalvik 堆（见
 * docs/research/xpeng-app-teardown.md §2.2），不在 APK 静态内容里。它们属于
 * **客户端身份**而非用户凭据：服务端按它们判断「这是小鹏 App 在说话」。
 *
 * secret 不入版本库：由 `scripts/gen-secrets.py` 从 work/local.env 生成到
 * `src/generated/secrets.ts`（该目录已 gitignore）。
 */
import { APP_SECRET as SECRET } from './generated/secrets.ts';

export { SECRET as APP_SECRET };

/** 国内版 appId。 */
export const APP_ID = 'xp_xmart_android';

/** 服务端精确比对 brand，'Xpeng'/'xpeng' 会被判 12110005。 */
export const BRAND = 'xiaopeng';

/** 业务接口主机（国内不要求 mTLS）。 */
export const HOST_BIZ = 'apps.xiaopeng.com';

/** 登录与会话主机（要求 mTLS，客户端证书随包分发）。 */
export const HOST_UC = 'apps-uc.xiaopeng.com';

/** 易盾验证码实例 id，`drag/validate` 必须带，否则服务端定位不到验证码实例。 */
export const CAPTCHA_ID = 'f6c14777879d4a75b683b29be6709db6';

/** 易盾 H5 SDK 入口，滑块由真人在 WebView 里拖。 */
export const CAPTCHA_SDK_URL = 'https://cstaticdun.126.net/load.min.js';

/**
 * `drag/validate` 的 sceneType 白名单。发码那道滑块用 `SMS`，换 token 那道用 `LGN`。
 * 用错场景时服务端照样返回 200，但会话不前进（smsLogin 恒 12040101）。
 */
export const SCENE_SEND_CODE = 'SMS';
export const SCENE_LOGIN = 'LGN';

/** 发码接口的 smsType，登录场景。 */
export const SMS_TYPE = '11';

/** 设备指纹与登录请求体里的设备信息，与真机抓包一致。 */
export const DEVICE_MODEL = 'sdk_gphone64_arm64';
export const DEVICE_BRAND = 'google';
export const APP_VERSION = '5.19.0';
export const VERSION_CODE = '10639';

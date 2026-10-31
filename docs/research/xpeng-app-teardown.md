# 小鹏 App（com.xiaopeng.mycarinfo）逆向调研

目的：为「自研 App 替代官方」评估技术成本与卡点。结论按「自研 + 钥匙从官方服务端接口获取」这条路线组织。
调研对象：国内版 5.19.0（`versionCode 10639`，265 MB）为主，4.2.0（`versionCode` 未记，120 MB）作对照。

> 本文档只保留**当前成立**的结论。已被实测推翻的判断集中在附录 A，仅供避免重走弯路。

---

## 0. 结论速览

**客户端身份层已全部闭环**：签名、appId、secret、密钥池、本地密钥、信封格式、MQTT 凭据全部打通并线上验证。

**续期已闭环**：一次登录 + refresh 循环即可长期免重登。连续 5 次续期全部成功，每次 `keyIndex` 轮换。**注意**：重新登录后若解出的 token 尾部不变，说明 `mmkv_read` 读到了 MMKV 里的历史值，见 §4.9。

**车控已打通 13 条**：解锁、锁车、闪灯、遮阳帘开关、空调开关、设温度、全车车窗升降、极速降温、极速升温、高温抑菌、鸣笛、哨兵开关、哨兵灵敏度。均实测成功并有 `code:200` 回执。

**未打通**：单扇车窗、除霜、内外循环、座椅加热通风、智能清洁/除味/香氛（风量官方 App 无此功能，不需打通）。**后备箱开关不在 MQTT**（走 BLE，用户 10-31 确认，见 §5.6）。**「解锁并启动」的启动那一步不在 MQTT**（走 BLE，见 §5.6）。**远程查看**只读可用，开流与视角切换本车无环视硬件（`avm_exist=0`）无法实测。**鸣笛**按用户要求不再排查。剩余项原因统一为「App 实际发的请求报文抓不到」——报文在内存中存活极短，Frida 被易盾反调试阻断，且 App `flags=0x0` 不可调试（`am instrument` 反射枚举方案不成立）。

| 子问题 | 状态 |
| --- | --- |
| 请求签名（双层 HMAC） | ✅ 闭环 |
| appId / secret | ✅ `xp_xmart_android` / `<XP_SECRET>` |
| 客户端证书 | ✅ 可提取，国内主机不要求 |
| 钥匙物料链（tenant → 密钥池 → 本地密钥） | ✅ 闭环 |
| `Xp-Authorization` 信封 | ✅ 闭环（分版本，见 §3.3） |
| 登录 | ✅ 端到端闭环：发码 → 验证码 → 第二道滑块(`LGN`) → `smsLogin` 200 → 解 `sData` 拿 AT/RT → 带 `Xp-Uid=<uid>` 打业务接口 **200**（§4.2） |
| 令牌续期 | ✅ 闭环 |
| MQTT 连接与凭据 | ✅ 闭环 |
| 车控指令 | 🟡 13/15（解锁/锁车/闪灯/遮阳帘/空调开关/设温度/全车车窗/极速降温/极速升温/高温抑菌/鸣笛/哨兵开关/哨兵灵敏度） |
| 远程查看 | 🟡 只读可，开流未打通且本车无环视硬件 |
| BLE 离线解锁 | 🟡 native 层可复用，未编译验证 |

---

## 1. 加固与静态分析边界

### 1.1 易盾加壳

- 加固商：网易易盾。5.19.0 壳版本 `7.6.0_744`，4.2.0 为 `7.4.7.15`（`com.netease.nis.wrapper.MyApplication.VER`）。
- 5.19.0 的 `classes.dex`（120,255,620 B）头部声明 1547 个字符串、30 个类，全部是 `com.netease.nis.wrapper.*`；`file_size` 与整文件长度一致、adler32 校验和正确，即 **dex 头本身未被破坏**，但字节码被整体加密。
- 5.19.0 额外带 `libNetHTProtect.so`（3771960 B）与 `libijiami_H5SDK.so`；**4.2.0 没有这两个库**，只有易盾的 `libnesec.so`/`assets/libnesec64`。两者加固层级不同，但 dex 都被加密到只剩 30 个壳类（4.2.0 的 dex 为 40,395,592 B，反编译同样只出 30 类）。

### 1.1.1 4.2.0 与 5.19.0 的协议差异（2026-10-31 静态对比）

两个版本的 dex 都能搜到 `LoginSmsPresenter`/`RiskService`/`LoginVerifyActivity`，但**协议层已经换代**：

| 项 | 4.2.0（versionCode 8916） | 5.19.0（versionCode 10639） |
| --- | --- | --- |
| 登录端点 | 仅 `v3`：`/sso/app/v3/smsLogin`、`/verification/app/v3/sms/code`、`v3/sms/validate`、`v3/drag/validate` | `v5`：`/sso/app/v5/smsLogin`、`/verification/app/v5/sms/code` |
| 主机 | 只有 `apps.xiaopeng.com` | 增加 `apps-uc.xiaopeng.com` |
| 请求头前缀 | 大写 `XP-*`（`XP-Authorization`/`XP-Signature`/`XP-Ptoken`/`XP-Xid`…） | 混合 `Xp-*` |
| `XP-PtokenType` | **不存在** | 存在 |
| `sPtoken` 字符串 | **存在**（`PTokenManager` 内 `onResult code = %d, msg = %s, sPtoken = %s`） | **不存在** |
| `1204xxxx` 错误码 | dex 里搜不到任何一条 | 搜不到（同样在加密区） |

**关键差异**：4.2.0 的 Ptoken 获取逻辑是**明文 Java**（`com.xiaopeng.common.api.manager.PTokenManager`，带 `PTokenCallBack` 与 `sPtoken` 日志），而 5.19.0 把这段挪走了（只剩类名，没有 `sPtoken` 字符串）。**这是 4.2.0 真正的价值：Ptoken 的生成/获取路径可以直接读，不必脱壳。**

4.2.0 里还有三个 5.19.0 从未出现的端点：`/sso/app/v3/authToken/code`、`/sso/app/v3/getWidgetToken`、`/sso/app/v3/token/conver`。实测 `authToken/code` 需登录态（`12010103`），登录前不可用。

**v3 端点仍然在线**（2026-10-31 实测）：`v3/sms/code` 对假号返回 `12040101`（与 v5 一致），`v3/drag/validate` 返回 `200`。所以 4.2.0 的链路今天仍能打通到服务端——但 v3 与 v5 行为一致，**不能指望 v3 天然没有第二道滑块**。

### 1.2 静态分析为何不可行

```
classes.dex 大小 : 120,255,620 B
magic            : dex\n035\x00
string_ids       : 1,547
type_ids         : 133
method_ids       : 925
class_defs       : 30          <- 正常 120 MB dex 应有数万
class_defs 区    : 0x557c 起，30 × 32 = 960 B
剩余加密数据     : 120,232,776 B  （占 99.98%）
```

30 个可见类名全是混淆串（`CDCCCCCCCCCC`、`CDLCCCCCCCCCLCLC` 等）。

- 真实业务代码在 dex 尾部明文区：`offset 0x14000` 之后约 114 MB，类描述符 `Lcom/xiaopeng/...;` 以明文出现 25,750 处。
- id 表做了整体位移：`string_ids` 条目值统一加 `0x178BC` 才指向合法的 `string_data_item`。按此可还原 20 段、共 66,862 个字符串，但其中仅 336 条含 `xiaopeng`，且多为混淆类名。**业务层字符串与全部 `code_item` 仍不可读。**
- 关键教训：`XmartV1LocalKey`、`XTeeSecurityIv`、`IndivKeySet`、`decryptWithCryptHead` 这些字符串**能在加密区里被搜到，但没有一条能对应到字节码**。搜到名字 ≠ 有实现。
- 没有任何 `.so` 引用这些键（100+ 个 arm64 库逐个 grep `XmartV1|XTee|tee_id` 全 0）。`liball_in_one.so` 里的 `LocalKeySet` 属阿里播放器 DRM，无关。
- `jadx` 只能产出 30 个空壳类。**不动壳就拿不到信封解包逻辑。**

### 1.3 版本对比与选型

| 项目 | 4.2.0 | 5.19.0 | 5.23.5 |
| --- | --- | --- | --- |
| dex | 40 MB，`class_defs=31` | 120 MB，`class_defs=30` | 118 MB |
| dex 字符串表 | 1132 条，零业务代码 | 1547 条，全混淆 | — |
| `libnesec.so` | 2.15 MB | 970 KB | — |
| 易盾版本 | 7.4.7.15 | 7.6.0_744 | — |
| `tee_id` | **无** | 有 | — |
| 信封是否带 `tee_id` 段 | **不带** | **必须带** | — |
| 模拟器可运行 | ✅ | ✅ | ❌ `SIGSEGV` |

**5.23.5 在本机模拟器上启动即崩**：`libbulk.so` 加载后 `Fatal signal 11`，pid 启动 2 秒即死。加载序列 `libDexHelper.so` → `libmmkv.so` → `libc++_shared.so` → `libmarsxlog_16kb.so` → `libbulk.so` → 崩溃。`libmarsxlog_16kb.so` 的 `16kb` 后缀暗示按 16 KB 页对齐编译，而模拟器是 4 KB 页。**未进一步验证。**

**选型：用 5.19.0**。国内版可运行、UI 有遮阳帘入口、车控指令集完整。4.2.0 保留作信封格式对照（它是唯一无 `tee_id` 的版本）。

---

## 2. 客户端身份

### 2.1 签名方案

签名类在加密 dex 内（`SignUtils`、`SecurityScheduler`、`XpV2ApiTransaction`/`XpV3ApiTransaction`），算法通过明文常量 + 运行时抓取 + 线上验证还原。

头族（明文 dex 字符串池内有 20 个 `XP-*` 头名）：`Xp-Appid`、`Xp-Authorization`、`Xp-Brand`、`Xp-Client`、`Xp-Client-Encoding`、`Xp-Client-Type`、`Xp-DEPENDENCE`、`Xp-Encryption-Type`、`Xp-Nonce`、`Xp-Ptoken`、`Xp-PtokenType`、`Xp-SDK`、`Xp-Signature`、`Xp-Tee-Id`、`Xp-Tee-Version`、`Xp-Uid`、`Xp-Xid`，以及 OTA 专用两条。

**双层签名，两层的输入集合不同**（最初踩的坑）：

| 层 | 公式 | canonical 包含 | canonical 排除 |
| --- | --- | --- | --- |
| 内层 `xpSign` | `HMAC-SHA256(secret, "POST&"+C1)` | 全部 `XP-*`（**含 `XP-TEE-ID`**）、body 的 md5 | `XP-AUTHORIZATION`、`XP-SIGNATURE` |
| 外层 `Xp-Signature` | `HMAC-SHA256(secret, "POST&"+C2)` | 全部 `XP-*`（**含 `XP-AUTHORIZATION`**）、body 的 md5 | `XP-SIGNATURE` |

canonical 构造：`{METHOD}&{头按名排序、全大写、k=v 以 & 连接}&{md5_hex(body)}`。

`Xp-Client` 是分号分隔的设备指纹：`ve=;br=;mo=;st=;sv=;no=;pn=;cn=;re=;ma=;ro=;me=;cp=;cr=;rvc=;pvc=;nt=;t=;gp=;di=<32 hex>`。

**踩过的坑**：内层 canonical 漏掉 `XP-TEE-ID` 时报 `12110005`（看似 appId 错），补上后立刻变成 `12010103`（登录态问题）——两者差别只有这一个头。

### 2.2 appId 与 secret

**国内 appId = `xp_xmart_android`，secret 见 `work/local.env` 的 `XP_SECRET`。**

两者静态都拿不到：明文 dex 全量转储（2,749,638 条唯一串）中 `xp_app` 命中 0；122 个 `.so` 中 0；整包字节流中 0。而 `getAppid`/`setAppid`/`reqAppid` 方法名存在，说明值在运行时拼出来。

取得方式：模拟器 `userdebug` + `adb root`，装 App 点「同意」进登录页，输入任意手机号点「获取验证码」触发一次签名请求，dump Dalvik main space（`/proc/<pid>/mem` 的 `0x02000000` 起 576 MB）。堆里直接躺着完整 canonical 串，从中读出 appId；同一次 dump 里的 66 个 16 位小写字母数字串逐个当 secret 试，命中唯一值。

**注意**：内存 dump 不注入进程，因此不触发运行时反调试。这是目前唯一可复现的取证方式。

### 2.3 客户端证书

`assets/client0619.bks` 是标准 BKS v2 密钥库，口令 `xiaopengapp`（不在 APK 内，来自 xpengtoolkit 公开值）：

- 条目 alias `33524b8c184934e850592f1357a65e4b0bfe9ca7`，`BksSealedKeyEntry` 解封后内层 `BksKeyEntry` 含 150 字节 PKCS8 EC P-256 私钥。
- 证书 `CN=xp_app_client01, OU=Xiaopeng Motors CertificateAuthority, O=XiaopengMotors Ltd, L=GZ, ST=GD, C=CN`，签发者 `CN=XPCA`，有效期 2025-06-19 → 2065-06-19。
- 私钥与证书公钥配对已验证。
- `assets/client.bks`（810 B）用 14 个候选口令都打不开，判断为旧版残留。

**mTLS 是真的且校验证书身份**（仅海外主机）：`apps-global.xiaopeng.com` 不带证书 → `400 No required SSL certificate was sent`；带自签伪证书 → `400 The SSL certificate error`。

### 2.4 国内与海外是两套身份

同一套签名代码，appId 与 secret 分地区独立。国内主机 `apps.xiaopeng.com`：

- **不要求 mTLS**：不带客户端证书也照常响应。
- **确实解析 `XP-*` 头**：只给 `Xp-Client-Type` 时返回 `11001101 无效参数 lack header: [XP-CLIENT, XP-APPID, XP-NONCE]`；访问不存在路径返回 `11001105 Handler Not Found`（不是一律 404）。
- **海外 appId 一律被拒**：头齐全、签名正确，但 `Xp-Appid: xp_app_norway_android` 时全部接口返回 `12110005`。
- **拒绝是 appId 闸不是 secret 闸**：secret 换成垃圾串返回码不变；41 个 appId 候选全部 `12110005`。
- `Xp-Brand` 大小写敏感：`xiaopeng`/`XPENG`/空 → 200；`Xpeng`/`xpeng` → `12110005`。

海外链路：`POST /gateway/v1/secure/teeIndiv4OverseaApp`，`Xp-Appid: xp_app_norway_android` + 对应 secret → `{"code":200,"data":{"secreteKey":…,"teeId":…,"version":2}}`；secret 或 appId 任一错 → `11031000`。

### 2.5 钥匙物料链

国内链路完整链条（每步实测）：

1. `POST /biz/v5/secure/teeIndiv4App` 返回 `secreteKey`。国内版**只**返回这一个字段；`teeId` 由客户端自己生成并持久化，同设备跨请求恒定。
2. `secreteKey` 用 AES-ECB 解，密钥是 `md5(device_id)` 的 16 字节原始摘要；去 PKCS7 后得到 `N:{"index":i,"key":"…"}`，解析出 **10 个 16 字节 AES 密钥**。`Xp-Client` 里的 `di` 必须与解密用的设备号一致。
3. 这 10 把密钥只是中转。它们经 `XTeeEncryptAesKey` 再解一层才得到真正用于 `Xp-Authorization` 的密钥。

### 2.6 本地密钥存储

`files/mmkv/tee`（MMKV 格式，明文键名）：

| 键 | 内容 |
| --- | --- |
| `XTeeSecurityIv` | base64，16 字节 CBC IV |
| `XTeeEncryptAesKey` | base64，256 字节，RSA-2048/PKCS1v15 密文 |
| `IndivKeySet` | AES-CBC 加密，解出 `[0,1,2,3,4,5,6,7,8,9]` |
| `tee_id` | 64 位 hex（**仅 5.19.0 有，4.2.0 无**） |
| `XmartV1LocalKey0`…`9` | 各 base64，AES-CBC 加密 |
| `accessToken` / `refreshToken` / `freshToken` | 三个令牌槽（注意第三个拼作 `freshToken`） |
| `KEY_MQTT_ACCOUNT_UID` | 账号 uid，见 `work/local.env` 的 `XP_UID` |

**`XmartV1LocalKey*` 需要二次 base64 解码**：`tee` 里存 base64 文本，AES 解出后仍是 24 字符 base64 字符串，再解码才是 16 字节密钥。

**三层密钥链**：

| 层 | 材料 | 位置 | 形式 |
| --- | --- | --- | --- |
| 1 | RSA-2048 私钥 | KeyStore alias `XTeeSecurityAlias` | 模拟器 userdebug 下从 `/data/misc/keystore/persistent.sqlite` 的 `blobentry`（`subcomponent_type=0`）取出；切片 `b[5:5+4+int.from_bytes(b[7:9],'big')]` 即 DER |
| 2 | AES-128 密钥 | `tee` 的 `XTeeEncryptAesKey` | MMKV varint 长度 → base64 → 256 B，RSA/PKCS1v15 解密得 16 B |
| 3 | IV | `tee` 的 `XTeeSecurityIv` | MMKV varint 长度 → base64 → 16 B |

**blobentry id 每次重装都会变**（5.19.0 是 33、4.2.0 是 36），必须按 `keyentry.alias='XTeeSecurityAlias'` 反查，不要写死。

**MMKV 取值注意**：键名后有**两层 varint**（外层含内部长度字段，内层才是真实长度）。只读一层会多带 2 字节，导致 base64 解码偏移。正确读法见 `scripts/unseal-token.py` 的 `mmkv_read()`。

**密钥槽是轮换的**：连续 4 次续期，AT/RT 的 `keyIndex` 依次为 `2/8 → 5/7 → 8/2 → 2/4 → 4/1`。**实现里必须读信封自带的 `keyIndex`，不能写死。**

**`tee` 会自动更新**：5.19.0 在 01:34 / 04:39 / 07:35 各变一次（间隔约 3 小时），4.2.0 在 10:39 / 10:41 各变一次。说明 App 能解开 WEEB 并把新 token 写回本地。该能力在 Yidun 加密的 dex 内。

**破坏实验**：把 `tee` 里 `accessToken` 密文前 32 字节改成 `0xAA`，重启 App → 立刻退出登录（车辆页消失、出现「一键登录」），且不报错、不尝试静默恢复。同期服务端会话仍完好。由此确认：`tee` 是唯一令牌来源；本地令牌坏了直接掉登录态。

**恢复失败教训**：把原 `tee` 写回后 App 仍未登录，因为 MMKV 有配套的 `tee.crc` 校验文件而当时删过它。**不要在生产取证时改动 `tee` 或 `tee.crc`。**

### 2.6b 不要复用 App 的 `tee`：自研客户端应独立注册（2026-10-30 18:30）

**问题**：`tee` 里的 `XmartV1LocalKey0..9` 是**登录时服务端下发**的，App 在后台每约 3 小时换一次。复用它的 tee 会被轮换打断——表现为 refresh 返回 `200` 但 WEEB 用本地 10 把密钥全部解不开（`InvalidTag`），而此时官方 App 完全正常（它一直持有效 AT，不需要解 WEEB）。

**取证**：连续两次调 `/biz/v5/secure/teeIndiv4App`，用第一次的密钥池签名 → `12110009`，用第二次的 → `12010103`。即**密钥池是一次性的，服务端只认最近一次**，不能缓存。

**解法**：自研客户端自己生成 `deviceId`，自己调 `teeIndiv4App` 拿密钥池。实测（`scripts/selfclient.py`）：

| 验证项 | 结果 |
| --- | --- |
| 新 `deviceId` 调 `teeIndiv4App` | ✅ `code:200`，**不需要 token** |
| 不同 `deviceId` 的密钥池 | ✅ 互不相同（`b4d6aa67…` vs `e4957fd2…`） |
| 用新密钥池签名的业务请求 | ✅ `12010103`（信封解开、缺 token），不是 `12110005`/`12110009` |

**结论：自研客户端可完全独立于官方 App 运行**——服务端把新 `deviceId` 当成另一台设备，密钥互不干扰。这消除了三个问题：不再被 App 的密钥轮换打断、不再依赖模拟器取证、真机同样可用。

**实现要点**：
- `deviceId` 要持久化（`md5(seed)` 即可），换 seed 等于换一台设备。
- **每次请求前重新拉密钥池**，不要缓存；`Xp-Authorization` 的 `keyIndex` 必须对应当次拉取的那套。
- 不需要 `tee_id`（新注册的设备没有这个键，走无 `tee_id` 的信封格式即可）。

**仍未变**：登录仍是单会话约束，自研客户端登录会把官方 App 踢下线。这一条独立注册解决不了。

### 2.7 没有证书 pin，但有私有 CA 信任锚

- 四份网络配置（`network.xml`、`jz_network_security_config.xml`、`network_security_config.xml`、`network_security_config_2.xml`）只有 `<base-config>` / `<domain-config>` 的 `cleartextTrafficPermitted`，**无 `<trust-anchors>`、无 `<pin-set>`**；dex 内无 `sha256/` 形式 pin 常量。
- `res/raw/my_ca.pem` 是一张 Charles Proxy CA，但四份配置都没引用它，dex 内 `raw/my_ca` 命中 0，属开发期遗留。

**但「没有 pin」不等于能 MITM**。`apps*.xiaopeng.com` 的服务端证书由 `CN=Xiaopeng Motors Intermediate CA`（`O=XiaopengMotors Ltd`）签发，App 对这批主机持有自家私有 CA 作为信任锚，系统 CA 对它无效。而 `collect`/`sentry` 用 DigiCert RapidSSL，系统 CA 一装就能解密——这个对比证明 CA 安装方式没问题，差异在信任锚。详见 §4.3。

---

## 3. 信封体系

`Xp-Authorization`（客户端→服务端）与 WEEB（服务端→客户端）**是同一套信封格式的两个变体**，差别只在版本号、`tee_id` 段的有无。

### 3.1 XA 信封（客户端 → 服务端）

```
[1B tee_len][tee_id][2B "XA"][1B ver][1B keyIndex]
[1B devlen][deviceId][1B nonceLen=36][8B ts_ms BE]
[1B ivLen=12][iv][AES-GCM ct]        AAD 为空
```

密文用 16 字节 AES 密钥（`XmartV1LocalKey<keyIndex>`）加密，明文 = `UUID(36B) + base64({"xpSign":"…"})`。标记是 **`XA`**（不是海外文档里的 `OA`），`ver=2`。

**错误码分层可直接区分进度**：

| 构造 | 返回 | 含义 |
| --- | --- | --- |
| 带 `tee_id` 段（任意值） | `12110009` | 服务端解析信封结构时失败（**仅 4.2.0 代际**） |
| 不带 `tee_id` 段 + 空 token | `12010103` | 信封解开，token 字段缺失 |
| 不带 `tee_id` 段 + 真 token | `12010101` 或 `200` | 信封解开且读到 token |

**决定性对照实验**（证明本地密钥与服务端一致）：

| 信封 | 内层 | 结果 | 含义 |
| --- | --- | --- | --- |
| `XA` + 本地 Key7 | 真实 AT | `12010101` | 服务端解开信封、读到 token、判定过期 |
| `XA` + 本地 Key7 | 垃圾串 | `12110005` | XA 路径会校验内层签名 |
| `WEEB` + 本地 Key7 | 任意 | `12110009` | 与内层内容无关，解信封阶段失败 |

实验 A 是关键：服务端用同一把密钥解开了我加密的数据，**证明 `XmartV1LocalKey7` 与服务端完全一致**，也证明 `XA` 是客户端→服务端的正确标记。

### 3.2 WEEB 信封（服务端 → 客户端）

base64 解码后 1075 B：

```
[0:2]   "XA"          ← WEEB 三字符 base64 后恰好产出 XA，是刻意构造
[2]     ver = 1
[3]     keyIndex      ← 直接就是 XmartV1LocalKey 的槽位号
[4]     devlen = 32
[5:37]  deviceId
[37]    nonceLen = 32
[38:46] ts_ms BE
[46]    ivLen = 12
[47:59] iv
[59:]   AES-GCM ct（1016 B = 1000 明文 + 16 tag）
```

**明文 1000 B = 32 B 随机前缀 + 968 B JWT**，AAD 为空。

`WEEB` 前缀**不能剥掉**：整串直接 base64 解码得 1075 B，开头正好是 `58 41 01` = `XA` + `ver=1`。曾误判「`WEEB` 是 4 字符明文前缀，剥掉后得 1072 B」，已推翻。

### 3.3 版本差异：`tee_id` 必须分版本处理（2026-10-30 修正）

这是最容易踩的坑，两个方向都实测过：

| 版本 | 带 `tee_id` 段 | 不带 `tee_id` 段 |
| --- | --- | --- |
| **5.19.0** | ✅ `200` | ❌ `12110009` |
| **4.2.0** | ❌ `12110009` | ✅ `200` |

即 `tee_id` 的有无必须跟着**产生 token 的那个 App 版本**走。5.19.0 的 `tee` 里有 `tee_id` 键，4.2.0 没有，这不是巧合。

`probe.build_auth()` 已支持：`tee_id` 传 `None`/空串时不写 `tee_len` 段。

**另一个可用性**：`XA` 信封可以把 `refreshToken` 递给服务端。把 RT 放进 `XA` 内层调 `/sso/app/v3/token/refresh`，返回 `12010201`（不是签名错误），说明服务端正常读取了内层 RT 并判定失效。

---

## 4. 登录与会话

### 4.1 登录

正确路径是 `POST /sso/app/v5/smsLogin`（主机 `apps-uc.xiaopeng.com`），不是 `getSmsCode`。

**存在第二条登录入口 `/sso/app/v5/login`**（2026-10-31 定位）：接受 `{mobile, password, smsCode}`。**该端点是否需要滑块取决于手机号**（2026-10-31 修正，原记录「不需要滑块票据」只对当时用的编造号码成立）：

| 手机号 | `v5/login` 返回 |
| --- | --- |
| 真实在网号 | `12040102 输入短信验证码`（不要求滑块） |
| 编造号码（7 个样本全部） | `12040101 拖动滑块验证码` |

即原记录「全程不出现 `12040101`」是**编造号码下的观测，不可外推**；换真实号后该端点在**未发码阶段**确实不再要滑块。但它同样绕不开发码：`v5/login` 只校验、不下发，必须先有一次成功的 `sms/code`。

**但真实号验证码通过后，`v5/login` 同样返回 `12040101`**（2026-10-31 真号实测，与该会话的 `smsLogin` 一致）——即 `v5/login` **不是绕开第二道滑块的旁路**，它和 `smsLogin` 共用同一道滑块闸门。

`v5/login` 的三个实测特性：

| 观察 | 含义 |
| --- | --- |
| `password` 填 `x`、`wrongpwd123`、32 个 `a` 结果完全一致 | **密码在服务端未被真正校验**，非空即可 |
| 无 `XP-Xid` 时报 `12040102 输入短信验证码`；有会话仍报 `12040102` | 它要求的是「该手机号已有一条成功下发的短信」，不是任意会话 |
| 同会话内无关字段仍 `12040102`、`smsCode` 变 `12040107` | 字段名确认是 **`smsCode`** |

**`smsCode` 的判定方法有坑**：必须先发一条无关字段确认基线仍是 `12040102`，再发 `smsCode`。因为一次失败的 `v5/login` 会消耗会话状态，之后所有字段名都会「变成」`12040107`，看起来像随便什么字段名都能命中——2026-10-31 就因此误判过一轮。

**`qrcode/*` 与 `authToken/code` 不是登录入口**：空 body 调 `/sso/app/v3/{authToken/code,getWidgetToken,qrcode/permissionInfo,qrcode/validate}` 全部返回 `12010103 登录状态已过期`，而登录类端点在空 body 下会报具体字段缺失（`12001101 mobile不能为空`）。前者是登录后的功能接口。

**`Xp-Xid` 是会话钥匙**。`/verification/app/v5/sms/code` 首次响应会下发 `Set-Cookie: XP-Xid=<uuid>`；后续请求把这个 uuid 放进 **`Xp-Xid` 请求头**，服务端才进入「校验票据」模式：

| 请求形态 | 响应 |
| --- | --- |
| 无 `Xp-Xid` 头，body 带任意 `validate` | `12040101 请验证滑块验证码` |
| 有 `Xp-Xid` 头，body 带 `validate`（**含垃圾值 `zzz`、空串、已用过的票据**） | `12040106 滑块验证码校验不通过` |
| 有 `Xp-Xid` 头，body 不带 `validate` | `12040106` |

即：带 `Xp-Xid` 只是把错误码从「要求滑块」变成「滑块不通过」，**并不代表票据被真正校验过**——垃圾票据与真票据返回同一个码。所以 `12040106` 不能用作票据是否有效的判据。

`/verification/app/v3/drag/validate` 需要 `{validate, captchaId, type, sceneType}` 四字段才通过反序列化（少 `type`/`sceneType` 报 `12051101 请求参数异常`；四字段齐全但票据无效报 `12051100 操作失败`）；但真票据与垃圾票据在此同样都是 `12051100`，**无法用它验证票据**。

**独立解出的易盾票据不被接受**。用 Chrome + CDP 驱动易盾官方 H5（`cstaticdun.126.net/api/v2/mobile.v2.8.1.html`，`captchaId=f6c14777879d4a75b683b29be6709db6`），按缺口位置拖动、客户端回调 `result=true` 并拿到 531 B 的 `validate`，服务端仍判失败。易盾 check 接口（`c.dun.163.com/api/v1/check`）需要私有密钥才能自验，无法从客户端侧确认票据真伪。结论：**票据绑定服务端会话与轨迹风控，纯脚本生成的轨迹过不了。**

**接口直连下发短信**对任何号码（含真实号码）统一返回 `12051401 短信发送失败`，而 App 界面路径成功——UI 走的是官方 SDK 生成的票据，纯 API 调用无法复现。**自研客户端应复用官方滑块或改用其他登录方式，不要试图绕开。**

**登录是三步，不是一步**。dex 里同时存在 `/verification/app/v5/sms/code`、`/verification/app/v3/sms/validate` 与 `/sso/app/v5/smsLogin`，实测这三步各司其职：

| 步骤 | 端点 | 职责 |
| --- | --- | --- |
| 1 | `POST /verification/app/v5/sms/code` | 发短信，响应 `Set-Cookie: XP-Xid=<uuid>` |
| 2 | `POST /verification/app/v3/sms/validate` | 校验验证码，把通过状态写进会话 |
| 3 | `POST /sso/app/v5/smsLogin` | **只带 `mobile`**，从会话取状态换 token |

**`smsLogin` 不从 body 读验证码**。证据是服务端的字段校验报错：只传 `mobile` 时返回 `12001402 短信验证码错误`（不是「code 不能为空」）；而 `sms/validate` 缺字段会明确报 `code不能为空`、`smsType不能为空`。换 `code`/`smsCode`/`verifyCode` 三种字段名喂给 `smsLogin` 结果完全一致——它根本没看这些字段。

这解释了 2026-10-31 那次失败：App 内发码拿到真码 `1532`，直接喂 `smsLogin` 一律 `12001402`，因为**从未在同一个会话里调过 `sms/validate`**。

`sms/validate` 的必填字段是 `{mobile, smsType, code}`。`smsType` 只要非空即可，`1`/`2`/`11`/`21`/`31` 返回一致（都用假码，统一 `12051403 短信验证码已过期`，说明服务端确实在校验码而非忽略）。会话缺失或过期返回 `12051102 session会话过期`。

`/sso/app/v5/login` 是**密码**登录（缺 `password` 报 `12001101 password不能为空`），不要与短信登录混用。

实现见 `scripts/login.py`。

### 4.2 滑块：两道，一道卡发码、一道卡换 token

**滑块有两道**，此前「滑块只在发码时强制」的结论**已被真号实测推翻**（2026-10-31，见本节末）：第一道卡发码，第二道卡 `smsLogin`。

**发码必须两步**，这是最容易踩的坑：服务端只在**已有会话**的请求里才校验票据。首个请求没有 `XP-Xid`，无论票据真假一律 `12040101 拖动滑块验证码`；但该响应照样下发 cookie，所以要先发一次无票据请求拿到 xid，再带 xid + 票据重试。`scripts/login.py` 的 `send_code()` 已按此实现。

**`12040106` 与票据内容无关**（2026-10-31 实测，**但适用条件有限，见下方警告**）：拿到 xid 后带票据重试，返回 `12040106 滑块验证码校验不通过`。但把这个码与票据内容做交叉验证，发现**换任何值结果都一样**——垃圾值 `zzz`、空串、已用过的票据、刚由真人在浏览器里拖出的 531 B 票据，全部 `12040106`；`captchaId` 传对的、传空的、传 `0000` 也一样；票据放进 `ptoken`/`ticket`/`token` 字段仍一样。

> ⚠️ **警告：上述全部实验都是在「验证码未通过」的会话上做的**（真号实测 2026-10-31 揭示）。这种会话里 `smsLogin` 恒为 `12001402`，服务端**在字段校验之前就返回**，所以任何 body 字段/票据的差异都被掩盖了——「换什么值都一样」是这种掩盖的产物，**不是「服务端不比对票据」的证据**。同理，本节下方「`12040106` 与票据内容无关」的结论**只适用于发码阶段**，不能外推到第二道滑块。

**真人拖的票据同样被拒**（2026-10-31）：`scripts/login-ui.py` 起一个本地页面加载易盾官方 H5 SDK（`cstaticdun.126.net/load.min.js`，`captchaId=f6c14777879d4a75b683b29be6709db6`），由用户在浏览器里亲手拖动，客户端回调 `result=true`、拿到 531 B `CN31_…` 票据，服务端仍判 `12040106`。所以问题不是轨迹风控——**真人轨迹也过不了**。

票据是易盾加密串（`CN31_` 前缀 + base64 变体，解出 381 B 密文），客户端无法自验；易盾 check 接口（`c.dun.163.com/api/v1/check`）需要私有密钥。**目前无法从客户端侧确认票据真伪，也无法解释服务端为何一律拒绝。**

**已排除的可能**：不是会话绑定（同一 xid 内立即用、换新 xid 再用，都是 `12040106`）；不是票据过期（刚拖完立刻用）；不是字段名（三种字段名、加 `captchaId`/`type`/`sceneType` 全试过）；不是 App 用原生 SDK（dex 里只有 `ye.dun.163.com` 的 H5 方案）。

**链路其余部分已验证可达**：`sms/validate` 用假码返回 `12051403 短信验证码已过期`（业务层），`smsLogin` 只带 `mobile` 返回 `12001402 短信验证码错误`（业务层），`v5/login` 返回 `12040107`（业务层）。即只有发码这一处卡住。

**抓 App 真实发码请求的三条路全部失败**（2026-10-31 实测，不要重复尝试）：

| 路径 | 失败原因 |
| --- | --- |
| Frida hook | 易盾反调试在注入后约 15 秒杀掉 App 进程，并连带搞崩过一次模拟器。`spawn` 抢跑能绕过 8 个 `TrustManager` 实现，但 `CertificatePinner` 在握手后另做证书链校验，TLS 仍被拒；且 `okio`/`okhttp3` 类在 App 网络栈初始化后才加载，hook 时机赶不上 |
| mitmproxy | App 自带网络栈，不读系统 `http_proxy`。设代理后 mitm 日志 0 行，App 不发请求；反而因系统代理影响其他组件导致 ANR |
| 读内存/缓存 | `/proc/PID/mem` 被 SELinux 挡住；`http-cache` 里没有易盾配置 |

**结论**：App 用的就是 `cstaticdun.126.net/api/v2/mobile.v2.8.1.html`，与本地页面加载的是同一个 H5，差异不在 SDK 版本。抓真实请求这条路已封死。

#### 易盾官方文档给出的规则（2026-10-31 查证）

二次校验接口是 `POST http://c.dun.163.com/api/v2/verify`（`application/x-www-form-urlencoded`），私有参数 `captchaId`、`validate`、`user`，另有公用签名参数 `version=v2`/`nonce`/`timestamp`/`secretId`/`signature`。

三条关键规则：

1. **`validate` 只能校验成功一次，重复校验返回校验不通过**；有效期默认 20 分钟（可配 1~20 分钟）。——这条对排查极其重要：同一张票据反复试，第二次起必然失败，会把人误导成「票据格式不对」。
2. **`user` 字段必传**，可填空值。
3. `verify` 的错误描述直接指明失败原因：`WRONG_DATA`（过期）、`SDK UNAVAILABLE`（降级票据）、**`ID_NOT_MATCHED`（服务端与客户端 captchaId 不一致）**、`TOKEN DECRYPT ERROR`（validate 不合法）。

客户端错误码表里，`200` 是「校验未通过，业务错误含超限」，`300` 是「校验未通过，含轨迹错误」——**轨迹错误与业务错误是分开的两类**。

**已排除 `ID_NOT_MATCHED`**：全量搜 App 数据目录，`captchaId=` 只出现过 `f6c14777879d4a75b683b29be6709db6` 一个值，与本地页面用的相同。

#### 根因：票据发错了端点（2026-10-31 已解决）

长期卡在 `12040106` 的真正原因不是票据无效，也不是字段名写错，而是**票据被发给了不读它的端点**。

在 `apps.xiaopeng.com` 的 `sms/code` 上，只要 `mobile` + `smsType` 齐全，`validate` 取任何值结果都一样：

| `validate` 取值 | 长度 | 返回 |
| --- | --- | --- |
| 空串 / 空格 / 单字符 | 0~1 | `12040106` |
| 32 位 hex / `CN31_`+假串 | 32 / 105 | `12040106` |
| 真人拖出的真票据 | 531 | `12040106` |
| 5000 字符垃圾 | 5000 | `12040106` |

body 本身是被解析的——乱码 body 报 `12051101 smsType不能为空`，只带 `validate` 报 `12051101 mobile不能为空`。所以服务端读 body，**但 `sms/code` 这个端点根本不看 `validate` 字段**。

#### App 的真实报文（堆快照取证）

用 `am dumpheap` 抓 App 拖完滑块后的堆，直接读到它构造的两个 body：

```
POST https://apps-uc.xiaopeng.com/verification/app/v3/drag/validate
{"sceneType":"SMS","mobile":"…","captchaId":"f6c14777…","validate":"CN31_…"}

POST https://apps-uc.xiaopeng.com/verification/app/v5/sms/code
{"mobile":"…","smsType":"11"}
```

三处关键差异，全是此前没猜到的：

1. **票据走 `drag/validate`，不走 `sms/code`**。后者 body 里没有 `validate` 字段。
2. **滑块场景的字段是 `sceneType:"SMS"`**（字符串枚举），不是 `smsType:"11"`。`smsType` 只属于发码接口。
3. **必须带 `captchaId`**，服务端靠它定位是哪个验证码实例。值 `f6c14777…` 来自 App 运行时内存里的 `NetEaseCaptchaId`，与 H5 页面用的是同一个。

`drag/validate` 成功返回 `{"code":200,"data":{"valid":true}}`；票据无效时是同一个 code 但 `valid:false`——**200 只代表请求成功，判定看 `data.valid`**。这一点曾误导过一次：`code:200` 被当成"通过"。

#### 正确链路（已实现于 `scripts/login.py:send_code`）

1. 建会话：不带票据调 `sms/code`，预期 `12040101`，响应下发 `XP-Xid` cookie。
2. 校验滑块：`drag/validate` 带票据，`data.valid` 为 true 才继续。
3. 发码：同一会话（`Xp-Xid` 请求头）再调 `sms/code`，返回 `200`。

实测：新票据 → `valid:true` → `sms/code` 返回 `200`，短信真实下发。

**票据一次性**：`drag/validate` 成功即消费，重复提交返回 `valid:false`。所以调试时每张票据只能测一次，这也解释了为什么"同一张票据反复试"永远失败。

#### 此前误判的排查记录（供参考）

- 补 `Xp-SDK`/`Xp-DEPENDENCE`/`Xp-Ptoken`/`Xp-PtokenType` 四个头无效。
- xid 放 Cookie 而非请求头会退回 `12040101`（请求头才是正确方式）。
- `smsType` 1~199 扫描：58 个走滑块分支、141 个返回 `12051401 短信发送失败`（连 `abc` 这种非法号码同样报错，是未知场景兜底）。
- `apps-uc` 必须 mTLS（`work/certs/client-cert-0.pem`），且需要完整 `Xp-Authorization` 信封，只用 `probe.signed()` 的外层签名会得到 `12110002`。
- `ID_NOT_MATCHED` 已排除：全量搜 App 数据目录，`captchaId=` 只出现 `f6c14777…` 一个值。

#### 社区与同类项目

- 易盾二次校验必须用 `secretId`+`signature` 走服务端签名，**客户端无法自验票据真伪**。所以本地判断票据是否有效只能靠小鹏的 `drag/validate`。
- XPENG 海外版（`com.xiaopeng.globalcarinfo`）的 Homey 插件用户遇到同样报错「Please verify the slider verification code」，其解法是改用 Google 登录绕开短信滑块。国内版没有这个入口，但绕开滑块的思路与 `v5/login` 的发现方向一致。

**取 token 的现状**：自研侧已可独立发码（滑块由人在本地页面拖一次），后续 `sms/validate` → `smsLogin` 换 token 全程自动。

#### `drag/validate` 的 `sceneType` 白名单与错误码衰减（2026-10-31 静态+探测）

`drag/validate` 对 `sceneType` 做**白名单校验**，且这个校验可以用垃圾票据当探针零成本枚举（未知场景返回 `12051100 操作失败`，已知场景返回 `200` 且 `data.valid=false`，**不消耗票据、不影响会话**）：

| `sceneType` | 结果 |
| --- | --- |
| `LGN` / `SMS` / `RESET` / `REG` / `RESET_PASSWORD` / `CANCEL_ACCOUNT` | `200`，`data.valid` 为判定值 |
| 其余全部（含 `LOGIN`、`SMS_LOGIN`、`REGISTER`、`LOGIN_BY_PWD`、`WECHAT`、`BIND` 等） | `12051100` |

服务端认这 **6** 个场景。`LGN` 是 2026-11-01 从 4.2.0 真实登录流量里补上的——**它就是第二道滑块（`smsLogin` 那道）的场景**，`SMS` 是发码前那道。此前枚举漏了 `LGN`，据此得出的「没有登录专用场景」是错的（见 §4.2「票据通道就是 `drag/validate`，场景必须是 `LGN`」）。

**`12040101 → 12040106` 是调用次数衰减，不是「退化成要滑块」**（对照实验，2026-10-31）：同一会话内**不做任何 drag**，连续调 `v5/login` 三次，结果依次是 `12040101`、`12040106`、`12040106`；先做一次 `drag/validate` 再调，首次仍是 `12040101`。所以 §4.2 此前「反复试探后退化为 `12040106`」的描述方向对，但**归因错了**——它与 `drag` 无关，纯属同一会话内重复调用 `v5/login` 的副作用。这也意味着 `12040106` 依旧不能当票据有效性的判据。

**`v5/login` 的 `12040101` 与 `drag/validate` 无关**：用 5 个白名单场景各开新会话、各拖一次垃圾票，`v5/login` 首调**一律** `12040101`。`v5/login` 既不读 `validate` 字段，也不读 `drag/validate` 写的状态。

**`smsLogin` 同样不读 `validate`**：body 加 `validate`、或加全套 `sceneType`+`captchaId`+`validate`，返回码与只带 `mobile` 完全一致（`12001402`）。

#### 第二道滑块：`smsLogin` 前的独立闸门（2026-10-31 确认存在；**2026-11-01 攻克**）

官方登录是**两道滑块**：滑块 → 短信验证码 → **再滑块**。第一道只管发码，第二道挡在 `smsLogin` 前。

logcat 的调用栈给出确切分工（两轮成功登录均一致）：

| 滑块 | 触发栈 | 说明 |
| --- | --- | --- |
| 第一道 | `LoginBySmsActivity.showDragVerifyCode` ← `LoginSmsPresenter.lambda$sendLoginSms$1` ← `f` | 发码方法 |
| 第二道 | `LoginVerifyActivity.showDragVerifyCode` ← `LoginSmsPresenter.lambda$loginOrRegister$9` ← `h` | 登录/注册方法 |

即 `smsLogin` 返回 `12040101` 后弹滑块，拖完重试 `smsLogin`。会话状态判据（2026-10-31 真号实测确认，三阶段状态机）：

| `smsLogin` 返回 | 会话阶段 | 含义 |
| --- | --- | --- |
| `12001402` | 验证码未过 | 还没调过 `sms/validate`，或验证码错 |
| `12040101` | 验证码已过、待滑块 | 第二道滑块窗口已开，须提交票据 |
| `12040106` | 滑块尝试已消耗 | 未提交票据却重复调用，或票据无效 |

**每调一次 `smsLogin` 就消耗一次滑块尝试机会**，所以同一会话内反复试探会从 `12040101` 退化到 `12040106`——这与 `drag/validate` 无关，纯属调用次数副作用。

##### 票据通道就是 `drag/validate`，场景必须是 `LGN`（2026-11-01 定论）

**上一版「`drag/validate` 不写会话状态、换个 `sceneType` 可彻底排除」的结论被推翻。** 根因是枚举白名单时漏掉了 `LGN`：第二道滑块用的场景是 `LGN`，不是第一道的 `SMS`。

4.2.0（versionCode 8916）真号登录的完整 HTTP/2 流量取证（`SSL_write` + `SSL_read` 双向 hook + HPACK 解码）：

```
[237] POST /sso/app/v3/smsLogin            → {"code":12040101}
[240] POST /verification/app/v3/drag/validate → {"code":200,"data":{"valid":true}}
[246] POST /sso/app/v3/smsLogin            → {"code":200,"data":{"sData":"WEEB…"}}
```

第二道滑块的请求体（明文，非加密）：

```json
{"sceneType":"LGN","mobile":"13000000000",
 "captchaId":"f6c14777879d4a75b683b29be6709db6","validate":"CN31_ciA3VObsg5GyNSVnqOxXaJw*0lia…"}
```

`LGN` 的合法性用垃圾票据零成本复核：`LGN`/`SMS` 返 `200 {"valid":false}`，`LOGIN`/`PWD` 返 `12051100`。**白名单实际是 6 个：`LGN`/`SMS`/`RESET`/`REG`/`RESET_PASSWORD`/`CANCEL_ACCOUNT`。**

上一版实验之所以得出「`drag/validate` 只判定不写会话」，是因为全程用 `sceneType:"SMS"` 提交第二道票据——那是发码前那道滑块的场景，用它提交不会解锁 `smsLogin`。**结论本身没错，但归因错了**：不是端点不写会话，是场景传错。

##### 4.2.0 与 5.19.0 在登录返回上的协议差异

4.2.0 的 `smsLogin` 成功时返回 `{"data":{"sData":"…"}}`，5.19.0 的 `token/refresh` 返回 `accessToken`/`refreshToken` 字段。**但自研侧打 `v5/smsLogin` 同样收到 `sData`**（2026-11-01 实测 `data_keys=['sData']`），说明 `sData` 是**服务端按请求特征下发的**，不是按端点版本区分。

`sData` 结构（3414 B，`XA` 标记、keyIndex=0，与 WEEB 同一套外层布局）：

```
XA | ver | keyIndex@3 | … | iv@47..59 | ct@59..
解开 → 32B 随机 + JSON：
  {"accessToken":"WEEB…1436字符", "refreshToken":"WEEB…1436字符",
   "expiresIn":7200, "refreshExpiresIn":7776000,
   "uid":10000000, "type":0, "skipNickname":0,
   "lastDeviceBrand":"google", "lastDeviceModel":"sdk_gphone64_arm64",
   "lastDeviceUserName":"", "mqttAccount":"{…clientId: xmart:app:<uid>:<di>…}"}
```

内层 JSON 的字段集合与 5.19.0 `token/refresh` 的返回一致，`accessToken` 再解一次才是 968 B JWT。

**解 `sData` 的密钥必须来自服务端当次下发的密钥池，不是本地 tee**（2026-11-01 实测，两次 `InvalidTag` 的根因）：

- `selfclient.keys()` 每次调 `/biz/v5/secure/teeIndiv4App` 取一套密钥池，**请求信封用的就是这套**；
- 服务端加密 `sData` 用的也是同一套；
- 本地 `tee` 里的 `XmartV1LocalKey*` 是设备自己存的另一份，与服务端按 deviceId 下发的不保证同步——用它解就 `InvalidTag`。

另外 4.2.0 与 5.19.0 的 `XTeeSecurityAlias` **RSA 私钥不同**（同一个 keystore 里只有当前安装那一把），拿 4.2.0 安装的 tee 去解 5.19.0 时期的信封同样失败。`unwrap_sdata` 因此以服务端密钥池为主、tee 仅兜底。

##### 端到端打通实录（2026-11-01 01:38，真号）

自研侧完整跑通，一次成功：

```
drag/validate{sceneType:"LGN"} → 200 {"valid":true}
v3/smsLogin                    → 12040101   （v3 仍要滑块，非旁路）
v5/smsLogin                    → 200 {"sData":"…"}   ← 换到 token
sData 解开（用同次密钥池）      → uid=10000000, accessToken/refreshToken 各 1436 字符
AT 再解                         → 968 B JWT
落盘                            → work/live/access_token.txt（1436 字符）
```

**必须同时满足三个条件**，缺一即失败（这正是此前反复卡住的原因）：

| 条件 | 错的样子 | 后果 |
| --- | --- | --- |
| `sceneType` 用 `LGN` | 用 `SMS`（发码那道） | `smsLogin` 恒 `12040101` |
| 换 token 打 `v5`（`v3` 仍要滑块） | 只试 `v3` | `12040101` |
| 解 `sData` 用**同次请求的密钥池** | 用本地 tee / 事后重取 | `InvalidTag` |

**密钥池每次请求都变**（实测连续两次 `teeIndiv4App` 返回的 10 槽全不同），所以「发 `smsLogin` 那次的池」必须与响应绑定保存，事后重取一定解不开。已用「同一 `sData` + 正确池能解开、换一套池报 `InvalidTag`」做了决定性对照。为此 `_call` 全程把 `{请求体, 密钥池, 原始响应}` 落盘到 `work/live/trace/`，`login-ui.py` 另存 `/tmp/last_smslogin.json`。

##### 业务请求的 `Xp-Uid` 必须等于 token 所属账号（2026-11-01 攻克）

换到的 token 打业务接口曾**恒 `12010101 登录状态已过期`**。根因只有一个：**请求头没带 `Xp-Uid`**（或带错）。`Xp-Uid` 参与内层 `xpSign` 计算，必须在算签名**之前**设好。

决定性对照（同一 AT、同一密钥池，只改 `Xp-Uid`）：

| `Xp-Uid` | 返回 |
| --- | --- |
| 不设（`base_headers` 默认 `0`） | `12010101` |
| `10000000`（`sData.uid`） | **`200`**，列出 `L1NSPGH91NA000000 沪A00000 D55` |

所以自研登录链路是**完整可用**的：发码 → 验证码 → 第二道滑块(`LGN`) → `smsLogin` 200 → 解 `sData` → 用 `uid` 打业务接口 200。

**排查过程中被推翻的假设**（都做过对照，别重复）：

1. ~~deviceId 不一致~~：改成与 App 同身份后仍 `12010101`。此改动保留（登录与业务用同一身份更正确），但不是根因。
2. ~~token 没绑设备~~：`smsLogin` 补 `deviceModel`/`deviceBrand` 后 `sData.lastDeviceModel/lastDeviceBrand` 确实回填为 `sdk_gphone64_arm64`/`google`，但当时仍失败。此改动保留（与真机请求体一致），不是根因。
3. ~~内层明文缺字段~~：真机业务请求内层约 2111 B、自研只塞「签名+token」约 1121 B，曾据此判断「缺一批字段」。**实测推翻**——内层只放 `{"xpSign":…}&accessToken=<JWT>` 就够，2111 B 只是真机多塞了 `refreshToken`（两个 968 B JWT 相加 1936 B，加 UUID 与签名正好约 2103 B，长度吻合纯属巧合，不是必要条件）。
4. ~~过期/密钥代际~~：AT 信封时间戳就是请求当时，同次池能解出 1000 B 明文。

**踩坑记录（会直接导致 `12110009`）**：

- `Xp-Uid` 一旦设了值却参与签名不一致，服务端报 `12110009 服务器开小差`（信封解不开），而不是 `12010101`。两种错误码的分界要看 `Xp-Uid` 是否在算 `xpSign` 前设好。
- 密钥池必须**每次请求现取**（`selfclient.keys()`），不能复用上一次的池——池每次调用都变，复用会 `12110009`。

**已确认的其它事实**：

- 登录走 `apps-uc.xiaopeng.com`（要 mTLS），业务接口在 `apps.xiaopeng.com`、`dragon.xiaopeng.com`、`chargegateway.xiaopeng.com`；uc 主机上业务路径直接 404（返回非 JSON），不能用登录通道绕开。
- 4.2.0 登录后实际调的是 `dragon.xiaopeng.com/xp-app/…`（`im/account/init`、`im/famous/list`、`open/get-team-ext`、`open/get-user-lead-status`）与 `chargegateway.xiaopeng.com/v5/charge/private-pile/query`，**没有调过 `myVehicles`**。
- 真机业务请求头带 `XP-Ptoken`（恒定值 `9ca17ae2…`，跨请求不变，与登录阶段逐请求变化不同）。

##### 已排除的假设（2026-11-01 复核后仍成立的部分）

**`xp-ptoken` 不是滑块票据**：同一次会话内每个请求的 `xp-ptoken` 都不同（长度 172/174 浮动、尾部变化），是**逐请求重新生成**的设备指纹类头，不是一次性获取后复用的票据。`drag/validate` 与它前一个 `smsLogin` 的 ptoken 恰好相同（同一请求批次的复用），但下一个 `smsLogin` 又变了。

**`com.netease.nis.wrapper.o` 不是滑块 SDK，是壳的 so 加载器**（2026-10-31 静态复核）：该类全文只有 `System.loadLibrary` / `System.load` + 从 APK 里解 `lib/<abi>/` 落盘再加载的逻辑，与验证码无关。堆快照里它出现，只说明当时触发了某个 native 库的加载（易盾壳自身行为），**不能作为「第二道滑块走 native SDK」的证据**。

**第二道滑块的真实实现仍未知**：既没有证据表明它用 native SDK，也没有证据排除它用 H5。§4.2 上文「App 用的就是 `cstaticdun.126.net/api/v2/mobile.v2.8.1.html`」是全量搜 App 数据目录得到的唯一 captcha H5 地址，两道滑块共用同一份 SDK 仍是更简约的解释——那么第二道失败的原因就落在**票据与场景/会话的绑定方式**上，而不是票据生成机制。

**但滑块 SDK 本身是独立的 `com.netease.nis.captcha` 包，不是壳**（2026-10-31 静态确认，此前文档从未记录）：dex 字符串池里有完整的 `com.netease.nis.captcha.Captcha` / `CaptchaListener` / `Captcha$LangType` 及其内部类 `a`~`d`，配套 `captcha_progress_dialog_layout` 布局、`Captcha Progress Dialog show/dismiss Error`、`Captcha SDK Validate Error`、`Captcha Tip Dialog show Error` 日志串，以及 `onVerifySuccess` / `onVerifyFailed` 回调方法名。

这一点很重要：它说明**易盾滑块是 App 的一个普通依赖库，与加固壳（`com.netease.nis.wrapper`）是两个独立包**。`wrapper` 包是壳（so 加载、`a.auu.a.c` 字符串解密），`captcha` 包才是滑块。两者同属易盾产品线，此前把堆里出现的 `wrapper` 类误读成「第二道滑块用 native SDK」，是把壳当成了滑块。

**`v5/login` 绕不过去**（此前记录的"不需要滑块"结论不足以利用）：它确实从不返回 `12040101`，但要求「该手机号已有成功下发的短信」，且**不认 `verification` 主机的发码**——用 `drag/validate` + `sms/code` 真实发出的短信，`v5/login` 仍返回 `12040102 请输入正确的验证码`。字段分层已确认：缺 `password` → `12001100/12001101`，有 `password` → `12040102`，与 `smsType`（1/2/11/21/31/41）无关。

**`/sso/app/v3/sms/codeForApp` 不可用**：空 body、`mobile`、`mobile+smsType`、加 `captchaId`/`validate`/`sceneType` 全字段，一律 `12001100`，两个主机（`apps` / `apps-uc`）相同。错误码不随字段变化，说明在字段校验之前就失败，该端点当前不接受这些形状的请求。

**堆快照对第二道滑块无效**（重要，别再重复）：请求体与票据都是短命局部变量。`LoginVerifyActivity` 暂停在第二道滑块弹出态时 dump 75 MB，里面**既没有 `CN31_` 票据、也没有任何请求体或 `12040101` 响应**；连拍 12 个快照（主进程 + WebView 各 6 轮，覆盖整个拖动过程）同样一张票据都没抓到。第一道能抓到纯属票据恰好在 dump 时刻尚未提交。

**易盾运行在独立 WebView 沙箱进程**（`com.google.android.webview:sandboxed_process0`），不在 App 主进程堆里。此前「第二道滑块的 native SDK 痕迹在主进程」的说法依赖 `com.netease.nis.wrapper.o`，该依据已作废（见上），故「第二道在主进程」无证据。

**已攻克（2026-11-01）**：第二道滑块的票据通道就是 `drag/validate` + `sceneType:"LGN"`，详见 §4.2。上面这些 2026-10-31 的排查之所以结论为「票据通道未知」，根因是当时只枚举了 5 个场景、漏了 `LGN`，且全程用 `SMS` 提交。堆快照抓不到票据这个观察本身仍成立（票据是短命局部变量），但它不是阻塞点。

#### 第二道滑块的候选通道（2026-10-31 排除法结论）

已知「不是」的：

| 通道 | 排除依据 |
| --- | --- |
| `drag/validate` + 任一 `sceneType`（垃圾票） | 5 个白名单场景全试，`smsLogin` 恒 `12001402`，不写会话 |
| **`drag/validate` + 真票据（`valid=true`）** | **2026-10-31 真号实测：`SMS` 场景返回 `code=200 valid=true`，`smsLogin` 仍 `12040101`，会话未前进。这是最强的一次否定证据——票据真实有效也不够。** |
| `smsLogin` body 里的 `validate`/`sceneType`/`captchaId` | 加上与不加返回码完全一致 |
| `XP-Ptoken` / `XP-PtokenType` 请求头 | 加上与不加返回码完全一致 |
| `sms/validate` 通过后自然放行 | 真号实测：验证码通过后 `smsLogin` 仍返回 `12040101`（见下节） |

**`drag/validate` 已被彻底排除**：它在「验证码已通过」的会话上、用真人拖出的真票据、返回 `valid=true` 之后，`smsLogin` 依然是 `12040101`。所以这个端点**只判定票据、从不写会话状态**，与第二道滑块的票据通道无关。此前所有基于「往 `drag/validate` 提交票据」的尝试可以永久放弃。

由此**尚不能**推出 `12040101` 的成因——但 2026-10-31 的真号实测给出了定论（见下节）。

#### 真号实测：第二道滑块确实存在，且是 `smsLogin` 的强制闸门（2026-10-31 定论）

**实测过程**（真实在网号 `130****36`，`scripts/login-ui.py`，一次完整流程）：

1. 第一道滑块人工拖过 → `drag/validate` 返回 `data.valid=true` → `sms/code` 返回 `200`，短信真实下发（xid=`be3b086c…`）
2. 真实验证码经 `sms/validate` **校验通过**
3. `smsLogin` 返回 **`12040101 拖动滑块验证码`**
4. 未拖第二道滑块、再点一次 → `sms/validate` 返回 `12051403 短信验证码已过期`（一次性验证码已被消费）

**结论：H2 成立，H1 被推翻。** 第二道滑块不是「号码状态异常才出现」的风控分支，而是**验证码通过后 `smsLogin` 的必经闸门**。此前「`12040101` 按号码判定、真实号可绕过」的推论**错误**，作废。

**为什么之前的号码对照实验误导了判断**：那次实验在**未发码**的会话上观测 `v5/login`，编造号码返回 `12040101`、真实号码返回 `12040102`。现在回看，这个差异反映的是「该号码能否进入验证码环节」，**不是**「验证码通过后是否需要滑块」。两者是不同阶段的两个闸门，混为一谈才得出「真实号不需滑块」的错误结论。

**`12040106` 的真实含义（修正）**：此前记为「与票据内容无关、缺前置条件直接判失败」。真号实测显示，`12040106` 出现在**验证码已通过、但第二道滑块未提交**的会话上（第 4 步之后该会话的 `smsLogin`/`v5/login` 均返回 `12040106`）。即：`12001402` = 验证码未过；`12040101` = 验证码已过、待滑块；`12040106` = 滑块窗口已开但票据未通过/已失效。**三个码是同一状态机的三个阶段**，这解释了此前「同一会话内重复调用就退化」的现象——每调一次就消耗一次滑块尝试机会。

**对自研客户端的直接影响**：登录链路在 `smsLogin` 前**必须**提交第二道滑块的票据，且该票据：
- ~~不是 `drag/validate` 的返回~~ **此条已推翻**：当时用 `sceneType:"SMS"` 提交，场景传错。改用 `LGN` 后 `drag/validate` 返回 `valid:true` 即解锁 `smsLogin`（§4.2）。
- 不接受 `smsLogin` body 里的 `validate`/`sceneType`/`captchaId`（已实测，返回码不变）——仍成立
- 不接受 `XP-Ptoken` 请求头（已实测，返回码不变）——仍成立

第二道滑块已于 2026-11-01 攻克，通道是 `drag/validate{sceneType:"LGN"}`。

#### 票据通道的排除法已到尽头（2026-10-31 静态收敛）

本轮把「客户端能提交什么」穷举完了，结论是**第二道滑块的票据不是通过任何独立端点或明文字段提交的**：

**证据一：`/verification/` 下只有 7 个端点，全在 dex 里，全部已试过。**

| 端点 | 状态 |
| --- | --- |
| `/verification/app/v5/sms/code` | 已用（第一道滑块后的发码） |
| `/verification/app/v3/drag/validate` | 已用（只判定，不写会话，真票据 `valid=true` 也不推进） |
| `/verification/app/v3/sms/validate` | 已用（校验验证码） |
| `/verification/app/v3/sms/validateByUid` | 需登录态，返回 `12010103` |
| `/verification/app/v3/sms/validateByUidAndMobile` | 同上 |
| `/verification/app/v5/sms/codeByUid` | 同上 |
| `/verification/app/v5/sms/codeByUidAndMobile` | 同上 |

**不存在第二个滑块验证端点**。所以第二道滑块的票据不可能通过独立端点提交。

**证据二：`smsLogin` 不读任何票据字段。** 穷举 20 个候选字段名（`validate`/`ptoken`/`token`/`ticket`/`riskToken`/`captchaValidate`/`dragValidate`/`validateToken`/`captchaToken`/`slideToken`/`verifyToken`/`sceneType`/`captchaId`/`smsCode`/`code`/`sign`/`risk`/`riskControlInfo`/`validateResult`/`dragResult`），**全部返回 `12001402`，无一差异**。

这个探测的有效性已单独验证，不是被掩盖：
- 故意破坏信封密钥 → 返回 `12110009`（信封层校验先于业务层，说明信封层是通的）
- body 缺 `mobile` → 返回 `12001101 mobile不能为空`（**字段探测能穿透到业务层**）
- 所以 `12001402` 是真正的业务判断，不是掩盖

**证据三：`XP-Ptoken`/`XP-PtokenType` 等请求头无效**（`12001402` 不变）。

~~**由此收敛出的唯一可能**：第二道滑块的票据由 native 层加密后塞进 `Xp-Authorization` 信封本体……~~ **此推断已推翻（2026-11-01）**：票据就是易盾 H5 的 `validate` 字符串，明文 JSON 提交给 `drag/validate` 即可，场景必须是 `LGN`（§4.2）。当时代码里没有 native 加密这一环，缺的只是正确场景。

**尚未排除的两个客户端可控通道**（都不需要重新实现 native 加密）：

**(a) 旧版本 `smsLogin` 端点。** 全版本扫描发现 v3/v4 的 `smsLogin` **仍然可用**：

| 端点 | 返回 | 判断 |
| --- | --- | --- |
| `/sso/app/v3/smsLogin` | `12001402 短信验证码错误` | 可用，要求 `mobile` |
| `/sso/app/v4/smsLogin` | `12001402 短信验证码错误` | 可用，要求 `mobile` |
| `/sso/app/v5/smsLogin` | `12001402 短信验证码错误` | 可用，当前 App 在用 |
| `/sso/app/v1|v2|v6|v7/smsLogin` | `12001100 操作失败` | 不存在 |

关键佐证：**dex 字符串池里只有 `v5/smsLogin`**，说明 v3/v4 是服务端保留的旧路由、App 从不调用。旧版实现**可能没有第二道滑块**——若成立，直接就是绕行入口。

**(b) 信封内层明文。** 已知 `accessToken`/`refreshToken` 就是以 `&accessToken=…` / `&refreshToken=…` 追加在信封内层明文末尾的（§4.4、§4.6），票据可能是同样形式。已验证该通道技术上可用（内层追加任意字段后信封仍正常解开，返回 `12001402` 而非 `12110009`）。

这两条都**未在「验证码已通过」的会话上试过**——那是唯一还有信息量的实验，成本一条短信。

**下一轮按优先级**：
1. 在「验证码已通过」的会话上，依次试 v3/v4 端点与内层明文字段。**最后一个低成本假设，一次短信可测完两个。**
2. 从 native 层 hook 第二道滑块提交时的出站请求（需对抗易盾反调试，§6.3 记录 Frida 约 15 秒被杀）。
3. 脱壳后读 `LoginSmsPresenter.loginOrRegister` 与 `RiskService.verifyDragValidate` 的字节码。

若第 1 条也失败，即可判定票据完全在 native 层，只有 2、3 两条路。

**第 1 条已实现待跑**（2026-10-31）：`scripts/login.py` 的 `try_second_drag()` 现在按序试 **v3 端点 → v4 端点 → 内层 `validate`/`ptoken`/`captchaValidate`**，一命中即返回 `(trials, data)`；`_call()` 新增 `inner_extra` 参数用于追加内层明文。已离线验证：内层追加字段不破坏信封（返 `12001402` 而非 `12110009`），且整条探测链路在真实会话上跑通（5 次尝试全执行，返回结构正确）。`scripts/login-ui.py` 的第二道滑块步骤直接调用它，**下一轮只需一条真实短信即可判定两个假设**。

#### 另一条独立入口：运营商一键登录 `oneclickLogin`（2026-10-31 新发现）

dex 里存在完整的运营商一键登录栈与端点，**完全不经短信、不经任何滑块**：

| 项 | 值 |
| --- | --- |
| 端点 | `POST /sso/app/v3/oneclickLogin`、`/sso/app/v4/oneclickLogin` |
| 必填字段 | `accessCode`、`token`（缺任一报 `12001101 xxx不能为空`） |
| 业务层返回 | 垃圾值 → `12001283 一键登录操作已过期，请重试` |
| 客户端来源 | `com.cmic.gen.sdk`（移动）、`com.unicom.online.account.kernel`（联通）、`ctGetToken`（电信）；取号方法 `cmGetToken`/`cuGetToken`/`ctGetToken`，`*PrefetchMobileNumber` |

**关键点**：`accessCode`/`token` 由运营商 SDK 在**本机 SIM 卡**上换取（运营商网关侧鉴权），与易盾、与小鹏的风控画像都无关。若该入口对小鹏侧开放，则它绕开了短信验证码与两道滑块——**是比攻克第二道滑块更短的一条路**。

**待验**：`12001283` 对任意非空值恒定，说明服务端在**验签/解密前**就按「取号会话不存在」失败，无法从错误码判断格式。真正的判别需要一次真实取号：在有 SIM 卡的设备上跑运营商 SDK 拿 `accessCode`+`token`，再打该端点。**这条需要真机 + 真实 SIM，不能在模拟器上做**（模拟器无运营商网关鉴权能力）。

**风险**：单会话约束同样适用——若该入口可用，自研客户端一键登录会把官方 App 踢下线。

#### 端点版本矩阵（2026-10-31 全版本扫描，只读、编造号码）

对两个关键端点扫 v1~v7，确认只有 v3 是 `drag/validate` 的真实入口，`smsLogin` 只有 v3/v4/v5 存在：

| 版本 | `drag/validate` | `smsLogin` |
| --- | --- | --- |
| v1 | `12051100` | `12001100` |
| v2 | `12001216 无效的appId或签名数据` | `12001100` |
| v3 | **`200` + `data.valid`** | **`12001402`**（业务层） |
| v4 | `12051100` | **`12001402`**（业务层） |
| v5 | `12051100` | **`12001402`**（业务层） |
| v6 / v7 | `12051100` | `12001100` |

判据：`12001100 操作失败` 与 `12051100 操作失败` 是「路由未命中」兜底，业务层错误码（`12001402`）才表示端点真实存在并进入逻辑。**结论：不存在更高版本的无滑块登录入口**，v4/v5 的 `smsLogin` 行为与 v3 完全一致，版本矩阵这条路已穷尽。

`drag/validate` 的 `sceneType` 白名单为 `{LGN, SMS, RESET, REG, RESET_PASSWORD, CANCEL_ACCOUNT}`（垃圾票据即可枚举）。**`LGN` 就是第二道滑块（`smsLogin` 那道）的场景**，2026-11-01 从 4.2.0 真机流量补上；此前枚举漏了它，据此得出的「没有登录专用场景」是错的。

### 4.3 为什么 MITM 抓不到 `apps*.xiaopeng.com`

**不是证书固定，是私有 CA 信任锚**。`apps*.xiaopeng.com` 的证书由 `CN=Xiaopeng Motors Intermediate CA`（`O=XiaopengMotors Ltd`）签发，而 `collect.xiaopeng.com`、`sentry.xiaopeng.com` 用 DigiCert RapidSSL。

模拟器系统 CA 装好后（`scripts/emu-ca.sh`，tmpfs 挂载进 `/apex/com.android.conscrypt/cacerts`），实测 `collect`/`sentry` 能正常解密，`apps*` 一律 `Client TLS handshake failed ... does not trust the proxy's certificate`。系统信任库对 DigiCert 主机生效，说明 CA 安装本身没问题；App 对 API 主机另有一套信任锚，指向自家私有 CA。

这也修正了 §2.7 的旧结论：当时看到 `network_security_config` 里没有 `<pin-set>` 就判定「没有 pin」，但私有 CA 信任锚不需要写 pin-set，照样让系统 CA 失效。

### 4.4 令牌结构

登录成功后，token **不在 HTTP 头里**，而在内层明文末尾：

```
UUID + base64({"xpSign":"…"}) + "&accessToken=" + JWT(968 B)
```

post-login 的 canonical 头集合与登录前不同：出现 `XP-UID`，且 `appVersion`/`brand`/`deviceModel`/`osVersion`/`versionCode` 改为小写形式，另加 `XP-OTA-DATA-WITH-OBJECT-VALUE=1`、`XP-OTA-DATA-WITH-VERSION=1`；`XP-TEE-ID`、`XP-PTOKEN` 不再作为独立头出现（TEE 值仍嵌在 `Xp-Authorization` blob 内）。

### 4.5 令牌寿命

JWT 解三段：

```
段0 header : {"type":1,"version":"1.0.0","alg":"HS256"}   42 B
段1 payload: {"sub":"VHtIXjG5...（650 B 密文）"}          650 B
段2 sig    : 32 B
```

**payload 里只有 `sub`，没有 `exp`/`iat`/`nbf`。** 所以「2 小时」完全来自响应里的 `expiresIn=7200`，是给客户端用的建议值，不是服务端强制的失效点。

实测（签发时刻 10-29 22:29:06）：

| 时刻 | 年龄 | `/biz/v5/vehicle/v2/myVehicles` |
| --- | --- | --- |
| 00:29 | 2.00 h | 200（声明值刚到期） |
| 01:00:54 | 2.53 h | 200（最后一次有效采样） |
| 01:03:20 | 2.57 h | `12010101 登录状态已过期` |

**真实寿命 2.53 ~ 2.58 小时，比声明值宽约 33 分钟，倍率约 1.28×。**

失效是**硬边界**：跨过之后所有业务接口统一返回 `12010101`，没有降级、没有只读。宽限期不能当余量用。

**一个必须记住的坑**：`12010101` 同时表示「过期」与「被新登录顶掉」（单会话约束）。两者错误码相同，靠文案无法区分，只能靠本地记录的签发时刻判断。

### 4.6 续期（已闭环）

`POST /sso/app/v3/token/refresh`，`refreshToken` 放在**内层明文**里（`…&refreshToken=<值>`），放 body 无效（报 `12010203`）。

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `expiresIn` | 7200 | accessToken 2 小时（建议值） |
| `refreshExpiresIn` | 7776000 | refreshToken 90 天，**滑动续期** |

**端到端验证（连续 5 次）**：

```
refresh  → code 200，accessToken/refreshToken 均为 1436 字符 WEEB
解开     → 各得 968 B JWT（keyIndex 直接索引 XmartV1LocalKey*）
业务请求 → /biz/v5/vehicle/v2/myVehicles 返回 200
```

**结论：一次登录后，只要 refreshToken 不过期（90 天滑动），就能无限续期，不再需要人工登录。**

**两个硬约束**：

1. **输入必须用 eyJ，返回的 WEEB 不能回灌**：同一个 `eyJ…` refreshToken 可反复使用；但响应里返回的 `WEEB…` 若当作下一次输入会立刻 `12010204`。
2. **高频调用会废链**：十几次后返回 `12010202`，该 RT 永久失效。**这是最容易犯的错——反复调 refresh 会把整条令牌链作废。**

**实现**：`scripts/renew.py`

```
pixi run -e rev python scripts/renew.py status   # 查当前 token 是否可用
pixi run -e rev python scripts/renew.py renew    # 续期并保存
pixi run -e rev python scripts/renew.py auto     # 快过期才续期
```

token 落在 `work/live/{access,refresh}_token.txt`（0600），不进版本库。

### 4.7 token 与 deviceId 绑定（2026-10-31 实测）

**现象**：App 内登录成功、界面显示已登录（车主「杰尼」/ G6），`unseal-token.py` 解出 968 B token，但 `renew.py status` 返回 `12010104 登录状态已过期，请重新登录`，`renew.py renew` 返回 `12010204`。

**诊断**：空 token 返回 `12010103`，真 token 返回 `12010104`。**两者不同就证明信封解开了、token 被读到了**，纯粹是身份对不上——不是签名问题、不是信封格式问题、不是 token 过期。

**根因**：`deviceId` 存在 `shared_prefs/device_id.xml.xml`（键 `device_id`），**App 每重装一次就换一个**。`work/local.env` 里的 `XP_DI` 还是上一次的 `00000000…`，而当前是 `00000000…`。用旧 DI 签名，服务端认为这份 token 不属于该设备。

**修复**：`unseal-token.py` 增加 `sync_device_id()`，每次解 token 前从模拟器读当前 deviceId 并写回 `work/local.env`。修复后 `renew.py status` 直接 `code:200` 并列出车辆。

**排查顺序**（下次遇到「token 解出来却失效」按此走）：先比空 token 与真 token 的错误码——不同则查 deviceId，相同才是 token 本身的问题。

### 4.8 单会话约束

同一账号同时只允许一个有效会话，自研 App 登录会把官方 App 踢下线。已在真实账号上触发过一次，**尚未找到共存办法**。

### 4.9 重新登录后解出的 token 仍失效——MMKV 追加写陷阱（2026-10-30 定位并修复）

**现象**：用户退出并重新登录后，`unseal-token.py` 解出的 accessToken 尾部不变（`ou-tBUvxONOK0SaI`），`renew.py status` 返回 `12010101 登录状态已过期`，`renew.py renew` 返回 `12010201`。App 自身却工作正常。

**误判过程（本应避免）**：一度怀疑 token 存在别处、试图从 `/proc/PID/mem` 捞明文（读 `I/O error`，SELinux `u:r:su:s0` 下受限）、试了 `vehicle/list`、`queryList` 等错误路径。文档 §4.6 已写明续期闭环，正确做法是先读文档再排查。

**真正根因**：`tee` 文件里 `accessToken` 出现 **4 次**（offset 1177 / 4428 / 7742 / 7835），`refreshToken` 也 4 次。MMKV 是**追加写**，同一个键会留下多份历史值，**最新的在最后**。而 `unseal-token.py` 的 `mmkv_read` 用 `buf.find(name)` 取**第一次**出现，读到的是登录前那份已失效的旧 token。

**修复**：`mmkv_read` 改用 `buf.rfind(name)`。修复后 `unseal-token.py --save` 直接解出可用 token（尾部 `krpa3tcNOoNt89Bo`），`renew.py status` 返回 `code:200` 并正确列出车辆 `<VIN> <车牌> D55`。

**判据**：判断解出的 token 是否最新，看 `unseal-token.py` 输出的 token 尾部是否随重新登录而变化。不变即说明读到的是历史值。

**教训**：MMKV 读取必须按「最后一次出现」取值；任何基于 `find()` 的 MMKV 解析都存在读旧值的风险。

---

## 5. 车控通道（MQTT）

### 5.1 为什么是 MQTT 不是 REST

dex 里有 50 个 `/sp-vowner-mapp/p/api/rvc|ac|charge|bt|nfc/*` 路径，但对**所有候选主机**（`apps`、`apps-biz`、`apps-uc`、`apps-booster`、`xmart`）请求，无论真路径还是假路径，一律返回**空响应体**；同一主机上 `/biz/v5/nonexistent/x` 会明确返回 `11001105 Handler Not Found`。假路径与真路径表现一致，说明该前缀在这些网关上根本没有路由。

真正的通道在运行时堆里：`com.xiaopeng.link.mqtt.MqttClient`、`MqttConstant`、`sendVehicleMsgAsync`、`cmdId:1793275968829-11`、`cmdQueue.size:0`。点「闪灯」后堆里新增的正是 MQTT 报文，而不是任何 HTTP 请求。

**60+ REST 路径组合全部 `Handler Not Found`；全内存扫描只有 11 条 `/biz/` 路径且无车控相关。车控不走 REST。**

### 5.2 连接与凭据

`POST /biz/v5/mqtt/createMqttAccount/app`（需账号 token）返回：

```json
{
 "clientId": "xmart:app:<uid>:<deviceId>",
 "username": "xmart:app:<uid>:<deviceId>",
 "password": "<每次不同>",
 "serverSsl": "iot-app.xiaopeng.com:8883",
 "expireTime": 1793961437564
}
```

broker **只校验 username/password**，clientId 任意（实测换包名后缀、去掉后缀均可连上），因此监听时用独立 clientId 不会把 App 挤下线。

**`expireTime` 的 7 天是假的**：AT 失效后立即用同一份凭据（`expireTime` 还剩 7 天）连接，返回 `connack rc=Not authorized`。`expireTime` 只是上限，服务端在 AT 会话失效时连带作废 MQTT 凭据。**每次调用该接口会作废旧凭据。**

### 5.3 主题

| 方向 | 主题 |
| --- | --- |
| 上行（App→车） | `Xmart/Send/User/<uid>` |
| 下行（车→App） | `Xmart/Msg/User/<uid>` |
| DiDi 通道 | `Mona/Send/User/<uid>`、`Mona/Msg/User/<uid>` |
| 推送 | `Xp/Msg/Push/<deviceId>` |

### 5.4 报文格式

`msg_content` 是 **JSON 字段**，不是字符串拼接。唯一可用格式：

```json
{"protocol_ver":"2.0","target_id":"<VIN>","msg_id":"10<uid><ts><2位>",
 "msg_type":2,"service_type":12,"msg_content":{"cmd_type":4,"cmd_value":1}}
```

- `msg_id` = `"10"` + uid(8) + 毫秒时间戳(13) + 2 位随机数 = 25 位。
- `msg_type:2` 是请求；`msg_type:4` 是心跳/注册，不带 `msg_content`。
- **回执机制**：请求带 `msg_id`，回执带 `msg_ref` 与之对应，可直接配对。`msg_type:1` 表示事件/响应。

### 5.5 `service_type` 语义表

| service_type | 含义 | 已验证指令 |
| --- | --- | --- |
| 1 | 心跳/空操作，任意 `cmd_type` 都返回成功 | 无实际作用 |
| **3** | **空调** | ✅ `{"cmd_type":1,"cmd_value":0/1}` 开关、`{"cmd_type":2,"cmd_value":N}` 设温度、`{"cmd_type":4}` 读状态 |
| **5** | **灯光** | ✅ `{"cmd_type":1,"cmd_value":1}` 闪灯 |
| **8** | **哨兵模式** | ✅ `{"action":1}` 读设置；`{"action":2,"settings":[{"code":"SENTINEL_MODE_VIDEO","value":1/0}]}` 开关哨兵；同格式写 `SENTINEL_MODE_SENSITIVITY` 改灵敏度 |
| **9** | **门锁 / 车身** | ✅ `{"cmd_type":0}` 解锁、`{"cmd_type":1}` 锁车 |
| 11 | 远程查看摄像头 | ⚠️ `{"cmd_type":1,"cmd_value":0}` 只读（回 `camera_status`/`camera_360`/`live_push_status`），开流与视角切换未打通 |
| **12** | **车窗 + 遮阳帘** | ✅ `{"cmd_type":4,"cmd_value":0/1}` 遮阳帘、`{"cmd_type":1,"cmd_value":2/1}` 全车车窗降/升 |
| 19 | 车辆状态 | ✅ `cmd_type:0/1/2` 只读 |
| 22 | 预约 | ✅ 只读，`function`/`action` |
| 29 | 未知，仅回 `code:200` 空体 | ⚠️ 无数据 |
| 26/28 | 驻车、哨兵状态 | ⚠️ 主动请求无响应 |
| 31–70 | 全部不支持 | — |

### 5.6 已打通的十三条指令

| 动作 | 请求 `msg_content` | `service_type` | 回执关键字段 |
| --- | --- | --- | --- |
| 解锁车门 | `{"cmd_type":0}` | 9 | `driver_door_lock_st: 0` |
| 锁车 | `{"cmd_type":1}` | 9 | `driver_door_lock_st: 1` |
| 闪灯 | `{"cmd_type":1,"cmd_value":1}` | 5 | `dipped_headlight_status: 1` |
| 遮阳帘开/关 | `{"cmd_type":4,"cmd_value":1/0}` | 12 | `sky_sun_shade_position: 1/0` |
| 空调开/关 | `{"cmd_type":1,"cmd_value":1/0}` | 3 | `hvac_on: 1/0` |
| 设温度 | `{"cmd_type":2,"cmd_value":<整数℃>}` | 3 | `hvac_temp: N` |
| 全车车窗降/升 | `{"cmd_type":1,"cmd_value":2/1}` | 12 | 四个 `*_window_position` 100↔91 |
| 极速降温 | `{"cmd_type":6,"cmd_value":1/0}` | 3 | `hvac_quick_cool_mode:1/0`、`hvac_temp:18`、`wind:10` |
| 极速升温 | `{"cmd_type":8,"cmd_value":1/0}` | 3 | `hvac_quick_warm_mode:1/0`、`hvac_temp:32`、`wind:8` |
| 高温抑菌 | `{"cmd_type":9,"cmd_value":1/0}` | 3 | `hvac_high_temp_mode:1/0`、`hvac_temp:32`、`wind:10` |
| 鸣笛 | `{"cmd_type":1,"cmd_value":1}` | 6 | `code:200`（无状态字段，需人耳确认） |
| 哨兵开/关 | `{"action":2,"settings":[{"code":"SENTINEL_MODE_VIDEO","value":1/0}]}` | 8 | `instant.ext.soldier_camera_status` 1/0 |
| 哨兵灵敏度 | `{"action":2,"settings":[{"code":"SENTINEL_MODE_SENSITIVITY","value":1/2/3}]}` | 8 | 回执 `settings[]` 里同名项 |

哨兵 2026-10-31 09:57 实测（带对照组）：`SENTINEL_MODE_VIDEO` 写 1 → `soldier_camera_status` 0→1；写 0 → 1→0，两次都回 `code:200` 且 `settings[]` 原样回显。**`settings` 按键名匹配，与数组顺序无关**——把首元素写成不存在的 `ZZ_BOGUS`、第二元素写 `SENTINEL_MODE_SENSITIVITY:2`，灵敏度仍正确落到 2；不认识的 `code` 被静默忽略，不报错也不改任何项。**`settings[]` 里没有开关位**，哨兵是否开启只能读 `st=19` 的 `instant.ext.soldier_camera_status`（1=开、0=关），不能从 `st=8` 的回执判断。

`st=8` 的 `action` 只有 1（读）和 2（写）有效；`action:0/3..10` 一律 `code:8`。`SENTINEL_ACTION` 作为 `settings` 的 `code` 写入会被静默忽略（不改变任何状态），说明开关不是通过这个键暴露的。

车窗 2026-10-30 18:40 实测：`ct=1 cv=2` 四窗 100→91（`code:200`），`ct=1 cv=1` 四窗 91→100（`code:200`）。**只接受 `cv=1/2`**，`cv=0/3/4/5` 一律 `code:8`。四窗同值联动，是「一键全车」，不能单独控制某一扇；`cv=2` 降到的 91 是通风位而非全开，与 App 内「把全部车窗降下一点点」的行为一致。**不需要车辆上电**，下电状态同样有效。

三个「模式」通道 2026-10-30 18:50 实测，都是 `cv=1` 开、`cv=0` 关：

| cmd_type | 开启回执 | 关闭回执 |
| --- | --- | --- |
| 6 极速降温 | `quick_cool_mode:1`、`temp:18`、`wind:10` | `on:0` |
| 8 极速升温 | `quick_warm_mode:1`、`temp:32`、`wind:8` | `quick_warm_mode:0` |
| 9 高温抑菌 | `high_temp_mode:1`、`temp:32`、`wind:10` | `high_temp_mode:0` |

`cv=2/3` 一律 `code:8`。三者执行后空调都处于开启态，需补 `ct=1 cv=0` 关闭。

**风量控制：官方 App 没有这个功能，不需要打通（2026-10-30 19:55 用户确认）**。`ct=3/5/10` 三个通道无回执、状态也不随 `cmd_value` 稳定变化，实测连发同一 `cv=3` 虽能把风速从 1 变 2，但 `cv=1/2/4/5` 结果全同，且 `hvac_auto` 始终为 1——**手动调风速本应打破 auto 模式**（用户确认的产品行为），auto 没被打破说明这些通道没有真正执行手动风速。结论：`ct=3/5/10` 与风量无关，风量在 App 侧不存在对应 UI，故不再排查。

**方法学教训**：空调是动态系统，`hvac_auto:1` 时会自行调节风速。用「前后状态不同」推断指令生效会产生假阳性；必须先用对照组（不发指令连读三次）确认观测稳定，再用实验组（连发同一 `cv` 三次）确认可重复。

`st=3` 还有三个**被路由但当前不可用**的通道：

| cmd_type | 回执 | vdex 对应方法名 |
| --- | --- | --- |
| 11 / 12 | `10330 智能清洁暂不可用` | `OpenACClean`、`openAirClean` |
| 13 | `10338 智能除味开启失败` | `OpenDeodorization`、`CloseDeodorization` |
| 14 | `10342 空调香氛通道调节失败` | `OpenFragrance`、`CloseFragrance` |

这些码是语义错误而非「不支持」，说明功能存在，只是参数结构或车辆配置不满足。`ct=10` 无回执，疑为除霜但未确认。

空调三条 2026-10-30 18:00 实测：`ct=1 cv=1` → `hvac_on:1`；`ct=1 cv=0` → `hvac_on:0`；`ct=2 cv=26` → `hvac_temp:26`。字段名就是 `cmd_value`，不需要别的包装。

**设温度会顺带开机**：`ct=2` 执行后 `hvac_on` 变成 1，所以「改温度但保持关闭」做不到，必须补一条 `ct=1 cv=0`。

**空调通道对车辆状态敏感**：车辆处于异常状态（例如刚被不完整的指令打断）时，`st=3` 会返回 `10302 空调关闭失败` / `10303 设定温度失败` / `10306 调控风量失败`，甚至连回执都没有。此时官方 App 同样失败，不是客户端问题。等车辆下电休眠（锁车）后通道自行恢复。

`service_type:9` 的回执同时带 `temp_lock_st`、四个车门 `ajar_st`、`trunk_ajar_st`、`driver_door_lock_st`、`rear_right_door_ajar_st`。

**注意**：`service_type:9 / cmd_type:0` 是**解锁动作**，不是状态查询。要只读门锁状态需用 `cmd_type:3`（返回「车辆已下电，临停不可用」时说明该通道要求车辆上电）。

**临停（`st=9 ct=3`）待补**：App 首页「临停」按钮即此功能。2026-10-30 22:00 在车辆下电状态下请求，返回 `{"code":10905,"msg":"车辆已下电，临停不可用"}`——**这是前提条件不满足，不是通道不存在**。该通道要求车辆处于上电/通电状态，等有上电机会时补测完整语义（`cmd_value` 取值与回执字段）。同理 `st=9 ct=4/5` 在 10-30 19:08 的测试中无回执，也可能受同一前提限制，需在上电状态下重测。

**后备箱开关不在 MQTT 通道（2026-10-30 22:05 定论，10-31 用户确认）**：App 操作后备箱时提示「蓝牙未连接」，必须连蓝牙才能操作。同时 `CallbacksManagerV1` 的完整回调类清单只有 4 个——`CarCameraControlCallback`（摄像头 st=11）、`CarDoorLockControlCallback`（门锁 st=9）、`CarWindowControlCallback`（车窗 st=12）、`PowerControlCallBack`（电源），**没有任何后备箱回调**。REST 侧 `/sp-vowner-mapp/p/api/rvc/v2/openTrunk` 在 `apps-booster`（唯一要求 mTLS 的主机）上返回 `Content-Length: 0`，与其他 `/sp-vowner-mapp/*` 表现一致。结论：后备箱开关走 **DiDi Davinci 数字钥匙 BLE** 的 `CarService.OpenTrunk` / `CloseTrunk`，与 `startCar` 同属一类，不在云端 MQTT 体系内。

**自研客户端要实现后备箱开合，只能复用 §6 的数字钥匙栈**，无法用 MQTT 补。10-31 09:52 的监听复核（点「后备箱」→ 确认弹窗 → 取消，全程零下行报文）与本结论一致，但该次未点「确定」，因此报文层面的最后一步仍是 App 侧提示与代码结构的证据，不是抓包证据。

**注意区分两个「后备箱」**：`trunkPower`（`powerSwitch`、`timeToPowerOffInMin`）是**后备箱 220V 供电**，由 `handlerTrunkPower` 承载、走 MQTT；与开合箱门是两回事，后者走 BLE。用户明确只要箱门开合。

**「解锁并启动」的真实语义（2026-10-30 22:35 用户实测厘清）**：它**不是**点火，也**不点屏**。实测三项事实：

1. 「仅解锁」与「解锁并启动」都会解锁车门，但都不点亮大屏；
2. 区别在 `remote_start_status`——「解锁并启动」把它从 `0` 置为 `1`，App 首页「远程启动」图标随之点亮并显示 **120 秒倒计时**；「仅解锁」保持 `0`；
3. 两者 `car_igon_state` 都保持 `0`，即车辆未点火。

所以它是**解锁车门 + 打开远程启动授权窗口（120 秒）**，面向「身上没带实体钥匙」的场景：窗口内踩刹车挂挡即可开走。用户此前的车「解锁后就能启动」是因为**实体钥匙一直放在车内**，与 `remote_start_status` 无关。

**判据修正**：判断「远程启动是否被打开」只能看 `st=19` 的 `instant.power.remote_start_status`，**不能用 `car_igon_state`**。

**已确认的子动作**：解锁车门 = `st=9 ct=0`（已打通）；「打开远程启动」这一步的 MQTT 指令**仍未找到**——2026-10-30 22:08 与 22:20 两次全程录音（订阅 `Xmart/Msg/User/<uid>`）里，用户真实执行「解锁并启动」时只录到 `st=9`（解锁回执）与 `st=19`（状态推送，其中 `remote_start_status` 变为 1），**没有任何独立的启动指令报文**，说明该指令不经这个下行主题。

2026-10-31 09:58 补一次受控实测（带前后对照）：`st=9 ct=0` 解锁前 `remote_start_status=0`，解锁回执 `driver_door_lock_st: 0` 后立刻读 `st=19`，`remote_start_status` **仍为 0**。这排除了「解锁报文本身就带启动」的猜想——同一个云端通道在「仅解锁」与「解锁并启动」两种 App 操作下发出的是同一份 `st=9 ct=0`，区别只能来自 MQTT 之外的通道。结论：**「解锁并启动」在云端 MQTT 侧不存在，走 BLE**（`CarService.startCar`，见下条）。

**启动车辆不在 MQTT 通道（2026-10-30 19:15 定论）**：App 首页「远程启动」点击后弹「请在2分钟内踩下刹车并挂挡」，说明它只做**上电 + 解除防盗**，挂挡仍需人工。该动作走**蓝牙数字钥匙 SDK**，不在云端 MQTT。

证据：`com.didi.davinci.digitalkey.mona.CarService` 的完整方法清单里含 `startCar`、`unLockCar`、`lockCar`、`foldMirror`/`unfoldMirror`、`openSentryMode`/`closeSentryMode`、`openProtectMode`/`closeProtectMode`、`operateCamera`、`awakeXpuByImmediateOutbound`，日志前缀形如 `---------CarService: startCar------------`。这是 DiDi Davinci 数字钥匙（BLE）层，与 MQTT 的 `service_type` 体系平行。

MQTT 侧实测排除：`st=9 ct=2` → `code:8`；`st=9 ct=4/5 cv=1` → 无回执；`st=9 ct=0` 带 `cv=1/2` 都只解锁（`cmd_value` 被忽略）；`st=6 ct=1 cv=1` 回 `200` 但 `remote_start_status` 保持 0；`st=10 ct=1 cv=1` 无回执且状态不变。`callbacks/v1` 里的 `PowerControlCallBack` 与 `CarDoorLockControlCallback` 并列，说明电源控制是独立回调，但未在 MQTT 找到对应 `service_type`。

**遮阳帘的 `cmd_value` 是二值开关**（0/1），不是位置百分比。`cmd_value:99/100` 均返回 `code:8`。

### 5.7 未打通的通道

**远程查看（实时视频 + 视角切换，`service_type:11`）**：只读可用，控制未打通。

- `{"cmd_type":1,"cmd_value":0}` 返回 `camera_status`、`camera_degree`、`live_push_status`、`camera_type`、`camera_os_switch`、`fileStatus`、`camera_360{camera_front,back,left,right}`。
- `cmd_type:2/3` 一律 `code:8`；`cmd_type:1` 的 `cmd_value` 改成 2/3 后 `camera_type` 从 9 变 0 但 `camera_status` 恒为 -2，无开流迹象；`cmd_type:7` 各种 `cmd_value` 全 `code:8`。
- **本车实测无法继续**：`st=19` 的 `instant.equipment.avm_exist = 0`，即该车没有环视硬件；`camera_status` 恒为 `-2`（`CAMERA_STATUS_CLOSE` 语义），四个 `camera_360.*` 虽回 1 但无实际数据流。**实时视频与视角切换在这台车上物理不可用**，不是协议没猜对。
- 要在有环视硬件的车上继续：先 `st=11 ct=1 cv=0` 看 `camera_status` 能否从 -2 变到 `CAMERA_STATUS_OPEN`，再据此定 `camera_type` 与 `camera_degree` 的取值含义。

**车窗单扇控制**：`service_type:12 / cmd_type:1` 只能一键全车（四窗同值联动），**单扇控制未打通**。`cmd_type:1` 的 `cmd_value` 只接受 1/2；`cmd_type:0/2..15` 配各种 `cmd_value` 全部 `code:8`。

排查过程中 `cmd_type:3 cv=1/0` 曾返回过 `code:15003`/`15004`（vdex 字符串池里没有，属服务端动态码），但复测变为无回执、车窗不动，**未确认语义**，判定为无效组合。

四个车窗**同值联动**，说明云端入口只有「一键全车车窗」。单扇控制若要实现，需走 BLE 通道的 `PositionDef$Windows` + `BCM_WINDOW_TYPE_*`（见 §5.7b）。

**空调其余能力**：`hvac_quick_warm_mode`、`hvac_quick_cool_mode`、`hvac_high_temp_mode`、`hvac_defrost`、`hvac_wind_speed`、`hvac_auto` 这些字段能读到，App 侧操作与回执变化对照：

| App 操作 | 回执字段变化 |
| --- | --- |
| 关空调 | `hvac_on:0` |
| 开空调 | `hvac_on:1`、`hvac_wind_speed:1`、`hvac_auto:1` |
| 设 19℃ | `hvac_temp:19`、`hvac_wind_speed:3` |
| 极速升温 | `hvac_temp:32`、`hvac_quick_warm_mode:1`、`hvac_wind_speed:8` |
| 极速降温 | `hvac_temp:18`、`hvac_quick_cool_mode:1`、`hvac_wind_speed:10` |
| 高温抑菌 | `hvac_high_temp_mode:1`、`hvac_temp:32`、`hvac_wind_speed:10` |

**除开关与设温度外，其余空调动作的指令码未打通**。`cmd_type:7` 是风量（返回 `10306 调控风量失败`，说明字段名不对）；极速升温/降温、高温抑菌、除霜、内外循环、座椅加热通风的 `cmd_type` 全部未测。

**鸣笛**：能力表有 `BLE_FLASH_LIGHT_HORN`，闪灯已确认（`st=5 ct=1 cv=1`），鸣笛是否同通道的 `cmd_value:2` 或其他值**未测**。

### 5.7b 从 vdex 挖到的名称清单（未映射到数值）

`base.vdex` 的字符串池里有 144 万条，其中车控相关名称已全部提取。它们给出了语义，但**不含数值**（vdex 只有名称池，字节码仍在 Yidun 加密区）：

**18 个接收 handler**（`MqttReceiveHandler` 的方法，一一对应 `service_type` 的语义）：
`handleCarDoorService`、`handleWindowService`、`handleAirConditionService`、`handleLightService`、`handleWhistleService`、`handleSeatService`、`handleSeatStateService`、`handleChargeService`、`handleIntelligentChargeService`、`handleCameraService`、`handleScheduleService`、`handleSteerService`、`handleBatteryWarmService`、`handleBatterTempCtrlService`、`handleAcProtectService`、`handleAirProtectModeService`、`handleFridgeService`、`handleFuelTankCapService`、`handleRemoteWakeUpService`、`handleWakeUpFailService`、`handleCmdToScreenService`、`handleCarStatusService`、`handleGetService`、`handleSwitchUserService`、`handleUserLogoutService`、`handleAutoParkService`、`handleCarBleRestartService`

**车控 API 方法名**：

| 类别 | 方法 |
| --- | --- |
| 车窗 | `OpenWindow` `CloseWindow` `OpenRearLeftWindow` `CloseRearLeftWindow` `OpenRearRightWindow` `CloseRearRightWindow` |
| 空调 | `OpenAC` `CloseAC` `OpenRtAcAuto` `CloseRtAcAuto` `OpenRtWindFace` `CloseRtWindFace` `OpenFrontDefrost` `CloseFrontDefrost` `OpenHighTemp` `CloseHighTemp` |
| 遮阳帘 | `OpenSkySunShade` `CloseSkySunShade` `OpenFrontSunShade` `CloseFrontSunShade` `OpenBehindSunShade` `CloseBehindSunShade` |
| 天窗 | `OpenSunroof` `CloseSunroof` |
| 灯光 | `OpenReadingLight` `CloseReadingLight` |
| 童锁 | `OpenChildLock` `CloseChildLock` |
| 冰箱 | `OpenRefrigeratorChildLock` `CloseRefrigeratorChildLock` |

**`CMD_ACTION_*` 动作枚举名**：`CMD_ACTION_AIR_CONDITIONER`、`CMD_ACTION_CHARGE`、`CMD_ACTION_CONTROL_CAMERA`、`CMD_ACTION_FLASH_LIGHT`、`CMD_ACTION_LOCK`、`CMD_ACTION_OTHER_SETTINGS`、`CMD_ACTION_WAKE_UP`、`CMD_ACTION_WHISTLE`、`CMD_ACTION_WINDOW`

**四类车控的 handler / Model / 字段名定位（2026-10-31 静态）**：

| 功能 | 接收 handler | 请求类 | 状态字段 | 通道判定 |
| --- | --- | --- | --- | --- |
| 哨兵模式 | `MqttReceiveHandler` 的 `handleOtherSettings`（`st=8` 回 `settings[]`，属「其它设置」而非独立哨兵 handler） | `xpcar/cmd/SentinelCmd` + `SentinelCmd$ActionType`、`CommandParams$SentinelParams`；另有 `mona/cmd/SentinelCmd` | `instant.ext.sentinel_mode_sensitivity`、`sentinel_mode_video_enable`、`soldier_camera_status`；`digital_vehicle.sentinel.{cur_uid,abnormal_vibration,abnormal_vibration_st}` | **MQTT 可写**（`st=8 action:2`） |
| 远程查看 | `handleCameraService` | `xpcar/cmd/` 无摄像头 cmd；走 `link/camera/MonaCameraManager.reqRemoteLive` / `startRemoteLivePaket`、`XpCameraManager.reqRemoteLive` | `camera_status`、`camera_degree`、`camera_360.*`、`live_push_status`、`camera_type`、`camera_os_switch`、`fileStatus` | 只读可（`st=11`），开流/切视角未打通 |
| 后备箱 | **无对应 handler**（`CallbacksManagerV1` 也无回调） | `xpcar/cmd/TrunkCmd` + `TrunkCmd$ActionType`，含 `executeByBle` 与 `executeByMqtt` 两条路径；`mona/cmd/TrunkCmd` | `instant.door.trunk_ajar_st`、`instant.trunkPower.{powerSwitch,timeToPowerOffInMin}`（后者是 220V 供电，非箱门） | **BLE**（`executeByMqtt` 在本车不可用） |
| 解锁并启动 | `handleCarDoorService`（只覆盖解锁/锁车） | `xpcar/cmd/RemoteUnlockStartCmd`（含 `onExecuteCmd`、`successPrediction`）、`BleUnlockStartCmd`、`LockCmd`/`UnlockCmd` | `instant.power.remote_start_status`（1=授权窗口开启）、`car_igon_state`（始终 0，不能用作判据） | 解锁走 MQTT（`st=9 ct=0`），**「并启动」走 BLE** |

注意 `TrunkCmd` 同时存在 `executeByBle$*` 与 `executeByMqtt$*` 两组内部类，说明代码层面保留了云端开箱路径；但本车实测无 MQTT 报文、无回调、`st=19` 也不含开箱指令回执字段，故该路径对本车型不可用（可能是高配车型或特定市场分支）。

**哨兵开关的字段名**：`SENTINEL_MODE`、`SENTINEL_MODE_VIDEO`、`SENTINEL_MODE_VIDEO_ENABLE`、`SENTINEL_MODE_SENSITIVITY`、`SENTINEL_ACTION`、`SENTINEL_SETTINGS`、`SENTINEL_CLOSED` 均在字符串池里，且各带一个 `_` 后缀的同名资源键（如 `SENTINEL_MODE_VIDEO_`）。实测确认 `SENTINEL_MODE_VIDEO` 是开关位（见 §5.6），`SENTINEL_MODE` 与 `SENTINEL_ACTION` 作为 `code` 写入会被静默忽略。

**`REMOTE_ACTION_CONTROL_*` 埋点事件名**：`CAR_DOOR_LOCK`、`CAR_DOOR_UNLOCK`、`CAR_WINDOW_UP`、`CAR_WINDOW_DOWN`、`CAR_WINDOW_STOP`、`TRUNK`

**`Service*` 服务名**：`ServiceAirConditioner`、`ServiceDoorWindow`、`ServiceVehicleLight`、`ServiceVehicleStatus`、`ServiceSeat`、`ServiceFridge`、`ServiceMedia`、`ServiceScreen`

**空调功能完整清单**（资源键，非协议字段）：`OPEN_AIR_POWER` `CLOSE_AIR_POWER` `OPEN_CLEAN_AIR` `OPEN_DEODORIZE_MODE` `OPEN_FRONT_CLEAR_FROST` `OPEN_FRONT_MIRROR_HEAT` `OPEN_HIGH_TEMP` `OPEN_LEAVE_CAR_KEEP_POWER` `OPEN_MIRROR_HEAT_MODE` `OPEN_PROTECT_MODE` `OPEN_QUICK_COLD` `OPEN_QUICK_WARM` 及对应 `CLOSE_*`

**REST 路径表**（`/sp-vowner-mapp/p/api/*`，共 50 条，静态可读）：`rvc/v1/{openWindow,closeWindow,lockDoor,whistle,findVehicle,doubleFlash,closeTrunk}`、`rvc/v2/openTrunk`、`rvc/v3/getVehicleStatus`、`ac/v2/{turnOn}`、`ac/v1/{turnOff,setTemperature,startCycleInside,startCycleOutside,startDefrosting,stopDefrosting,startSeatHeating,stopSeatHeating,startSeatVentilation,stopSeatVentilation,createSchedule,cancelSchedule,getScheduleDetail}`、`charge/v1/*`、`nfc/v1/*`、`ota/v1/*`。**这些路径在 `apps.xiaopeng.com` 上返回空体（`len=0`），真实网关未定位。**

**为什么这些名称拿不到数值**：vdex 只保存名称池与类型池，字节码在 `classes.dex` 的 120 MB 加密区里。内存中也没有解密后的标准 dex（Yidun 直接解释执行，不落地）。`/data/app/.../oat/arm64/base.vdex` 只有 120,256,660 B 的原始加密 dex 加名称池，`Anonymous-DexFile@*.vdex` 只有 92 B。

### 5.8 全车状态字段清单

`service_type:19 / cmd_type:2` 一次返回 80+ 字段，`instant` 下 14 个子域，只读可得、无需车辆上电：

| 子域 | 字段 |
| --- | --- |
| `door` | `temp_lock_st`、`driver_door_lock_st`、四个 `*_door_ajar_st`、`trunk_ajar_st` |
| `window` | `front_left/right_window_position`、`rear_left/right_window_position` |
| `hvac` | `hvac_on`、`hvac_temp`、`hvac_inner_temp`、`hvac_wind_speed`、`hvac_auto`、`hvac_defrost`、`hvac_quick_warm_mode`、`hvac_quick_cool_mode`、`hvac_high_temp_mode` |
| `charge` | `battery_soc`、`charging_state`、`charge_gun_status`、`charge_gun_lock_status`、`fast/slow_charge_port_status`、`max_range_charge`、`reserve_charge_start_time`、`time_to_complete_charge(_min)`、`battery_keep_warm_status`、`repeat_type`、`charge_connector_status` |
| `odometer` | `total_mileage`、`avalible_driving_distance`、`range_type` |
| `tpms` | 四轮 `tpms_pressure_*` 与 `*_warn` |
| `seat` | 主副驾与后排的 `*_seat_heat` / `*_seat_ventilation`、`driver_seat_state` |
| `solarRoof` | `solarWorkStatus`、`solarFaultStatus`、`solarVentilateStatus`、`solarVentilateToday`、`solarVentilateLengthToday` |
| `trunkPower` | `powerSwitch`、`timeToPowerOffInMin` |
| `power` / `drive` | 见 `digital_vehicle` 同名域 |
| `ext` | `sentinel_mode_sensitivity`、`soldier_camera_status`、`sentinel_mode_video_enable`、`repairMode` |
| `chargeStatistics` | `usageElectricity`、`chargeTime`、`completeTime`、`addedRange` |
| `equipment` | `avm_exist` |

另有两个顶层域：`interval`（`drive` 定位/速度/角度 + `charge` 电压电流，约 3 s 一帧推送）、`digital_vehicle`（`parking`/`sentinel`/`charge`/`drive`/`ota`）。

### 5.9 探测的边界（重要）

**`service_type` 是否认某个字段名，无法靠猜测判定**：不认识的组合统一返回 `{"code":8,"msg":"当前车辆不支持此操作"}`，与「通道存在但字段名不对」的表现完全相同。因此**枚举只能拿到「有效」的信号，拿不到「存在但未猜中」的通道**。

`msg_type` 探路同样无效：`msg_type:4` 只对 `st=29` 有回 `code:200`，`msg_type:1` 对 `st=1` 和 `st=29` 有响应，其余一律 `code:8`。

**为什么控制指令抓不到**：App 发的请求报文在内存中存活极短，写完立刻释放。扫过 7 个含 `protocol_ver` 的区域（共 300+ MB），`msg_type:2` 的 st=3 和 st=12 报文零命中。Frida hook Paho 被易盾检测（`frida-server` 存在即杀进程）；tcpdump 抓 8883 零包（模拟器网络被代理接管）。

**未解释的现象**：一次 `cv=94` 被拒后，遮阳帘位置从 99 跳到 48，而我没有发过 48。可能是 `cv=0` 查询触发了某种滑动，也可能是车辆侧状态机。**待查。**

### 5.10 已确认可用的业务接口

均需有效 accessToken：

| 接口 | 用途 |
| --- | --- |
| `/biz/v5/vehicle/v2/myVehicles` | 车辆列表：VIN、车牌、车型代码、里程、`relationType`、`permissions.remoteControl` |
| `/biz/v5/widget/vehicle/state` | 需 `vin` + `vehicleTypeCode`；电量、续航、车窗、`driver_door_lock_st` |
| `/biz/v5/vehicle/remoteCapabilities` | 需 `vin`；返回 19 项车控能力 |
| `/biz/v5/remoteControl/activityList` | 需 body 带 `vin` |
| `/biz/v5/mqtt/createMqttAccount/app` | MQTT 凭据 |
| `/sso/app/v5/keyAuth/getKeyAuthSwitch` | 钥匙授权开关（本账号 `switchStatus:null`） |

**权限与钥匙激活无关**：本账号对这台车的 `permissions.remoteControl` 为 `isPermanent:true`、`expireTime:null`，服务端照常返回 19 项车控能力。数字钥匙未激活只影响 BLE 本地解锁，不影响云端车控。

`remoteCapabilities` 返回的能力表含 `SUN_SHADE_SOFTWARE`、`BLE_FLASH_LIGHT_HORN`、`REMOTE_START_4G`、`AUTO_PARK`、`SENTINEL_MODE` 等 19 项。该接口只说明支持，**不给出指令码**。

### 5.11 车型能力配置

`assets/vehicle/config/<车型代码>VehicleAbilityConfig.json` 是静态可读的车型能力表。本车 `DFVehicleAbilityConfig.json`（P5 / `D55`）关键项：`isSupportCarControl:true`、`isSupportBleKey:true`、`bleKeyVersion:2`、`isSupportPollingV1:true`（V2/V3 为 false）、`isSupportRemoteCamera:true`、`isSupportRemoteStart:false`。**写自研客户端时以这份表决定 UI 该显示哪些控件，不要硬编码。**

---

## 6. 蓝牙钥匙栈

### 6.1 Java 侧（在加密 dex 内，需脱壳）

- `com.xiaopeng.blekey.polling.*` 217 个类，分 `manager`(79)、`distance`(44)、`config`(25)、`rx`(18)、`defaultconst`(8) 等；`locksource` 定义 `LockSource`/`UnlockSource`/`LockSourceLevel`。
- `com.xiaopeng.common.car.digitalkey.*` 1206 个类，覆盖 ICCoA、ICCE、CCC 三套标准，以及华为/小米/vivo/三星/荣耀钱包 SDK 接入。
- 按车型分协议实现：`D22BleProtocol`、`D55BleProtocol`、`E28ABleProtocol`、`E28BleProtocol`、`E38BleProtocol`、`F30BleProtocol`、`H93BleProtocol`、`XpBleProtocolV1V2`、`XpBleProtocolV3`、`XpNativeBleProtocol`。
- 第三方数字钥匙引擎 DiDi Davinci SDK（`com/didi/davinci` 1,571 处引用、1,489 个类）：`MonaBleService`、`MonaBleCommunication`、`BleCommandQueueManager`、`ble/encrypt/AesUtils`、`mona/carserviceimpl/{MnaAcCtrlImpl,MnaCarManagerImpl,MnaCarStatusImpl,MnaChargeImpl,MnaNfcImpl}`。即数字钥匙本身已是第三方代码，小鹏只做集成。
- 进程模型：`com.xiaopeng.common.car.ble.ipc.BleService` 与 `com.xiaopeng.link.bleenv.BleService` 均在 `:BLE` 进程，`android:exported="true"` 且**未声明 `android:permission`**。跨进程调用受 `com.xiaopeng.lib.xipc` 约束，框架内含 `RESULT_CALLER_SIGNATURE_CHECK_FAIL`，按调用方签名拦截。
- 本地钥匙存储：SQLCipher（`net.zetetic.database.sqlcipher`）+ `KeyTokenDao`（`XpKeyTokenEntity`、`VehicleCertKeyTokenInfo`、`VehicleXpKeyTokenInfo`、`VehicleMacInfo`）。

### 6.2 Native 侧（未加固，可直接复用）

`lib/arm64-v8a/libbledata.so`（1.18 MB）是蓝牙钥匙的协议与密码学实现：

- 普通 ELF，无壳、无混淆调用链。`.text` 615 KB，`.rodata` 32 KB 可打印率 75%。
- `JNI_OnLoad`（`0xa31f0`）已完整反汇编：先 `FindClass("com/xiaopeng/ble_data_processor/BLEDataProcessor")` + `RegisterNatives`（29 项，表在 `0x127838`），成功返回 `0x10006`。随后再 `FindClass(".../AlgorithmUtils")`，用 `GetMethodID` 取回 4 个 Java 方法句柄存进全局变量：`hkdfSha256 ([B[B[BI)[B`、`hmacSha256 ([B[B)[B`、`encryptCbc ([B[B[B)[B`、`decryptCbc ([B[B[B)[B`。
- **静态无签名校验、无包名校验**：`frida`/`ptrace`/`magisk`/`xposed`/`/proc/self/maps` 检索全部命中 0；128 个导入符号里与自检沾边的只有 `__system_property_get` 与 `dl_iterate_phdr`。
- 通过 RELA 重定位还原出完整 JNI 方法表 `0x127838–0x127ad8`，29 项签名齐全。核心几项：

| 方法 | 签名 |
| --- | --- |
| `native_generateAuth0DataV3` | `(J[B[BIJZIIII[B[B[B[B)[B` |
| `native_generateAuth1DataV3` | `(I[B[B)[B` |
| `native_generateSessionKey` | `([B[BII)[B` |
| `native_generateHmacKey` | `([BII)[B` |
| `native_parseBleV3Data` | `(Ljava/lang/String;[B[B[BZ)Ljava/lang/String;` |
| `native_generateTboxMessageV3` | `(I[BBI)Lcom/xiaopeng/ble_data_processor/BleByteMatrix;` |

- 导出符号含完整密码学原语：`SDKBleKeyV3::getSessionKey`、`hmac_sha256`、`hkdf_sha256`、`calculateAuth1SessionKey`、`generateAuth0Packet`/`generateAuth1Packet`、`decodePackage`、`createSendData`，以及 TLV 编解码与轮询配置。
- BLE UUID 只在 Java 层（native 内 `ED28`/`FF001`/`ABAB` 命中 0），大写形式：`0000ED28-ABAB-9C8C-2801-B1A015E46D6C`（服务）、`...6D6E`（特征值）、`0000ED28-ABAB-9C8C-2802-D3DF573FF530`、`000FF001-ABAB-9C8C-2801-B1A015E46D6C`/`...6D6F`、`0000ED28-ABAB-406D-832D-7AD799B479F7`。

**推论**：自研 App 可自建 `BLEDataProcessor`（29 个 native 声明）与 `BleByteMatrix`，`System.loadLibrary("bledata")` 复用这套协议与密码学；额外负担只是实现 `AlgorithmUtils` 的 4 个方法（JNI 会回调）。JNI 层没有任何调用方约束。**未编译验证。**

### 6.3 运行时反调试（推翻静态结论）

静态检索不到任何反调试痕迹，但**运行时存在**。Frida 17.24.3 实测（5.19.0）：

- attach 已运行进程报 `Failed to attach: process not found`（尽管 `pidof` 有值、`/proc/<pid>` 可读）。
- spawn 注入后 JS 运行时被冻结——顶层 `send()` 能执行，但 `setTimeout` 与 `Java.perform` 回调全部不触发（不是报错，是停止执行）。
- 同期 `libnesec.so` 在 10 秒内被 5 个不同 PID 加载（8801→8897→8920→9199→9224），是检测到注入后重启进程。
- 检测逻辑为运行时动态生成或藏在加密 dex 内，静态检索不到。

**结论：不要指望 Frida 做动态分析。** 4.2.0 上 Frida 可注入且进程不重启，但注入 Java 桥后 App 仍会崩溃；5.19.0 上 `frida-server` 存在即触发检测。

**内存 dump 是唯一可行的动态手段**——它不注入进程。

### 6.4 钥匙物料来源

- 服务端签发，非本地派生。`/api/bt/v2/get/key`、`/api/bt/v2/create` 挂在 §2 的会话之上，本地以 SQLCipher 存 `XpKeyTokenEntity` 等。
- 提示串 `seed_due_error_info` = 「本地密钥已过期，请用户联网进行更新」——物料有有效期，过期需联网续期。
- 因此 §6.2 可复用的是**协议实现**，输入（物料）走 §2.5 的服务端链路。

---

## 7. 体积与功能构成

| 项 | 大小（`du -sm`） |
| --- | --- |
| native 库（122 个 .so） | 214 MB |
| assets | 128 MB |
| res | 90 MB |
| classes.dex | 114.7 MB |

- native 大头：`libil2cpp.so` 49.7 MB + `libunity.so` 24.0 MB（3D 看车，Unity 引擎）、`libAMapSDK_MAP_v10_1_700.so` 29.6 MB（高德地图）、`libjingle_peerconnection_so.so` 11.2 MB（WebRTC）、`libhigh_available_android.so` 11.1 MB。
- assets 大头：`assets/bin` 47.3 MB（Unity 资源包）、`assets/react-native` 18.1 MB、`assets/images` 17.2 MB、`assets/autopark` 7.7 MB。
- 社区功能：`business-bbs.unbundle` 1.5 MB，外加网易云信 IM SDK（dex 内 `com/netease/nimlib` 引用 5170 处）；`strings.xml` 含「社区」8 处、「关注」2 处，以及「论坛」「粉丝」「来往动态」各 1 处。
- 清单规模：466 个组件（activity 338 / service 60 / receiver 36 / provider 32），109 条 `uses-permission`，含 `INJECT_EVENTS`、`READ_PRIVILEGED_PHONE_STATE`、`CAPTURE_VIDEO_OUTPUT`、`MOUNT_UNMOUNT_FILESYSTEMS`。
- 推送 SDK 五家并存：阿里云 EAMS、小米、华为 HMS、vivo、荣耀、魅族。
- `assets` 中 12 个 `.box`/`.unbundle` 有 9 个整体为 `0xAA` 填充（熵≈0.00，占位/加密态），只有 `CarControl.box`、`XPWebView.box`、`business-search.unbundle` 三个有实际内容；`ca-chain.crt` 亦为 `0xAA` 填充。这几项静态不可读，真实业务包由 CodePush 远程下发。`CarControl.box`（2507 B，JSON）内容只是远程配置 URL（`HTTPApiRequestCommonDomain: https://static.xiaopeng.com` 等），**无指令码**。

---

## 8. 路线判断

### 8.1 自研 App 替代官方（当前选定）

| 子问题 | 状态 | 剩余成本 |
| --- | --- | --- |
| 请求签名（双层 HMAC） | ✅ 线上验证通过 | 0 |
| 客户端证书（mTLS） | ✅ 可提取；国内主机不需要 | 0 |
| 国内 appId + secret | ✅ `xp_xmart_android` / `<XP_SECRET>` | 0 |
| tenant 密钥池 | ✅ 闭环 | 0 |
| 本地密钥 | ✅ 闭环 | 0 |
| `Xp-Authorization` blob | ✅ 闭环（分版本） | 0 |
| 登录与会话 | ✅ 闭环（真号实测）：发码 → 验证码 → 第二道滑块(`LGN`) → `smsLogin` 200 → 解 `sData` → 带 `Xp-Uid` 打业务接口 200 | 两道滑块：第一道发码、第二道换 token（§4.2） |
| 令牌续期 | ✅ 闭环，连续 5 次成功 | 0 |
| MQTT 连接与凭据 | ✅ 闭环 | 0 |
| 车控指令 | 🟡 10/12 | 单扇车窗、除霜、循环、座椅加热通风、智能清洁/除味/香氛（启动走 BLE，不在 MQTT；风量 App 无此功能） |
| BLE 离线解锁 | 🟡 native 可复用 | 3–5 天（含编译验证） |

**客户端身份与令牌生命周期这两层已经没有未知量。** 剩余成本集中在车控指令码与 UI。

**两个必须先接受的约束**：

- **单会话**：同一账号同时只允许一个有效会话，自研 App 登录会把官方 App 踢下线。
- **跟版**：appId/secret 一旦轮换、canonical 一旦改版，客户端立刻失效，必须跟随官方版本更新。§2.2 的 dump 流程就是跟版时的重新取证手段。

**成本**：MVP（只做云端车控、不做 BLE）约 1 周；加 BLE 离线解锁约 2–3 周。前置条件已满足。

### 8.2 挂在官方进程上（兜底一）

不复刻 App，只做「界面壳 + 官方进程」：钥匙物料、TEE、签名全部沿用官方链路，自己只接管 UI 与连接策略。依据是 §6.2——BLE 协议层是纯函数、无调用方校验，hook 进去可直接调 `native_generateAuth0DataV3` 等原语，绕开官方那套 217 个类的轮询状态机。代价：需 root 或 Frida（而 §6.3 说明 Frida 会被检测）；官方改 native 接口就要跟；分发撞版权。

### 8.3 改包精简（不可行）

改包必换签名 → TEE 绑定的 `XTeeSecurityAlias` 与 `KeyTokenDao` 数据失效，数字钥匙不可用；服务端签名判定也会命中 `err_ban`（「被屏蔽所有操作，可能由于签名不正确或无权限」）。且需先脱壳才能改 dex。**不要走。**

### 8.4 不动 APK，从外围治（兜底二）

官方 App 自带可调项：`PollingSettingV3Activity`（轮询灵敏度）、`AdjustBleByHandActivity` + `SelfCalibrationManagerV3`（手动蓝牙校准）、`UnlockMethodActivity`（解锁方式）、`BleCheckNewActivity`（蓝牙自检）。

App 自己承认两处结构性弱点：`ble_check_fail_des` = 「先关闭蓝牙，再打开，可解决90%问题」，`adjust_ble_by_hand_suggest_one_title` = 「自动解闭锁功能需小鹏App常驻后台，手机系统关闭App会导致功能失效」。这两句指向**后台保活与蓝牙栈状态**，而非协议本身。

顺带一点：远程车控走 MQTT over TLS，**不走 BLE**。把解锁上锁切到云端指令即可绕开蓝牙链路，代价是多一次网络往返。

---

## 9. 未验证项

**车控指令**

- **车窗升降的指令码**：`st=12` 能读四个车窗位置，控制值未找到。App 发的请求报文未抓到。
- **空调控制指令**：`st=3` 只读可用；`cmd_type:1 + cmd_value` 回执成功但车辆不执行。App 报文未抓到。
- **鸣笛**：能力表有 `BLE_FLASH_LIGHT_HORN`，是否同通道的 `cmd_value:2` 未测。
- **解锁+启动**：云端 MQTT 侧已排除（§5.6 附实测），确认走 BLE `CarService.startCar`；BLE 指令码未测（账号未激活蓝牙钥匙）。
- **远程查看的实时视频与视角切换**：本车 `avm_exist=0` 无环视硬件，`camera_status` 恒 -2，物理不可测（§5.7）。需换有环视的车重测。
- **后备箱箱门开合**：确认走 BLE（§5.6），自研客户端需复用数字钥匙栈；BLE 指令码未测。
- **遮阳帘 99→48 的跳变**：未解释（§5.9）。

**协议与接口**

- **`/biz/v4/*` 的签名算法**：`/biz/v4/vehicle/v2/myVehicles` 返回 `11001101 check v4 sign fail`，说明 v4 在线但签名算法不同。**未验证。**
- **`/sp-vowner-mapp/*` 的路由主机**：所有候选网关均返回空体，真实入口未定位。
- **官方 App 的真实续期路径**：运行堆里 `token/refresh` 命中 0、`WEEB` 命中 0，其续期不走该接口；但 `tee` 确实会每约 3 小时自动更新（§2.6）。该能力在加密 dex 内，无法静态读取。

**登录**

- ~~**第二道滑块是否在真号正常流程下出现**~~：**已验（2026-10-31）**。真号发码 + `sms/validate` 通过后，`smsLogin` 返回 `12040101`，第二道滑块确认必经（§4.2）。
- ~~**第二道滑块的票据通道**~~：**已解决（2026-11-01）**。通道是 `drag/validate` + `sceneType:"LGN"`（§4.2）。此前判「已排除 `drag/validate`」是枚举漏了 `LGN` 所致。
- **运营商一键登录是否可用**：`oneclickLogin` 端点与三家 SDK 均在 App 内（§4.2），但 `accessCode`/`token` 必须在真机 + 真实 SIM 上由运营商网关鉴权换取，模拟器无法验证。若可用，这是完全绕开短信与滑块的入口。
- ~~**真正的验证码下发接口**~~：**已解决**，是 `/verification/app/v5/sms/code`（§4.2）。

**BLE**

- **延迟的真实成因**（扫描/连接/服务发现/握手哪一段耗时）：需 `btsnoop_hci.log`，未采集。
- **`libbledata.so` 在自研 App 内加载的实际可用性**：仅静态分析，未编译验证。
- **`XmartV1LocalKey*` 的轮换周期**：`IndivKeySet` 解出 `[0,1,…,9]`，与实际使用的 `keyIndex` 关系未验。

**环境**

- **真机上 `XTeeSecurityAlias` 是否由 TEE 硬件保护**：推论为真机不可导出。这意味着 §2.6 的本地密钥提取流程**只在模拟器上成立**；真机场景下自研 App 需自己的密钥对。
- **`apps.xiaopeng.com` 的服务端证书上级 CA**：由 `CN=Xiaopeng Motors Intermediate CA` 签发，其上级未知；`assets/ca-chain.crt` 是 `0xAA` 占位。国内主机不要求 mTLS，故只影响海外链路。
- **5.23.5 崩溃根因**：`libbulk.so` 加载后 SIGSEGV，疑似 16 KB 页对齐，未验证（§1.3）。

---

## 10. 复现方式

环境由 `pixi.toml` 固定（openjdk 21、python 3.13、capstone、pyelftools；`rev` 环境另装 `pyjks`、`cryptography`）。逆向工具在 `.tools/`（jadx 1.5.6、apktool 3.0.3），由 `pixi run fetch-tools` 下载；APK 由 `pixi run fetch-apk` 下载（短链带时效签名，必须走短链）；解包由 `pixi run decompile`、清单汇总由 `pixi run manifest`。

**证书提取**：`pixi run -e rev python` 里用 `jks.bks.BksKeyStore.load(path, 'xiaopengapp')`；注意 `BksSealedKeyEntry.decrypt()` 返回 `None`，内层条目要从 `entry._nested` 取（`BksKeyEntry` 暴露 `pkey_pkcs8`、`cert_chain`）。

**接口探测**：`scripts/probe.py` 提供 `canon()`、`signed()`（只带外层签名）、`authed()`（双层签名完整）、`tenant()`、`keypool()`、`unwrap_local_keys()`、`build_auth()` 与带客户端证书的 `http()`。

**内存取证**：`scripts/heap-hunt.sh`（`pixi run heap-hunt`）把「装 App → 触发一次签名请求 → dump Dalvik 堆 → 提取 canonical」串成一条命令，用于跟版时重新取 appId/secret。

**离线解出令牌（推荐，不需要 App 运行）**：`pixi run -e rev python scripts/unseal-token.py --save`。走 §2.6 的三层链路。`rsa_key()` 按 `alias='XTeeSecurityAlias'` 反查（blobentry id 每次重装都变）。`local_keys()` 解 10 把 `XmartV1LocalKey*`，**AES 解开后还要再 base64 解码一次**。

**续期**：`scripts/renew.py`（`status`/`renew`/`auto`）。**注意频率**：十几次后 RT 会 `12010202` 永久失效。`_keys()` 通过 importlib 加载 `unseal-token.py`（文件名含连字符，无法正常 import）。

**MQTT 车控**：`scripts/mqtt-send.py`：

```
pixi run -e rev python scripts/mqtt-send.py unlock       # 解锁车门
pixi run -e rev python scripts/mqtt-send.py lock         # 锁车
pixi run -e rev python scripts/mqtt-send.py flash        # 闪灯
pixi run -e rev python scripts/mqtt-send.py shade 1      # 遮阳帘开
pixi run -e rev python scripts/mqtt-send.py shade 0      # 遮阳帘关
pixi run -e rev python scripts/mqtt-send.py shade-state  # 查遮阳帘状态
pixi run -e rev python scripts/mqtt-send.py door-state   # 查门锁状态（需上电）
pixi run -e rev python scripts/mqtt-send.py ac 1         # 空调开
pixi run -e rev python scripts/mqtt-send.py ac 0         # 空调关
pixi run -e rev python scripts/mqtt-send.py ac-temp 26   # 设温度（会顺带开机）
pixi run -e rev python scripts/mqtt-send.py ac-state     # 查空调状态
pixi run -e rev python scripts/mqtt-send.py window 2     # 全车车窗降（通风位）
pixi run -e rev python scripts/mqtt-send.py window 1     # 全车车窗升（关）
pixi run -e rev python scripts/mqtt-send.py window-state # 查四窗位置
pixi run -e rev python scripts/mqtt-send.py ac-cool      # 极速降温
pixi run -e rev python scripts/mqtt-send.py ac-warm      # 极速升温
pixi run -e rev python scripts/mqtt-send.py ac-high-temp # 高温抑菌
pixi run -e rev python scripts/mqtt-send.py sentry 1     # 哨兵模式开
pixi run -e rev python scripts/mqtt-send.py sentry 0     # 哨兵模式关
pixi run -e rev python scripts/mqtt-send.py sentry-sensitivity 2  # 哨兵灵敏度 1/2/3
pixi run -e rev python scripts/mqtt-send.py sentry-state # 读哨兵设置（st=8 action:1）
pixi run -e rev python scripts/mqtt-send.py sentry-all   # 读含 soldier_camera_status 的全量状态
pixi run -e rev python scripts/mqtt-send.py camera-state # 读摄像头状态（本车 avm_exist=0）
```

**自研身份（不依赖官方 App）**：`scripts/selfclient.py`。自己生成 `deviceId`、自己拉一次性密钥池、自己签名。跑一遍会打印 `deviceId`、密钥槽、以及一次 `myVehicles` 探测（预期 `12010103`，表示签名与信封都通过）。

**本地密钥提取（模拟器）**：`sqlite3 /data/misc/keystore/persistent.sqlite` 查 `keyentry.alias='XTeeSecurityAlias'` 拿 id，再从 `blobentry`（`subcomponent_type=0`）取 blob；跳过前 5 字节、按 DER 长度截取即得 RSAPrivateKey。MMKV 文件是 `files/mmkv/tee`，交给 `unwrap_local_keys()`。

**发请求前先确认 token 干净**：只要看到 `12010101`，先怀疑 token 被 refresh 重放作废，而不是去调信封格式。验证方法：`/biz/v5/vehicle/v2/myVehicles` 带空 token 应返回 `12010103`，带真 token 应返回 `200`；若真 token 也返回 `12010103` 说明信封没解开，返回 `12010101` 说明 token 本身废了。

**换版本后必查两项**：`deviceId`（重装会变，脚本里 `probe.DI` 需同步）、`blobentry` id（重装会变）。

`work/`、`.tools/`、`.pixi/` 均不入版本库——**提取出的客户端私钥与本地密钥只落在 `work/`，不得提交、不得外传**。

---

## 附录 A：已作废结论

保留此表以免重走弯路。每条都曾写进正文并被后续实测推翻。

| 曾记录的结论 | 实际 | 推翻依据 |
| --- | --- | --- |
| `WEEB` 用服务端密钥池，客户端无法解密 | **错**。`keyIndex` 直接索引 `XmartV1LocalKey*`，AAD 为空，明文 = 32 B 前缀 + 968 B JWT | 同代际密钥一次解开 |
| `/sso/app/v3/token/refresh` 对自研客户端不可用 | **错**。可用，且可无限续期 | 连续 5 次续期成功 |
| `msg_content` 是字符串拼接 `…}msg_content:{…}` | **错**。是 JSON 字段。拼接格式 broker 接受 publish 但车辆端解析失败，导致「连发 4 次闪灯零回执」 | 改 JSON 字段后每次都有回执 |
| 闪灯指令是 `service_type:19 / cmd_type:1 / cmd_value:1` | **错**。`st=19` 是状态查询；闪灯是 `st=5 / ct=1 / cv=1` | 实测回执 `dipped_headlight_status:1` |
| `tee` 登录后从不更新 | **错**。每约 3 小时自动更新 | 多次快照比对 |
| 官方 App 没有任何自动续期能力 | **错**。它能解开 WEEB 并写回 `tee` | `tee` 自动更新 |
| 官方 App 不走 refresh 接口 | **部分错**。堆里搜不到 `token/refresh` 字符串，但 `tee` 会更新，说明它用别的方式完成同一件事 | 同上 |
| refresh rotation 后旧值失效、重放即废链 | **错**。同一 eyJ RT 可反复用；真正废链的是**高频调用** | 连刷 5 次全 200；十几次后 `12010202` |
| MQTT 凭据可用 7 天 | **错**。`expireTime` 只是上限，AT 失效即连带作废 | AT 过期后 `connack rc=Not authorized` |
| 信封必须带 `tee_id` 段 | **半错**。分版本：4.2.0 不带，5.19.0 必须带 | 两版本对照实测 |
| `WEEB` 是 4 字符明文前缀，剥掉后得 1072 B | **错**。整串 base64 解码得 1075 B，`WEEB` 三字符 base64 后恰好产出 `XA` | 逐字节解码 |
| `WEEB` 明文可用已知明文法解出 | **循环论证**。`pt = ct XOR (ct XOR at) = at`，必然还原 | 逻辑自证 |
| `libbledata.so` 无任何反调试 | **只对静态字符串成立**。运行时存在，Frida 注入即被检测重启 | Frida 实测 |
| 内层明文结构未知导致 `12110001` | **错**。真正原因是反复调 refresh 把令牌链作废 | 干净 token 一次通过 |
| 车控指令可通过 REST 下发 | **错**。60+ 路径全 `Handler Not Found`，走 MQTT | 内存里抓到 MQTT 报文 |
| 静态可从 dex 还原业务逻辑 | **错**。dex 整体加密，99.98% 是密文 | dex 头解析 |
| 可以 MITM 抓明文 | **对一半**。系统 CA 可装进 `/apex/com.android.conscrypt/cacerts`（tmpfs），DigiCert 主机（`collect`/`sentry`）能解密；`apps*` 因私有 CA 信任锚仍拒绝 | mitmproxy 实测 |
| 5.19.0 无法在模拟器运行 | **错**。可运行，是 5.23.5 崩 | 实测 |
| 哨兵模式只能读不能写 | **错**。`st=8 action:2` 可写，`SENTINEL_MODE_VIDEO` 就是开关位 | 写 1/0 后 `soldier_camera_status` 0→1→0 |
| `st=8` 的 `settings[]` 按数组位置对齐 | **错**。按键名匹配，顺序无关；未知 `code` 被静默忽略 | 首元素塞 `ZZ_BOGUS` 后灵敏度仍正确落位 |
| `SENTINEL_MODE` / `SENTINEL_ACTION` 是哨兵开关的字段名 | **错**。写这两个键不改变任何状态；开关是 `SENTINEL_MODE_VIDEO` | 三者分别写入后读 `st=19` 对照 |

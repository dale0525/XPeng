# 小鹏 App（com.xiaopeng.mycarinfo）逆向调研

目的：为「自研 App 替代官方」评估技术成本与卡点。结论按「自研 + 钥匙从官方服务端接口获取」这条路线组织。
调研对象：国内版 5.19.0（`versionCode 10639`，265 MB）为主，4.2.0 作对照，5.23.6（303 MB）用于真机取证。

> 本文档只保留**当前成立**的结论。已被推翻的判断与排查过程不再收录。
> 附录 A 保留了无法重新获取的实测数据（native 偏移、真实抓包样本、设备拓扑、明文帧），是唯一的副本。


---

## 0. 结论速览

**客户端身份层已全部闭环**：签名、appId、secret、密钥池、本地密钥、信封格式、MQTT 凭据全部打通并线上验证。

**续期已闭环**：一次登录 + refresh 循环即可长期免重登。连续 5 次续期全部成功，每次 `keyIndex` 轮换。注意：重新登录后若解出的 token 尾部不变，说明 `mmkv_read` 读到了 MMKV 里的历史值，见 §4.8。

**登录已端到端打通**（2026-11-01）：发码 → 验证码 → 第二道滑块 `drag/validate{sceneType:"LGN"}` → `smsLogin` 200 → 解 `sData` 拿到 AT/RT → 带 `Xp-Uid=<uid>` 打业务接口 200。三个必要条件：第二道滑块场景是 `LGN`（不是发码用的 `SMS`）、换 token 打 `v5/smsLogin`、解 `sData` 必须用同一次请求的服务端密钥池。

**MQTT 车控已打通 14 条**：解锁、锁车、闪灯、遮阳帘开关、空调开关、设温度、全车车窗升降、极速降温、极速升温、高温抑菌、鸣笛、哨兵开关、哨兵灵敏度、临停。均实测成功并有 `code:200` 回执。车主账号真机点击取证另确认：远程查看的开流、后/左/右视角切换及前视初始化走 `service_type:11 / cmd_type:2`（§5.7）；官方名称「远程启动」走云端 MQTT `service_type:9 / cmd_type:6` 加服务端签发的动态 `<TOKEN>`，BLE 路线可并存（§5.6）。未打通的是单扇车窗、除霜、内外循环、座椅加热通风、智能清洁/除味/香氛（风量官方 App 无此功能）；后备箱开合仍走 BLE。`avm_exist=0` 与 `camera_status=-2` 不能再判定实时视频物理不可用。

**BLE 链路：P5V2 目标发送路径与 V3 native 必须区分。** 握手第二步 `ef0110` 的 KDF 已完全解出（§6.13）：`HMAC-MD5(MD5(hexIncrement(keyString[-10:][:8])), app_n‖car_n)`，188/188 组真实样本命中，Python 与 TS 双实现。`keyString` 是**当前 GATT 连接对端模块自己的 MAC**（§6.13）。命令帧此前被车端静默丢弃的真因是 CRC 覆盖范围算错（只覆盖 payload、不含 type 字节，§6.15），不是抓不到报文。

**P5V2 的 `ed1118` verifyKey 已找到并与历史样本独立匹配**：目标发送路径是 Java `CarCtrlVerifyPackager` 的 AES-CBC/零 IV/NoPadding；本地 `tee` 缓存 phone key 解开 31 条不同历史密文，31/31 的末 12 字节全零，watch key 为 0/31（§6.14）。V3 native 的 XOR/TLV 与 sessionKey 派生另属一条路径，仍有未知量，不能套用到本车 P5V2。隔离验收入口使用本地注入的一次性材料已在本车实跑三段握手、严格挑战校验及解锁/锁车写入，用户现场确认车门解锁和锁上（§6.14、附录 §6.92）。自研生产包随后在**已有登录态**下完成 P5/DF 的 BLE-only 解锁/锁车真车验收：登录后自动准备钥匙物料、Control 页按钮路由到 `autoConnect=true` 的 GATT 连接，各只发一次，用户现场确认车门解锁和锁上；两份日志均无 MQTT 车控发布。该验收仍不等于无钥匙账号激活、其余 5 个命令、标准命令回执或车况 UI 刷新已闭环。§6.35e 的坏帧实验不能证明握手是硬前置（§6.21）。

| 子问题 | 状态 |
| --- | --- |
| 请求签名（双层 HMAC） | ✅ 闭环 |
| appId / secret | ✅ `xp_xmart_android` / `<XP_SECRET>` |
| 客户端证书 | ✅ 可提取，国内主机不要求 |
| 钥匙物料链（tenant → 密钥池 → 本地密钥） | ✅ 闭环 |
| `Xp-Authorization` 信封 | ✅ 闭环（分版本，见 §3.3） |
| 登录 | ✅ 端到端闭环（§4.2） |
| 令牌续期 | ✅ 闭环 |
| MQTT 连接与凭据 | ✅ 闭环 |
| MQTT 车控指令 | 🟡 14 条可固定参数下发；临停/远程查看/远程启动另见真机取证结论（§5.6、§5.7） |
| 远程查看 | ✅ 车主账号真机逐项点击，确认初始化/拉流/后/左/右切换/关流的 `cmd_value` 与四个单路视角的 `camera_type` |
| BLE 帧格式与指令码 | ✅ 闭环（§6.7、§6.15） |
| BLE 握手 `ef0110` | ✅ KDF 解出，188/188（§6.13） |
| BLE 握手 `ed1118` | ✅ P5V2 隔离验收入口已在本车完成严格挑战校验；V3 另有未知（§6.14） |
| BLE 车控帧下发 | ✅ 隔离入口与生产登录态下的 BLE-only 解锁/锁车均已各一次并由用户现场确认；其余命令未验（§6.14、附录 §6.92、§6.93） |
| 自研端 BLE 代码 | 🟡 DF 的 7 个有抓包实证动作已接 P5V2 路由（`Control.tsx` / `ble-v2-routing.ts`），失败不回退 MQTT；其余走 MQTT。生产登录态的解锁/锁车已实车验收，新增动作的材料绑定、无钥匙账号激活和车况 UI 刷新仍待验 |


---

## 1. 加固与静态分析边界

### 1.1 易盾加壳

- 加固商：网易易盾。5.19.0 壳版本 `7.6.0_744`，4.2.0 为 `7.4.7.15`（`com.netease.nis.wrapper.MyApplication.VER`）。
- 5.19.0 的 `classes.dex`（120,255,620 B）头部声明 1547 个字符串、30 个类，全部是 `com.netease.nis.wrapper.*`；`file_size` 与整文件长度一致、adler32 校验和正确，即 **dex 头本身未被破坏**，但字节码被整体加密。
- 5.19.0 额外带 `libNetHTProtect.so`（3771960 B）与 `libijiami_H5SDK.so`；**4.2.0 没有这两个库**，只有易盾的 `libnesec.so`/`assets/libnesec64`。两者加固层级不同，但 dex 都被加密到只剩 30 个壳类（4.2.0 的 dex 为 40,395,592 B，反编译同样只出 30 类）。


### 1.2 4.2.0 与 5.19.0 的协议差异

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


### 1.3 静态分析为何不可行

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


### 1.5 版本对比与选型

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


### 1.4 5.19.0 的 dex 是空壳：类名全是诱饵，代码只在运行时内存
`work/apk/XP_MobileAPP_Android_gw.apk` 里只有一个 `classes.dex`，120 MB。它的头部字段：

```
class_defs_size = 30
string_ids_size = 1547
```

而 `strings` 里能搜到 **1571 处** `com/didi/davinci/digitalkey`。**类名全部存在于字符串池，但 dex 里只有 30 个真正的类定义。**

jadx 对这个 dex 报 `Input class not found: com.didi.davinci.digitalkey.ble.encrypt.MonaBleKey`——名字在、类不在。

**结论：这个 dex 是诱饵。** 360 壳（`com.secneo.apkwrapper`）把真实字节码搬走，只在字符串池留下名字，静态反编译拿不到任何业务逻辑。此前所有「在 dex 里搜到类名/方法名」的结论都只能当字符串证据，不能当实现证据。

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


### 2.7 不要复用 App 的 `tee`：自研客户端应独立注册

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


### 2.8 没有证书 pin，但有私有 CA 信任锚

- 四份网络配置（`network.xml`、`jz_network_security_config.xml`、`network_security_config.xml`、`network_security_config_2.xml`）只有 `<base-config>` / `<domain-config>` 的 `cleartextTrafficPermitted`，**无 `<trust-anchors>`、无 `<pin-set>`**；dex 内无 `sha256/` 形式 pin 常量。
- `res/raw/my_ca.pem` 是一张 Charles Proxy CA，但四份配置都没引用它，dex 内 `raw/my_ca` 命中 0，属开发期遗留。

**但「没有 pin」不等于能 MITM**。`apps*.xiaopeng.com` 的服务端证书由 `CN=Xiaopeng Motors Intermediate CA`（`O=XiaopengMotors Ltd`）签发，App 对这批主机持有自家私有 CA 作为信任锚，系统 CA 对它无效。而 `collect`/`sentry` 用 DigiCert RapidSSL，系统 CA 一装就能解密——这个对比证明 CA 安装方式没问题，差异在信任锚。详见 §4.3。

---


---

## 3. 信封体系

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

实验 A 是关键：服务端用同一把密钥解开了我加密的数据，证明 `XA` 是客户端→服务端的正确标记。

**注意这里的「本地 Key7」指的是当次从 `teeIndiv4App` 取回的池的第 7 槽，不是 `tee` 文件里的 `XmartV1LocalKey7`**（2026-11-01 澄清）。两者不是一回事：同一时刻对比可见 10 个槽全部不同，用 `tee` 文件里的密钥签名恒 `12110009`。上表三行的结论（XA 标记正确、内层签名会被校验、信封解不开是 `12110009`）不受影响。


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

`WEEB` 前缀**不能剥掉**：整串直接 base64 解码得 1075 B，开头正好是 `58 41 01` = `XA` + `ver=1`。


### 3.3 版本差异：`tee_id` 必须分版本处理

这是最容易踩的坑，两个方向都实测过：

| 版本 | 带 `tee_id` 段 | 不带 `tee_id` 段 |
| --- | --- | --- |
| **5.19.0** | ✅ `200` | ❌ `12110009` |
| **4.2.0** | ❌ `12110009` | ✅ `200` |

即 `tee_id` 的有无必须跟着**产生 token 的那个 App 版本**走。5.19.0 的 `tee` 里有 `tee_id` 键，4.2.0 没有，这不是巧合。

`probe.build_auth()` 已支持：`tee_id` 传 `None`/空串时不写 `tee_len` 段。

**另一个可用性**：`XA` 信封可以把 `refreshToken` 递给服务端。把 RT 放进 `XA` 内层调 `/sso/app/v3/token/refresh`，返回 `12010201`（不是签名错误），说明服务端正常读取了内层 RT 并判定失效。

---


---

## 4. 登录与会话

登录链路（`/sso`、`/verification`）走 `apps-uc.xiaopeng.com`，该主机强制 mTLS（`work/certs/client-cert-0.pem`），且要求完整 `Xp-Authorization` 信封——只用外层签名得 `12110002`。业务接口在 `apps.xiaopeng.com` / `dragon.xiaopeng.com` / `chargegateway.xiaopeng.com`；uc 主机上没有业务路由（业务路径返回非 JSON 的 404），不能拿登录通道代替业务通道。

### 4.1 链路总览

官方登录是**两道滑块**夹三步接口：滑块(发码) → 发码 → 验证码 → 滑块(换 token) → 换 token。

| 步 | 端点 | 职责 |
| --- | --- | --- |
| 1 | `POST /verification/app/v5/sms/code` | 发短信；响应 `Set-Cookie: XP-Xid=<uuid>` |
| 2 | `POST /verification/app/v3/sms/validate` | 校验短信验证码，把通过状态写入会话 |
| 3 | `POST /sso/app/v5/smsLogin` | 只带 `mobile`，从会话取状态换 token |

**三个必要条件，缺一即失败**：

| 条件 | 错的样子 | 后果 |
| --- | --- | --- |
| 第二道滑块场景用 `LGN` | 用 `SMS`（发码那道） | `smsLogin` 恒 `12040101` |
| 换 token 打 `v5` | 只试 `v3` | `12040101`（`v3` 仍要滑块，非旁路） |
| 解 `sData` 用**同次请求的密钥池** | 用本地 tee / 事后重取 | `InvalidTag` |

换到 token 后打业务接口必须带 `Xp-Uid` = `sData.uid`（见 §4.7），否则恒 `12010101`。

实现见 `scripts/login.py`、`scripts/login-ui.py`。

### 4.2 会话钥匙 `Xp-Xid`

`sms/code` 首次响应下发 `Set-Cookie: XP-Xid=<uuid>`；后续请求把这个 uuid 放进 **`Xp-Xid` 请求头**，服务端才进入「校验票据」模式。放 Cookie 而非请求头会退回 `12040101`。

| 请求形态 | 响应 |
| --- | --- |
| 无 `Xp-Xid` 头，body 带任意 `validate` | `12040101 请验证滑块验证码` |
| 有 `Xp-Xid` 头，body 带 `validate`（含垃圾值、空串、已用过的票据） | `12040106 滑块验证码校验不通过` |
| 有 `Xp-Xid` 头，body 不带 `validate` | `12040106` |

带 `Xp-Xid` 只把错误码从「要求滑块」翻成「滑块不通过」，**不表示票据被真正校验过**——所以 `12040106` 不能用作票据有效性判据。

**发码必须两步**：服务端只在已有会话的请求里校验票据。首个请求没有 `XP-Xid`，无论票据真假一律 `12040101`，但该响应照样下发 cookie。因此先发一次无票据请求拿 xid，再带 xid + 票据重试。已实现于 `scripts/login.py:send_code`。

### 4.3 滑块通道：`drag/validate`

`POST /verification/app/v3/drag/validate`，body 为明文 JSON（非加密）：

```json
{"sceneType":"LGN","mobile":"…",
 "captchaId":"f6c14777879d4a75b683b29be6709db6","validate":"CN31_…"}
```

- 成功返回 `{"code":200,"data":{"valid":true}}`；票据无效是同一个 code 但 `valid:false`——**200 只代表请求成功，判定看 `data.valid`**。
- 缺 `type`/`sceneType` 报 `12051101 请求参数异常`；四字段齐全但票据无效报 `12051100 操作失败`（与垃圾票据同码，**无法用它验票据**）。
- `captchaId` 必须带，服务端靠它定位验证码实例；全量搜 App 数据目录只有 `f6c14777…` 一个值，来自运行时内存的 `NetEaseCaptchaId`，与易盾 H5（`cstaticdun.126.net/api/v2/mobile.v2.8.1.html`）一致。
- **票据一次性**：`drag/validate` 成功即消费，重复提交返回 `valid:false`。每张票据只能测一次。

**`sceneType` 白名单（6 个）**：`LGN` / `SMS` / `RESET` / `REG` / `RESET_PASSWORD` / `CANCEL_ACCOUNT` 返回 `200`（`data.valid` 为判定值），其余全部（含 `LOGIN`、`SMS_LOGIN`、`REGISTER`、`BIND`）返回 `12051100`。`SMS` 是发码前那道滑块，**`LGN` 是 `smsLogin` 前那道**。用垃圾票据即可枚举场景，不消耗票据、不影响会话。

**票据生成机制**：易盾滑块是 App 的普通依赖库 `com.netease.nis.captcha`（与加固壳 `com.netease.nis.wrapper` 是两个独立包），运行在独立 WebView 沙箱进程（`com.google.android.webview:sandboxed_process0`）。票据是 `CN31_` 前缀的加密串，客户端无法自验（易盾 check 接口需私有密钥），只能靠小鹏的 `drag/validate` 判定。

**纯脚本过不了**：用 Chrome + CDP 驱动同一份易盾 H5、按缺口拖动、客户端回调 `result=true` 拿到 531 B `validate`，服务端仍判失败；接口直连下发短信对任何号码（含真实号）统一 `12051401 短信发送失败`，而 App 界面路径成功。自研客户端必须由人在本地页面拖一次滑块（`scripts/login-ui.py`），不要试图绕开。

### 4.4 `smsLogin` 前的状态机与三个错误码

| `smsLogin` 返回 | 会话阶段 | 含义 |
| --- | --- | --- |
| `12001402 短信验证码错误` | 验证码未过 | 没调过 `sms/validate`，或验证码错 |
| `12040101 拖动滑块验证码` | 验证码已过、待滑块 | 第二道滑块窗口已开，须提交 `LGN` 票据 |
| `12040106 滑块验证码校验不通过` | 滑块尝试已消耗 | 未提交票据却重复调用，或票据无效 |

**每调一次 `smsLogin` 就消耗一次滑块尝试机会**，同一会话内反复试探会从 `12040101` 衰减到 `12040106`；这与 `drag/validate` 无关，纯属调用次数副作用。`v5/login` 同样如此（三次连调：`12040101`、`12040106`、`12040106`）。

`smsLogin` **不读任何票据字段**：body 加 `validate`，或加全套 `sceneType`+`captchaId`+`validate`，或改用 `code`/`smsCode`/`verifyCode`，返回码与只带 `mobile` 完全一致（`12001402`）。`XP-Ptoken`/`XP-PtokenType` 请求头同样无效。

### 4.5 验证码校验 `sms/validate`

必填 `{mobile, smsType, code}`。`smsType` 只要非空即可（`1`/`2`/`11`/`21`/`31` 结果一致）；假码统一 `12051403 短信验证码已过期`（说明服务端确实在校验码）；会话缺失或过期返回 `12051102 session会话过期`。缺字段会明确报 `code不能为空`、`smsType不能为空`。

### 4.6 换 token：`v5/smsLogin` 与 `sData`

`smsLogin` 成功返回 `{"code":200,"data":{"sData":"…"}}`。自研侧打 `v5/smsLogin` 同样收到 `sData`（`data_keys=['sData']`），说明 `sData` 是**服务端按请求特征下发**的，不是按端点版本区分。

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

内层 JSON 字段集合与 5.19.0 `token/refresh` 的返回一致；`accessToken` 再解一次才是 968 B JWT。

**解密密钥必须来自当次请求的服务端密钥池，不是本地 tee**：

- `selfclient.keys()` 每次调 `/biz/v5/secure/teeIndiv4App` 取一套 10 槽密钥池，请求信封用的就是这套，服务端加密 `sData` 用的也是同一套；连续两次调用 10 槽全不同。
- 本地 `tee` 里的 `XmartV1LocalKey*` 是设备自己存的另一份，与服务端按 deviceId 下发的不保证同步——用它解报 `InvalidTag`。
- 4.2.0 与 5.19.0 的 `XTeeSecurityAlias` RSA 私钥不同（keystore 里只有当前安装那一把），跨版本解也失败。

因此「发 `smsLogin` 那次的池」必须与响应绑定保存，事后重取一定解不开；`unwrap_sdata` 以服务端密钥池为主、tee 仅兜底。`token/refresh` 的返回同样只能用同次请求的池解开（AT idx=7、RT idx=5），所以 `renew.py` 必须把「请求所用的池」和响应一起带出。

`mqttAccount` 为空不影响 MQTT：它只是登录响应里的参考值，真正的 MQTT 凭据由 `POST /biz/v5/mqtt/createMqttAccount/app` 独立签发（§5.2）。

### 4.7 业务请求的 `Xp-Uid`

`Xp-Uid` 参与内层 `xpSign` 计算，必须在算签名**之前**设好，且等于 `sData.uid`：

| `Xp-Uid` | 返回 |
| --- | --- |
| 不设（`base_headers` 默认 `0`） | `12010101 登录状态已过期` |
| `10000000`（`sData.uid`） | `200`，列出车辆 |

错误码分界：`Xp-Uid` 设了值但与签名不一致，服务端报 `12110009 服务器开小差`（信封解不开）；没设或设错但签名自洽，报 `12010101`。

内层明文只需 `{"xpSign":…}&accessToken=<JWT>` 就够。真机业务请求内层约 2111 B，是因为它多塞了 `refreshToken`，长度吻合不是必要条件。

密钥池必须每次请求现取，复用上一次的池会 `12110009`。

### 4.8 令牌结构与真实寿命

登录成功后 token **不在 HTTP 头里**，而在内层明文末尾：

```
UUID + base64({"xpSign":"…"}) + "&accessToken=" + JWT(968 B)
```

post-login 的 canonical 头集合与登录前不同：出现 `XP-UID`，`appVersion`/`brand`/`deviceModel`/`osVersion`/`versionCode` 改为小写形式，另加 `XP-OTA-DATA-WITH-OBJECT-VALUE=1`、`XP-OTA-DATA-WITH-VERSION=1`；`XP-TEE-ID`、`XP-PTOKEN` 不再作为独立头出现（TEE 值仍嵌在 `Xp-Authorization` blob 内）。

JWT 三段：

| 段 | 内容 | 长度 |
| --- | --- | --- |
| header | `{"type":1,"version":"1.0.0","alg":"HS256"}` | 42 B |
| payload | `{"sub":"<650 B 密文>"}`——**只有 `sub`，没有 `exp`/`iat`/`nbf`** | 650 B |
| sig | — | 32 B |

「2 小时」完全来自响应里的 `expiresIn=7200`，是给客户端的建议值，不是服务端强制失效点。实测（签发 10-29 22:29:06，打 `/biz/v5/vehicle/v2/myVehicles`）：

| 年龄 | 结果 |
| --- | --- |
| 2.00 h | `200`（声明值刚到期） |
| 2.53 h | `200`（最后一次有效采样） |
| 2.57 h | `12010101 登录状态已过期` |

**真实寿命 2.53–2.58 h，比声明值宽约 33 分钟（≈1.28×）**。失效是硬边界：跨过后所有业务接口统一 `12010101`，没有降级、没有只读，宽限期不能当余量用。

### 4.9 续期

`POST /sso/app/v3/token/refresh`，`refreshToken` 放在**内层明文**里（`…&refreshToken=<值>`）；放 body 无效，报 `12010203`。

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `expiresIn` | 7200 | accessToken 2 小时（建议值） |
| `refreshExpiresIn` | 7776000 | refreshToken 90 天，**滑动续期** |

一次登录后只要 RT 不过期即可无限续期，不再需要人工登录。端到端验证连续 5 次：refresh `200` → AT/RT 各 1436 字符 WEEB → 各解出 968 B JWT → 业务请求 `200`。

两个硬约束：

1. **输入必须用 `eyJ…`，返回的 `WEEB…` 不能回灌**：同一 `eyJ` RT 可反复使用，把响应的 `WEEB` 当下次输入立刻 `12010204`。
2. **高频调用会废链**：十几次后返回 `12010202`，该 RT 永久失效——反复调 refresh 会把整条令牌链作废。

实现：`scripts/renew.py`（`status` / `renew` / `auto`）。token 落 `work/live/{access,refresh}_token.txt`（0600），不进版本库。

### 4.10 token 与 deviceId 绑定

`deviceId` 存在 `shared_prefs/device_id.xml.xml`（键 `device_id`），**App 每重装一次就换一个**。签名用的 DI 与之不一致时，真实有效 token 也会被拒：

| 来源 | 错误码 |
| --- | --- |
| 空 token | `12010103` |
| 真 token 但 DI 不匹配 | `12010104 登录状态已过期，请重新登录` |

**两者不同即证明信封解开了、token 被读到了**，问题在身份层，不是签名/信封格式/过期。同步 DI 后错误码从 `12010104` 变为 `12010101`（继续走正常过期判定）。

`unseal-token.py` 的 `sync_device_id()` 每次解 token 前从模拟器读当前 deviceId 并写回 `work/local.env`；读取失败时会静默沿用旧值，那正是 `12010104` 的直接来源。

排查顺序：先比空 token 与真 token 的错误码——不同则查 deviceId，相同才是 token 本身的问题。

### 4.11 单会话约束

同一账号同时只允许一个有效会话，自研客户端登录会把官方 App 踢下线，**尚无共存办法**。`12010101` 同时表示「过期」与「被新登录顶掉」，两者错误码相同、文案无法区分，只能靠本地记录的签发时刻判断。

### 4.12 MMKV 追加写陷阱

`tee` 文件里 `accessToken` 出现 4 次（offset 1177 / 4428 / 7742 / 7835），`refreshToken` 同样 4 次。MMKV 是**追加写**，同一个键保留多份历史值，**最新的在最后**。

`unseal-token.py` 的 `mmkv_read` 必须用 `buf.rfind(name)` 取最后一次出现；用 `buf.find()` 会读到登录前那份已失效的旧 token（现象：解出的 token 尾部不随重新登录变化，`renew.py status` 返回 `12010101`、`renew` 返回 `12010201`，而 App 自身工作正常）。

**判据**：解出的 token 尾部是否随重新登录变化——不变即读到了历史值。

### 4.13 端点版本矩阵与不可用端点

对两个关键端点扫 v1~v7（只读、编造号码）：

| 版本 | `drag/validate` | `smsLogin` |
| --- | --- | --- |
| v1 | `12051100` | `12001100` |
| v2 | `12001216 无效的appId或签名数据` | `12001100` |
| v3 | **`200` + `data.valid`** | **`12001402`**（业务层） |
| v4 | `12051100` | **`12001402`**（业务层） |
| v5 | `12051100` | **`12001402`**（业务层） |
| v6 / v7 | `12051100` | `12001100` |

`12001100` / `12051100 操作失败` 是「路由未命中」兜底，业务层错误码才表示端点真实存在。**不存在更高版本的无滑块登录入口**；dex 字符串池里只有 `v5/smsLogin`，v3/v4 是服务端保留的旧路由。

其余端点结论：

| 端点 | 结论 |
| --- | --- |
| `POST /sso/app/v5/login` | 密码登录，见下 |
| `/sso/app/v3/sms/codeForApp` | 不可用：任何 body 形状（含全字段）在两个主机上一律 `12001100`，字段校验之前就失败 |
| `qrcode/*`、`authToken/code`、`getWidgetToken` | 非登录入口：空 body 全部 `12010103 登录状态已过期`（登录类端点会报具体字段缺失），是登录后的功能接口 |
| `/verification/app/v3/{sms/validateByUid,sms/validateByUidAndMobile}`、`v5/{sms/codeByUid,sms/codeByUidAndMobile}` | 需登录态，`12010103` |
| `/sso/app/v3/smsLogin` | 可用，但**仍要第二道滑块**（`12040101`），不是旁路 |

`v5/login` 的实测特性：

| 观察 | 含义 |
| --- | --- |
| `password` 填 `x` / `wrongpwd123` / 32 个 `a` 结果一致 | 密码在服务端未被真正校验，非空即可 |
| 缺 `password` 报 `12001101`，有 `password` 报 `12040102` | 字段分层；与 `smsType`（1/2/11/21/31/41）无关 |
| 它不认 `verification` 主机的发码 | 真实发出的短信，`v5/login` 仍 `12040102 请输入正确的验证码` |
| 真实号验证码通过后仍返回 `12040101` | 与 `smsLogin` 共用同一道滑块闸门 |

`v5/login` 只校验、不下发，必须先有一次成功的 `sms/code`，因此它不是可用的登录入口。

### 4.14 `oneclickLogin`（存在，未验证）

dex 里存在完整的运营商一键登录栈，不经短信、不经任何滑块：

| 项 | 值 |
| --- | --- |
| 端点 | `POST /sso/app/v3/oneclickLogin`、`/sso/app/v4/oneclickLogin` |
| 必填字段 | `accessCode`、`token`（缺任一报 `12001101 xxx不能为空`） |
| 垃圾值返回 | `12001283 一键登录操作已过期，请重试`（对任意非空值恒定） |
| 客户端来源 | `com.cmic.gen.sdk`（移动）、`com.unicom.online.account.kernel`（联通）、`ctGetToken`（电信） |

`accessCode`/`token` 由运营商 SDK 在**本机 SIM 卡**上换取，与易盾、与小鹏的风控画像无关；若该入口对小鹏侧开放，将绕开短信验证码与两道滑块。

**未验证**：`12001283` 恒定说明服务端在验签/解密前就按「取号会话不存在」失败，错误码无法判断格式。真正判别需要真机 + 真实 SIM 跑运营商 SDK 取号，模拟器无网关鉴权能力。若可用，单会话约束同样适用（会把官方 App 踢下线）。

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

车主账号真机点击取证时，独立 clientId 可以连上 broker 并订阅下行 `Xmart/Msg/User/<uid>`、`Mona/Msg/User/<uid>` 与 `Xp/Msg/Push/<deviceId>`；broker 对上行 `Xmart/Send/User/<uid>` 与 `Mona/Send/User/<uid>` 的订阅回 `Unspecified error`。App 发出的请求报文不能靠订阅上行主题取得，本轮改用「下行回执的 `msg_ref` 与点击瞬间单次堆样本中 `msg_id` / `protocol_ver` 邻域配对」还原。


### 5.4 报文格式

`msg_content` 是 **JSON 字段**，不是字符串拼接。唯一可用格式：

```json
{"protocol_ver":"2.0","target_id":"<VIN>","msg_id":"10<uid><ts><2位>",
 "msg_type":2,"service_type":12,"msg_content":{"cmd_type":4,"cmd_value":1}}
```

- `msg_id` = `"10"` + uid(8) + 毫秒时间戳(13) + 2 位随机数 = 25 位。
- `msg_type:2` 是请求；`msg_type:4` 是心跳/注册，不带 `msg_content`。
- **回执机制**：请求带 `msg_id`，回执带 `msg_ref` 与之对应，可直接配对。`msg_type:1` 表示事件/响应。

**下行报文的两种形态**（2026-11-01 自研客户端实测）：

- `st=19` 的回执把整包状态**直接放在 `msg_content` 顶层**（顶层键就是 `msg/code/instant/interval/digital_vehicle`），没有 `status` 之类的包装层。判据取「有没有 `instant`」。
- 车控指令（`st=12` 等）的回执 `msg_content` 里**只有该动作涉及的字段**，例如开遮阳帘只回 `code` + 四个车窗位置 + `sky_sun_shade_position`，**不含 `instant`**。若把这种回执当状态写入界面，所有未推送的字段会全部变空。
- **车辆会主动推 `st=19` 增量状态**，`msg_ref` 不一定等于我们发出的 `msg_id`（配对不上）。这类推送只带变化的子域（开遮阳帘时只有 `window`），必须按子域合并进上一份状态，直接替换会清空 `solarRoof` / `trunkPower` / `chargeStatistics` 等没推的域。


### 5.5 `service_type` 语义表

| service_type | 含义 | 已验证指令 |
| --- | --- | --- |
| 1 | 心跳/空操作，任意 `cmd_type` 都返回成功 | 无实际作用 |
| **3** | **空调** | ✅ `{"cmd_type":1,"cmd_value":0/1}` 开关、`{"cmd_type":2,"cmd_value":N}` 设温度、`{"cmd_type":4}` 读状态 |
| **5** | **灯光** | ✅ `{"cmd_type":1,"cmd_value":1}` 闪灯 |
| **8** | **哨兵模式** | ✅ `{"action":1}` 读设置；`{"action":2,"settings":[{"code":"SENTINEL_MODE_VIDEO","value":1/0}]}` 开关哨兵；同格式写 `SENTINEL_MODE_SENSITIVITY` 改灵敏度 |
| **9** | **门锁 / 车身 / 临停 / 远程启动授权** | ✅ `{"cmd_type":0}` 解锁、`{"cmd_type":1}` 锁车、`{"cmd_type":3}` 临停、`{"cmd_type":6,"token":"<TOKEN>"}` 远程启动 |
| 11 | 远程查看摄像头 | ✅ `{"cmd_type":1,"cmd_value":0}` 读状态；`{"cmd_type":2,"cmd_value":2/11/3/4/5/-1,"pushType":1,"protocolType":2}` 分别初始化到前视、启动拉流、切至后/左/右视角、关闭；从其它视角切回前视的请求未直接留住（§5.7） |
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
| 遮阳帘开/关 | `{"cmd_type":4,"cmd_value":1/0}` | 12 | `sky_sun_shade_position`，**0–100 百分比** |
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

**注意**：`service_type:9 / cmd_type:0` 是**解锁动作**，不是状态查询。`cmd_type:3` 是**临停动作**，也不是只读门锁查询。

**临停（`st=9 ct=3`）真机点击取证**：App 首页「临停」按钮发出的真实请求是 `{"protocol_ver":"2.0","msg_id":"<ID>","target_id":"<VIN>","service_type":9,"msg_type":2,"msg_content":{"cmd_type":3}}`。车辆下电时回 `{"code":10905,"msg":"车辆已下电，临停不可用"}`；车辆上电时同一请求回 `code:200` / `msg:"成功"`，回执 `msg_content` 同时带 `temp_lock_st`、`driver_door_lock_st`、四个车门 `ajar_st` 与 `trunk_ajar_st`。因此 10905 是下电拒绝码，临停的状态字段是 `temp_lock_st`，不是只读门锁状态。`st=9 ct=4/5` 在上电状态下的语义仍未测。

**后备箱开关不在 MQTT 通道（2026-10-30 22:05 定论，10-31 用户确认）**：App 操作后备箱时提示「蓝牙未连接」，必须连蓝牙才能操作。同时 `CallbacksManagerV1` 的完整回调类清单只有 4 个——`CarCameraControlCallback`（摄像头 st=11）、`CarDoorLockControlCallback`（门锁 st=9）、`CarWindowControlCallback`（车窗 st=12）、`PowerControlCallBack`（电源），**没有任何后备箱回调**。REST 侧 `/sp-vowner-mapp/p/api/rvc/v2/openTrunk` 在 `apps-booster`（唯一要求 mTLS 的主机）上返回 `Content-Length: 0`，与其他 `/sp-vowner-mapp/*` 表现一致。结论：后备箱开关走 **DiDi Davinci 数字钥匙 BLE** 的 `CarService.OpenTrunk` / `CloseTrunk`，与 `startCar` 同属一类，不在云端 MQTT 体系内。

**自研客户端要实现后备箱开合，只能复用 §6 的数字钥匙栈**，无法用 MQTT 补。10-31 09:52 的监听复核（点「后备箱」→ 确认弹窗 → 取消，全程零下行报文）与本结论一致，但该次未点「确定」，因此报文层面的最后一步仍是 App 侧提示与代码结构的证据，不是抓包证据。

**注意区分两个「后备箱」**：`trunkPower`（`powerSwitch`、`timeToPowerOffInMin`）是**后备箱 220V 供电**，由 `handlerTrunkPower` 承载、走 MQTT；与开合箱门是两回事，后者走 BLE。用户明确只要箱门开合。

**「解锁并启动」的真实语义（2026-10-30 22:35 用户实测厘清）**：它**不是**点火，也**不点屏**。实测三项事实：

1. 「仅解锁」与「解锁并启动」都会解锁车门，但都不点亮大屏；
2. 区别在 `remote_start_status`——「解锁并启动」把它从 `0` 置为 `1`，App 首页「远程启动」图标随之点亮并显示 **120 秒倒计时**；「仅解锁」保持 `0`；
3. 两者 `car_igon_state` 都保持 `0`，即车辆未点火。

所以它是**解锁车门 + 打开远程启动授权窗口（120 秒）**，面向「身上没带实体钥匙」的场景：窗口内踩刹车挂挡即可开走。用户此前的车「解锁后就能启动」是因为**实体钥匙一直放在车内**，与 `remote_start_status` 无关。

**判据修正**：判断「远程启动是否被打开」只能看 `st=19` 的 `instant.power.remote_start_status`，**不能用 `car_igon_state`**。

**本轮真机点击取证补正**：官方 App 的「远程启动」按钮确实发出云端 MQTT 请求，真实报文是 `service_type:9 / msg_type:2 / msg_content:{"cmd_type":6,"token":"<TOKEN>"}`；`<TOKEN>` 是服务端签发的动态数字钥匙帧（`XPBKTH + KI / ED / SN`，`SN` 为 ECDSA P-256 签名），不是可本地生成的随机串，不入库、不贴值。历史堆样本里存在两份不同的 `XPBKTH` 结构帧指纹，其中仅一份与本次 `ct=6` 报文同帧出现；它们说明这类服务端帧并非常量，但不能单独证明该 `ct=6` 帧的一次性或 TTL，TTL、一次性与重放错误码未验。埋点同时出现 `action:"remote_start"`、`service_type:9`、`cmd_type:6`、`code:0`；点击后 `instant.power.remote_start_status` 由 0 变 1，随后回落到 0，`car_power_state` 保持 0，下行 `st=9` 回 `code:200` 并带 `temp_lock_st` 与门状态字段。由此确认远程启动存在非 BLE 云端 MQTT 路线；此前「云端 MQTT 侧不存在、只走 BLE」的判断仅对当时的下行抓包成立，被本轮内存请求帧证据推翻。BLE 路线仍见下文，二者并非互斥。

**启动车辆不点屏**：App 首页「远程启动」点击后弹「请在2分钟内踩下刹车并挂挡」，说明它打开远程启动授权窗口，挂挡仍需人工。BLE 数字钥匙 SDK 是与 MQTT 平行的既有通道。

证据：`com.didi.davinci.digitalkey.mona.CarService` 的完整方法清单里含 `startCar`、`unLockCar`、`lockCar`、`foldMirror`/`unfoldMirror`、`openSentryMode`/`closeSentryMode`、`openProtectMode`/`closeProtectMode`、`operateCamera`、`awakeXpuByImmediateOutbound`，日志前缀形如 `---------CarService: startCar------------`。这是 DiDi Davinci 数字钥匙（BLE）层，与 MQTT 的 `service_type` 体系平行。

早期受控枚举排除过一批固定参数：`st=9 ct=2` → `code:8`；`st=9 ct=4/5 cv=1` → 无回执；`st=9 ct=0` 带 `cv=1/2` 都只解锁（`cmd_value` 被忽略）；`st=6 ct=1 cv=1` 回 `200` 但 `remote_start_status` 保持 0；`st=10 ct=1 cv=1` 无回执且状态不变。这些结果不能推出「MQTT 侧不存在远程启动」：本轮抓到的 `st=9 ct=6` 必须携带动态 `<TOKEN>`，固定参数枚举无法覆盖。`callbacks/v1` 里的 `PowerControlCallBack` 与 `CarDoorLockControlCallback` 并列，说明电源控制是独立回调。

**遮阳帘的 `cmd_value` 是二值开关**（0/1），不是位置百分比。`cmd_value:99/100` 均返回 `code:8`。


### 5.7 远程查看、临停与远程启动的通道边界

**远程查看（实时视频 + 视角切换，`service_type:11`）**：本轮车主账号真机点击取证已打通真实请求形态。

- 读状态仍可用 `{"cmd_type":1,"cmd_value":0}`，返回 `camera_status`、`camera_degree`、`live_push_status`、`camera_type`、`camera_os_switch`、`fileStatus`、`camera_360{camera_front,back,left,right}`。
- 官方 App 的请求都走 `{"cmd_type":2,"cmd_value":N,"pushType":1,"protocolType":2}`；`pushType=1`、`protocolType=2` 恒定。按 `msg_id == msg_ref` 全等配对：`2` 打开/初始化（回 `camera_type=1`、无流地址），`11` 启动拉流（首次回 `camera_live_url`），`-1` 关闭（回 `camera_type=0`、流地址消失）。这些请求来自堆样本中的 `sendVehicleMsgAsync` / `>>>publish` 原文，不是按回执字段猜的。
- 真机逐项点击并用屏幕标题核对物理角度后，四个单路视角的「请求 `cmd_value` → 回执 `camera_type`」为：前 `2 → 1`（默认视角/初始化）、后 `3 → 3`、左 `4 → 5`、右 `5 → 7`。从右视补点左视、从左视切回前视也分别观察到 `camera_type=5` 与 `camera_type=1`；其中补点左视再次精确配对 `4 → 5`。屏幕只有前/后/左/右四个按钮，本车当前界面没有 360、俯视、四宫格或 OMS 入口；其它车型的扩展视角未验。
- 下行 `st=11` 回 `code:200`，`camera_degree=0.0`，`camera_360` 四路均为 1；开流成功帧带 `camera_live_url`。`camera_status=-2` 仍可开流，不能再据此判「无环视硬件」或「车主权限不足」；`avm_exist=0` 与 `camera_status=-2` 分属不同口径。
- `camera_live_url` 内容属运行时凭据，不收录。触发式堆取样并非每次都能留住刚发出的 PUBLISH：从右视切回前视的那一次只有屏幕「前视」与 `camera_type=1` 回执，没有完整请求帧；但初始化时 `cmd_value=2 → camera_type=1` 已有全等配对，且 `3/4/5 → 3/5/7` 构成连续映射。静态侧因 360 壳只留下 `CameraType` / `CAMERA_*` 字符串名与方法名，未找到数值常量或 `switchCamera` 实现字节码；资源 id 与枚举名不能替代这些运行时数值证据。
- 流协议是 **RTMP**：`camera_live_url` 形如 `rtmp://live.xiaopeng.com/xmart/<车机 CDU-ID>?auth_key=<签名>`，每次开流现签、约 2～2.5 小时时效，回执里不带其它播放地址（没有 HLS/FLV 备选）。官方 App 用 WebRTC 库播的也是这一路流；自研端直接用 Media3 ExoPlayer + RTMP 数据源播同一地址即可出画面（2026-11-11 真机验证）。
- **切视角要在流启动之后发**：开流前发的 `cmd_value=2` 在流尚未启动时不落到编码器上，画面仍是上一次查看时的角度，而回执照样回 `camera_type=1`（回执只反映请求被受理，不反映画面真的换了）。开流成功后补发同一条 `cmd_value=2` 才会切到前视。

**临停**：见 §5.6，`st=9 ct=3` 是动作指令；下电回 10905，上电回 `code:200`。此前把它称作「只读门锁查询」的判断已撤回。

**远程启动**：见 §5.6，`st=9 ct=6` 加动态 `<TOKEN>` 是云端 MQTT 路线；BLE 数字钥匙路线仍可并存。`<TOKEN>` 与 §6.54a 的 `token_json.message` 同构，服务端私钥签名、客户端不能本地生成（§6.81c）；候选签发接口是 `POST /digital-key/v1/key/ble/getXpKeyAuthData {vin,cardNo}`，需有效 AT 与一致的 `Xp-Uid` / `deviceId`。本轮用当前本地 AT 单次调用该接口返 `12010101 登录状态已过期`，未重试、未续期、未下发车控；因此 `ct=6` 专用请求形状、TTL、一次性与重放错误码仍未验证，不提供脱离官方 App 的固定下发参数。自研 App 当前没有远程启动入口，这是未来接入的前置条件而非线上缺陷。

**车窗单扇控制**：`service_type:12 / cmd_type:1` 只能一键全车（四窗同值联动），**单扇控制未打通**。`cmd_type:1` 的 `cmd_value` 只接受 1/2；`cmd_type:0/2..15` 配各种 `cmd_value` 全部 `code:8`。

排查过程中 `cmd_type:3 cv=1/0` 曾返回过 `code:15003`/`15004`（vdex 字符串池里没有，属服务端动态码），但复测变为无回执、车窗不动，**未确认语义**，判定为无效组合。

四个车窗**同值联动**，说明云端入口只有「一键全车车窗」。单扇控制若要实现，需走 BLE 通道的 `PositionDef$Windows` + `BCM_WINDOW_TYPE_*`（见 §5.12）。

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
| `/resource/app/v3/userinfoMask` | 主机 `apps.xiaopeng.com`；当前登录账号**本人**资料：`uid`、`nickName`、`mobile`、`headImg`、`type`（子账号实测 `type:4`） |

**`ownerInfo` 是车主、不是登录人**：`myVehicles[].ownerInfo` 为该车车主资料；子账号登录时，它与 `/resource/app/v3/userinfoMask` 返回的登录人资料在 uid、昵称、手机号上都不相同。凡界面要显示「当前登录账号」必须取 `userinfoMask`，不能取 `ownerInfo`。

**`ownerInfo` 不能用来判车主**：车主本人账号登录时 `ownerInfo` 实测也可能为 `null`（同一响应里 `permissions` 同样为 null），拿 `ownerInfo.uid === 登录人 uid` 判定会把车主本人误判成非车主；子账号反而可能拿到有值的 `ownerInfo`，于是旧判据只在子账号上「碰巧正确」。判车主取 `userinfoMask.type`：车主本人 `1`、被分享子账号 `4`。

**权限与钥匙激活无关**：本账号对这台车的 `permissions.remoteControl` 为 `isPermanent:true`、`expireTime:null`，服务端照常返回 19 项车控能力。数字钥匙未激活只影响 BLE 本地解锁，不影响云端车控。

`remoteCapabilities` 返回的能力表含 `SUN_SHADE_SOFTWARE`、`BLE_FLASH_LIGHT_HORN`、`REMOTE_START_4G`、`AUTO_PARK`、`SENTINEL_MODE` 等 19 项。该接口只说明支持，**不给出指令码**。


### 5.11 车型能力配置

`assets/vehicle/config/<车型代码>VehicleAbilityConfig.json` 是静态可读的车型能力表。本车 `DFVehicleAbilityConfig.json`（P5 / `D55`）关键项：`isSupportCarControl:true`、`isSupportBleKey:true`、`bleKeyVersion:2`、`isSupportPollingV1:true`（V2/V3 为 false）、`isSupportRemoteCamera:true`、`isSupportRemoteStart:false`。**写自研客户端时以这份表决定 UI 该显示哪些控件，不要硬编码。**

---


### 5.12 从 vdex 挖到的名称清单（未映射到数值）

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
| 远程查看 | `handleCameraService` | `xpcar/cmd/` 无摄像头 cmd；走 `link/camera/MonaCameraManager.reqRemoteLive` / `startRemoteLivePaket`、`XpCameraManager.reqRemoteLive` | `camera_status`、`camera_degree`、`camera_360.*`、`live_push_status`、`camera_type`、`camera_os_switch`、`fileStatus` | **MQTT 可写**（`st=11 ct=2`，开流/四视角切换/关流见 §5.7） |
| 后备箱 | **无对应 handler**（`CallbacksManagerV1` 也无回调） | `xpcar/cmd/TrunkCmd` + `TrunkCmd$ActionType`，含 `executeByBle` 与 `executeByMqtt` 两条路径；`mona/cmd/TrunkCmd` | `instant.door.trunk_ajar_st`、`instant.trunkPower.{powerSwitch,timeToPowerOffInMin}`（后者是 220V 供电，非箱门） | **BLE**（`executeByMqtt` 在本车不可用） |
| 解锁并启动 | `handleCarDoorService`（只覆盖解锁/锁车） | `xpcar/cmd/RemoteUnlockStartCmd`（含 `onExecuteCmd`、`successPrediction`）、`BleUnlockStartCmd`、`LockCmd`/`UnlockCmd` | `instant.power.remote_start_status`（1=授权窗口开启）、`car_igon_state`（始终 0，不能用作判据） | 解锁走 MQTT（`st=9 ct=0`）；「远程启动」另有云端 MQTT `st=9 ct=6` 加动态 `<TOKEN>`，BLE 数字钥匙路线可并存（§5.6） |

注意 `TrunkCmd` 同时存在 `executeByBle$*` 与 `executeByMqtt$*` 两组内部类，说明代码层面保留了云端开箱路径；但本车实测无 MQTT 报文、无回调、`st=19` 也不含开箱指令回执字段，故该路径对本车型不可用（可能是高配车型或特定市场分支）。

**哨兵开关的字段名**：`SENTINEL_MODE`、`SENTINEL_MODE_VIDEO`、`SENTINEL_MODE_VIDEO_ENABLE`、`SENTINEL_MODE_SENSITIVITY`、`SENTINEL_ACTION`、`SENTINEL_SETTINGS`、`SENTINEL_CLOSED` 均在字符串池里，且各带一个 `_` 后缀的同名资源键（如 `SENTINEL_MODE_VIDEO_`）。实测确认 `SENTINEL_MODE_VIDEO` 是开关位（见 §5.6），`SENTINEL_MODE` 与 `SENTINEL_ACTION` 作为 `code` 写入会被静默忽略。

**`REMOTE_ACTION_CONTROL_*` 埋点事件名**：`CAR_DOOR_LOCK`、`CAR_DOOR_UNLOCK`、`CAR_WINDOW_UP`、`CAR_WINDOW_DOWN`、`CAR_WINDOW_STOP`、`TRUNK`

**`Service*` 服务名**：`ServiceAirConditioner`、`ServiceDoorWindow`、`ServiceVehicleLight`、`ServiceVehicleStatus`、`ServiceSeat`、`ServiceFridge`、`ServiceMedia`、`ServiceScreen`

**空调功能完整清单**（资源键，非协议字段）：`OPEN_AIR_POWER` `CLOSE_AIR_POWER` `OPEN_CLEAN_AIR` `OPEN_DEODORIZE_MODE` `OPEN_FRONT_CLEAR_FROST` `OPEN_FRONT_MIRROR_HEAT` `OPEN_HIGH_TEMP` `OPEN_LEAVE_CAR_KEEP_POWER` `OPEN_MIRROR_HEAT_MODE` `OPEN_PROTECT_MODE` `OPEN_QUICK_COLD` `OPEN_QUICK_WARM` 及对应 `CLOSE_*`

**REST 路径表**（`/sp-vowner-mapp/p/api/*`，共 50 条，静态可读）：`rvc/v1/{openWindow,closeWindow,lockDoor,whistle,findVehicle,doubleFlash,closeTrunk}`、`rvc/v2/openTrunk`、`rvc/v3/getVehicleStatus`、`ac/v2/{turnOn}`、`ac/v1/{turnOff,setTemperature,startCycleInside,startCycleOutside,startDefrosting,stopDefrosting,startSeatHeating,stopSeatHeating,startSeatVentilation,stopSeatVentilation,createSchedule,cancelSchedule,getScheduleDetail}`、`charge/v1/*`、`nfc/v1/*`、`ota/v1/*`。**这些路径在 `apps.xiaopeng.com` 上返回空体（`len=0`），真实网关未定位。**

**为什么这些名称拿不到数值**：vdex 只保存名称池与类型池，字节码在 `classes.dex` 的 120 MB 加密区里。内存中也没有解密后的标准 dex（Yidun 直接解释执行，不落地）。`/data/app/.../oat/arm64/base.vdex` 只有 120,256,660 B 的原始加密 dex 加名称池，`Anonymous-DexFile@*.vdex` 只有 92 B。


---

## 6. 蓝牙钥匙栈

### 6.1 Java 侧（在加密 dex 内，需脱壳）
- `com.xiaopeng.blekey.polling.*` 217 个类：`manager`(79)、`distance`(44)、`config`(25)、`rx`(18)、`defaultconst`(8)；`locksource` 定义 `LockSource`/`UnlockSource`/`LockSourceLevel`。
- `com.xiaopeng.common.car.digitalkey.*` 1206 个类，覆盖 ICCoA、ICCE、CCC 三套标准与华为/小米/vivo/三星/荣耀钱包 SDK。
- 按车型分协议实现：`D22BleProtocol`、`D55BleProtocol`、`E28ABleProtocol`、`E28BleProtocol`、`E38BleProtocol`、`F30BleProtocol`、`H93BleProtocol`、`XpBleProtocolV1V2`、`XpBleProtocolV3`、`XpNativeBleProtocol`。
- 第三方数字钥匙引擎 DiDi Davinci SDK（`com/didi/davinci` 1,571 处引用、1,489 个类）：`MonaBleService`、`MonaBleCommunication`、`BleCommandQueueManager`、`ble/encrypt/AesUtils`、`mona/carserviceimpl/{MnaAcCtrlImpl,MnaCarManagerImpl,MnaCarStatusImpl,MnaChargeImpl,MnaNfcImpl}`。数字钥匙本身即第三方代码，小鹏只做集成。
- 进程模型：`com.xiaopeng.common.car.ble.ipc.BleService` 与 `com.xiaopeng.link.bleenv.BleService` 均在 `:BLE` 进程，`android:exported="true"` 且未声明 `android:permission`；跨进程调用受 `com.xiaopeng.lib.xipc` 约束，框架内含 `RESULT_CALLER_SIGNATURE_CHECK_FAIL`，按调用方签名拦截。
- 本地钥匙存储：SQLCipher（`net.zetetic.database.sqlcipher`）+ `KeyTokenDao`（`XpKeyTokenEntity`、`VehicleCertKeyTokenInfo`、`VehicleXpKeyTokenInfo`、`VehicleMacInfo`）。

### 6.2 Native 侧（未加固，可直接复用）
`lib/arm64-v8a/libbledata.so`（1.18 MB）是蓝牙钥匙的协议与密码学实现。普通 ELF，无壳、无混淆调用链；`.text` 615 KB，`.rodata` 32 KB（可打印率 75%）。

- `JNI_OnLoad`（`0xa31f0`）：先 `FindClass("com/xiaopeng/ble_data_processor/BLEDataProcessor")` + `RegisterNatives`（29 项，表在 `0x127838`），返回 `0x10006`；随后 `FindClass(".../AlgorithmUtils")`，`GetMethodID` 取回 4 个 Java 方法句柄存全局：`hkdfSha256 ([B[B[BI)[B`、`hmacSha256 ([B[B)[B`、`encryptCbc ([B[B[B)[B`、`decryptCbc ([B[B[B)[B`。
- 静态无签名校验、无包名校验：`frida`/`ptrace`/`magisk`/`xposed`/`/proc/self/maps` 检索命中 0；128 个导入符号里与自检沾边的只有 `__system_property_get` 与 `dl_iterate_phdr`。
- 通过 RELA 重定位还原出完整 JNI 方法表 `0x127838–0x127ad8`，29 项签名齐全。核心几项：`native_generateAuth0DataV3 (J[B[BIJZIIII[B[B[B[B)[B`、`native_generateAuth1DataV3 (I[B[B)[B`、`native_generateSessionKey ([B[BII)[B`、`native_generateHmacKey ([BII)[B`、`native_parseBleV3Data (Ljava/lang/String;[B[B[BZ)Ljava/lang/String;`、`native_generateTboxMessageV3 (I[BBI)Lcom/xiaopeng/ble_data_processor/BleByteMatrix;`。

- 导出符号含完整密码学原语：`SDKBleKeyV3::getSessionKey`、`hmac_sha256`、`hkdf_sha256`、`calculateAuth1SessionKey`、`generateAuth0Packet`/`generateAuth1Packet`、`decodePackage`、`createSendData`，以及 TLV 编解码与轮询配置（实体见 §6.17）。BLE UUID 只在 Java 层（native 内 `ED28`/`FF001`/`ABAB` 命中 0），全集见 §6.10。

**复用路径**：自研 App 自建 `BLEDataProcessor`（29 个 native 声明）与 `BleByteMatrix`，`System.loadLibrary("bledata")` 即可复用协议与密码学；额外负担是实现 `AlgorithmUtils` 的 4 个方法（JNI 会回调）。JNI 层无调用方约束。未编译验证。

### 6.3 运行时反调试
静态检索不到反调试痕迹，但运行时存在（Frida 17.24.3，App 5.19.0）：attach 已运行进程报 `process not found`；spawn 注入后 JS 运行时冻结（顶层 `send()` 执行，`setTimeout` 与 `Java.perform` 回调全部不触发）；`libnesec.so` 在 10 秒内被 5 个不同 PID 加载，即检测到注入后重启进程。检测逻辑为运行时生成或藏在加密 dex 内。**结论：不要指望 Frida 做动态分析**（4.2.0 上注入 Java 桥后 App 仍崩溃；5.19.0 上 `frida-server` 存在即触发检测），**内存 dump 是唯一可行的动态手段**（不注入进程）。

### 6.4 钥匙物料来源
物料服务端签发、非本地派生：`/api/bt/v2/get/key`、`/api/bt/v2/create` 挂在 §2 的会话之上，本地以 SQLCipher 存 `XpKeyTokenEntity` 等。提示串 `seed_due_error_info` =「本地密钥已过期，请用户联网进行更新」，即物料有有效期、过期需联网续期。因此 §6.2 可复用的是**协议实现**，输入走 §2.5 的服务端链路。本机 TEE 快照内存在 `XmartV1LocalKey0`–`9` 十个密钥槽位、`IndivKeySet`、`XTeeSecurityIv`、`XTeeEncryptAesKey`、`tee_id`；`XmartV1LocalKey*` 是一次性批量下发的十个槽位，`IndivKeySet` 记录当前用哪个索引（轮换周期未验，§9）。槽位取值属真密钥，不入文档。

**鉴权会话在 App 侧的持久化键**（`classes.dex` 连续字符串块，`53300283` 附近）：

```
KEY_AUTH1_REQ_SESSION_KEY      KEY_AUTH1_REQ_SESSION_KEY#    ← # 后缀是加密版
KEY_AUTHO_RSP_R01              KEY_AUTHO_RSP_R01#            ← 注意是 AUTHO（字母 O），不是 AUTH0
KEY_AUTHO_RSP_R12              KEY_AUTHO_RSP_R12#
KEY_BLE_KEY_STATUS             KEY_BTKEY_ENABLE
KEY_ALIAS                      KEY_AT
```

由此可读出的结构：① 鉴权两轮，`AUTH1_REQ_SESSION_KEY` 是 Auth1 阶段请求的会话密钥，`R01`/`R12` 缓存车端两次响应，命名规则为「R + 请求轮次 + 响应轮次」，`R01` 对应 Auth0 回合、`R12` 对应 Auth1 回合。② 每个键都有普通版与 `#` 版两份，同一份数据存明文与加密副本，或按安全等级择一。③ **`AUTHO` 是代码里的拼写错误**（应为 `AUTH0`），按 `AUTH0` 搜不到，须搜 `AUTHO`。④ `KEY_BLE_KEY_STATUS` 与 `KEY_BTKEY_ENABLE` 分开存：「钥匙已激活」与「蓝牙钥匙开关已开」是两个独立状态。

### 6.5 三条 BLE 栈与下行链路
App 内有**三条互不相干的 BLE 栈**，协议与用途都不同：

| | 数字钥匙（车控） | 车机大屏（VCI） | CarIoT（配件） |
| --- | --- | --- | --- |
| 用途 | 门锁、后备箱、启动、充电口、车窗、寻车、RPA | 座椅、媒体、氛围灯、投影、座舱空调微调 | 充电桩 / 地锁等外设，含即插即充 |
| 传输 | 原生 `libbledata.so` + TBox 帧 | Protobuf `ServiceReq`，Java 侧分片 | `CarIoTDataFrame` + `CarIoTProtocol`（纯 Java） |
| 进程 | `:BLE`（`com.xiaopeng.link.bleenv.BleService`） | 主进程（`VciBleManager`） | `:BLE`（同进程不同 Biz） |
| 鉴权 | Auth0/Auth1 双向挑战，派生会话密钥 | `AuthPackage` 配对（含大屏 PIN 确认） | `CarIoTAuthPackage` |
| 关键类 | `BleSendHandler`、`AuthPeripheral`、`BleBusiness`、`BleConnector`、`XpBleProtocolV3` | `BleConnector`（`com.xiaopeng.link.vci.logic.ble.impl`）、`CmdSelectChannel` | `CarIoTBleBiz`、`CarIoTDataParser`、`CarIoTProtocol$BizId` |
| UUID | `0000ED28-ABAB-…` | 未取到 | `000FF001-ABAB-…` |

CarIoT 由 `com.xiaopeng.link.ble.business.cariot.*` 一整套类证实（`linkble.txt:64–79`），含 `CarIoTProtocol$ChargerAuto$Type`（即插即充）与 `CarIoTDataParser$ChargeAutoResult`；native 内 `iot`/`charger`/`bizid` 命中 0，不走 `libbledata.so`。该链路与车控无关。

**数字钥匙下行链路**（第 3、5、6 段为实证；第 1、2、4 段方法体在加密 dex 内，属推论）：

1. **业务层**：`com.xiaopeng.link.vehicle.common.cmd.CmdExecutor` 把命令排进 `cmdQueue`，`runningCmd` 保证同一时刻只跑一条；命令实例由 `XpCarCmdFactory` / `MonaCmdFactory` 造出。
2. **选路**：命令子类用「实现了哪个 `executeByXxx`」声明能力（`work/ble_analysis/channel_table.txt`）。该表混了两个包的类，必须连包名一起读。数字钥匙栈（`com.xiaopeng.link.vehicle.{xpcar,mona}.cmd.*`）：`XpCarCmd` = `executeByBleWithResult` + `executeByNetWithResult`；`TrunkCmd`/`WindowCmd`/`BonnetCmd`/`SuperLockCmd`/`RoofWindowCmd`/快慢充口/`TrailerHookCmd` = `executeByBle` + `executeByMqtt`；空调各 `Ac*Cmd` 与 `SentinelCmd`/`CarStatusCmd`/`LockCmd` 只有 `executeByMqtt`。车机大屏栈（`com.xiaopeng.link.vci.logic.vehicle.cmd.impl.*`）：`AcRtAutoSwitchCmd`、`AcRtSoftBreezeSwitchCmd`、`AcRtWindFaceSwitchCmd`、`AcRtWindFootSwitchCmd`、`AcSwitchCmd`、`MediaSongSwitchCmd`、`MediaStateCmd`、`ReadingLightSwitchCmd`、`SubscribeVehicleStateCmd` 是 `executeByBle`，走 VCI 的 Protobuf BLE，**不是数字钥匙**。`AcSwitchCmd` 同名存在于 `vci`、`xpcar`、`mona` 三个包，vci 版走 BLE、另两个走 MQTT——只看简单名会得出「空调能走数字钥匙 BLE」的错误结论。判定由 `CmdSelectChannel` 结合运行时状态做。
   **策略枚举实际成员**（`classes.dex` 字符串表连续段，`73497467` 与 `73498554`）：`SINGLE`、`SINGLE_BLE`、`SINGLE_BLE_FIRST`、`SINGLE_NET`、`SERIAL_BLE_FIRST`。没有 `SERIAL_NET`/`SINGLE_MQTT`/`SERIAL_MQTT`/`NET_FIRST`/`BLE_FIRST`。即「BLE 优先，网络兜底」的单向枚举：`SINGLE_*` 单通道单次，`*_FIRST` 先 BLE 再退网络，`SERIAL_BLE_FIRST` 串行重试版。`BLE_ONLY` 在另一处（`36206335`，与 `BLE_CAR_KEY_SERVICE`、`BLE_STATE_*` 相邻），属连接层不属选路层。RSSI 阈值、超时、退避曲线在加密 dex 内，取不到（§9）。
3. **跨进程**：`XpBleSendHandlerOnMain` → `com.xiaopeng.lib.xipc` → `:BLE` 进程。IPC 消息类型是一组 15 个 `TYPE_BLE_*` 常量（`TYPE_BLE_SEND_CONTROL_CMD`、`TYPE_BLE_CONTROL_WRITE_RESULT`、`TYPE_BLE_CONTROL_RESULT`、`TYPE_BLE_STATE_CHANGE` 等）。
4. **连接与鉴权**：`BleBusiness` 持有 `allMacList` / `connectedAuthPeripheralMap`；`BleConnector` 持有 `connectQueue` / `keepConnectSet` / `autoConnectList` / `sendQueue` / `scanResultList`。`BleConnector.connect()` 走 `connectSingle` → 服务发现 → `AuthPeripheral.checkSendNextAuthData` 逐轮推鉴权，`notifyAuthResult` 收口。连接态枚举 `BLE_STATE_DEFAULT/CONNECTING/CONNECTED/CONNECT_FAILED/CONNECT_TIMEOUT`（数值未取到）。
5. **组包与写**：`BleSendHandler.sendCmd` → 具体 Packager（`CarCtrlAuthPackager` / `ECDataPackager` / `EADataBleConfigPackager` / `CarCtrlAuthPackagerV3`）→ native `createSendData` → `BleByteMatrix`（Java 侧 `byte[][]`）→ `BleConnector.sendDataToQueue` 按 `onCharacteristicWrite` 串行出队。
6. **回执**：V3 车型走 native `parseBleV3Data` / `nextBleKeyV3Message` 解出 `BleKeyV3OutputMessage`，按 TLV tag 分派（§6.8）；V1/V2 车型（含本车 D55）走 `DataParser::parse` 的定长 10 字节记录 + `specificityMessage` 分派（§6.11）。两条路最终都汇到 `BleCarStatusParse`（车态）、`BleCarCmdSendStatusParse`（指令 ACK）、`BleNotifyAppOperateParse`（车端主动事件）、`BleRpaStatusParse`（泊车）、`BleLoginInfoParse`（登录会话）。错误码经 `XpErrorCodeHandler` 查 `vsdk_ble_msg_<code>` 资源，兜底 `vsdk_ble_msg_0` / `400`。

### 6.6 下行帧：分片头与 TBox 外层
`BleSendData::sendData`（`0x8af84`）产出最终写入 GATT 的字节，对每个分片输出：

```
[0] channel            // = createSendData 的 BLEKeyMessageType 实参
[1] (i+1) | (n<<4)     // i=分片序号(0基)，n=分片总数；仅 channel ∈ {0xEC,0xED}
[2] chunkLen           // 本分片长度，1 字节
[3..] chunkData
```

`channel == 0xEF` 时第 2 字节取对象 `[+0x1c]`，不是序号位域；其余 channel（`0xEA`/`0xEB` 等）第 2 字节取 `[+0x20]`，只有 1 字节头。分片在 Java 侧完成——`createSendData` 的矩阵重载收到的已是切好的 `vector<vector<uint8_t>>`，native 只给每片加头；切分长度应由 `BleByteMatrix` 的 MTU 决定，D55 能力表报 160（§5.11），native 内无 MTU 常量，未在汇编层证实。

`TBoxMessage::bleTboxMessage`（`0x8b8c0`）在分片**之前**再包一层：

```
[len: 2B Big-Endian][crc32: 4B Big-Endian][type: 1B][payload...]
```

- `len` 是 payload 长度（`rev` + `lsr #16` 后按半字存，即大端）。`type` 取自对象 `+0x18`，在 `createCommandParameters` 里是调用方传入的指令码字节。校验失败无重传，靠上层 `checkResult` 超时兜底。
- CRC32 用 `0x50260` 的 `CRCTABLE`（反射式，多项式 `0xEDB88320`），**只覆盖 payload**，`rev` 后大端写入。**初值为 0，不是标准 CRC-32 的 `0xFFFFFFFF`，无最终异或**；`zlib.crc32` 对不上（实车两帧验证）。

`createSendData` 调用点（channel 实参 / headerType 实参）：

| 构造器 | channel | headerType | TBox `type` 来源 | 用途 |
| --- | --- | --- | --- | --- |
| `createAuthFrameData` | `0xED` | 0 | 对象 `+0x18`（帧内实测 `0x00`） | 鉴权帧 |
| `createCommandParameters` | `0xED` | 0 | 第 1 实参（指令码） | 车控指令 |
| `createCommandParametersWithDecodeToken` | `0xED` | 0 | 第 1 实参（指令码） | 带解令牌的车控 |
| `createLoginUidParameters` | `0xEC` | 0 | 第 2 实参（`w21`） | 登录 UID |
| `createLoginCodeParameters` | `0xEC` | 0 | 第 2 实参（`w21`） | 登录验证码 |
| `createParkingHeartbeatMessage` | `0xEF` | **3** | 不写 type（首两字节由两个实参直接拼成） | 泊车心跳 |

`createParkingHeartbeatMessage` 是唯一把 `headerType` 传 `3` 的调用点（`mov w2, #3` @`0x8d388`），且 `malloc(2)` 后直接 `strb w19` / `strb w20` 写满两字节（`0x8d2e4–0x8d2f4`），**没有 TBox 那层 `[len][crc32][type]`**。`0xEF` 不是泊车心跳专用：实车握手的前两帧就是 `0xEF`，两帧第 2 字节都是 `0x01`（对应 `[+0x1c]` 该值为 1），不能据此认定是分片序号。

`createCommandParameters(uint8 cmdCode, const char* b64Payload, uint16 b64Len, uint8 something)`（`0x8bbf0`）：① `strlen(b64Payload)` → `malloc` → `base64_decode`（`0x113ed0`）得二进制 payload；② `malloc(decodedLen + 1)`，拷入 payload，`strb w0`（cmdCode）写在**最后一个字节**；③ 「payload + cmdCode」整体交给 `bleTboxMessage`。所以 **payload 在 Java 侧是 Base64 字符串**，native 负责解码；**TBox 的 `type` 字节就是业务指令码本身**（写在尾部，由 `bleTboxMessage` 挪到 `[len][crc32]` 之后）。`createAuthFrameData` 则把 `0xE0` 写进 payload 尾部（`mov w8, #0xe0` @`0x8b73c`），该帧 payload 末字节确实是 `0xE0`，而 `type` 读出来是 `0x00`。**抓到的明文 payload 是已解码的二进制，不是 Base64。**

`0xEC`/`0xED` 是 native 的 `BLEKeyMessageType`，与 Java 侧 `BleCmdDefine$CmdType` 是两个不同枚举。`BleCmdDefine$CmdType`、`$DataType`、`$BleConfigType`、`$BleEAChannelPayloadType` 四个内部枚举的名字在 dex 里确认存在（`work/ble_analysis/linkble.txt:20–23`），**取值全部在加密 dex 内**。

### 6.7 车控内层明文：`XPBKTH`
V1/V2 车型（含 D55）的车控内层是明文结构，魔数 `XPBKTH` 可直接搜。`authData`（不含末尾指令码）长度随 DER 签名在 130–132 B 之间变化，故完整内层为 131–133 B。下面是 132 B 样本（含 1 B 指令码）的通用布局：

```
偏移  长度  内容
  0    6B   "XPBKTH"                       魔数
  6    2B   01 00                         含义未定
  8    2B   <len>                          authData 长度（16 位大端；此样本为 0x0083 = 131）
 10    4B   6a 7b 5f e0                  含义未定
 14    2B   <seq>                          服务端序号（16 位大端，按操作递增）
 16    4B   "KI" + len(00 10)             TLV：密钥标识
 20   16B   <KI 值>
 36    4B   "ED" + len(00 10)             TLV：待签名块
 40   16B   <ED 值>
 56    4B   "SN" + len(00 47)             TLV：签名（长度 70/71/72 均有）
 60   71B   DER ECDSA 签名
131    1B   指令码（0x01 解锁 / 0x02 上锁 / 0x04 后备箱 / 0x26 闪灯 / 0x0c 开窗 / 0x0d 关窗）
```

**TLV 编码**：tag 是 **2 字节 ASCII**（`KI`=`4b49`、`ED`=`4544`、`SN`=`534e`），length 是 **2 字节大端**。与 §6.8 的 V3 TLV（二进制 tag、DER 式长度）是两套规则。**tag 宽度是穷举唯一解**：以「末尾 1 字节是指令码」为约束，对 `start ∈ [6,22)`、`taglen ∈ {1,2,3,4}`、`lenbytes ∈ {1,2}` 全排列，只有 `start=16, taglen=2, lenbytes=2` 能让解析恰好闭合到帧尾。故 tag 是 `KI`/`ED`/`SN`。99 条服务端帧逐条解析均恰好闭合到帧尾，无剩余字节。

头部 9 字节中 `6a 7b 5f e0` 作 BE 是 1786470368 = 2026-08-11 17:46 UTC（早于抓包 82 天），作 LE 是 2089 年，含义未定。**`auth[8:10]` 是 `authData`（不含指令码）长度的 16 位大端字段，不是开关方向标志**：2026-11-06 五次逐动作抓包中为 `0x0082`/`0x0084`/`0x0083`/`0x0082`/`0x0083`，分别对应 130/132/131/130/131 B；五次快照共 465 条已解码数据库记录全部满足该不变量，0 处不符。历史把 `0x82`/`0x83`/`0x84` 读作「开后备箱 / 关后备箱、闪灯、关车窗 / 开车窗」是把长度低字节误当方向码，已撤回。`auth[14:16]` 是服务端序号，五次分别为 2/4/6/8/10，也不是 `S`–`Y` flag；外层 TBox `type`（`messageId`）则为 1/2/3/4/5。

**2026-11-10 复核：开/关后备箱的方向既不在材料里，也不在帧里。** 直接读实车数据库（`xp_vehicle_key_message`）确认表结构只有 `id, sortId, user_id, vin, token_json`，`token_json` 键集恒为 `{cardNo, message}`，**无任何方向/动作字段**；取用是 `sortId ASC LIMIT 1` 纯 FIFO。289 条材料的 `ED` 全部互不相同（16 B，289 个唯一值），所以「开帧 ED ≠ 关帧 ED」不构成方向证据——每帧本来就都不同。同一份 btsnoop 抓包里开后备箱/关后备箱/闪灯/开窗/关窗 5 帧的 `XPBKTH` 序号为 85–89 连续，`KI` 五帧相同，**开与关两帧除随机 `ED`/`SN` 和计数器外字节全同**；而闪灯（序号 87 奇）、开窗（88 偶）、关窗（89 奇）同样落在奇偶上，故奇偶只是计数器、不是方向位。材料是服务端**一次性批量预签 300 条**、发请求时不带动作参数，因此材料不可能预知这次要开还是要关——方向只能由车端按当前尾门开合状态决定。客户端侧对应表现为**单个切换键**：`trunk_ajar_st === 1` 时发关闭、否则发打开，两向线上都是 `cmd = 0x04`。这与反编译字符串池里 `openTrunk, lastAjarSt=` / `closeTrunk, lastAjarSt=` 两个方法名各自读上一次开合状态一致。

**历史抓包（7 帧，同一次抓包）**中 `type` 是操作序号 1–7，`auth[15]` 依次为 `S`–`Y`（`0x53`–`0x59`），与 `cmd` 无固定关系；2026-11-06 五次抓包中该偏移是服务端序号低字节（2/4/6/8/10），故 `S`–`Y` 不是稳定字段，不应作为通用字段规则。该次抓包的码表仍保留：

| 操作 | `type` | 历史标志 | `cmd` | 帧长 |
| --- | --- | --- | --- | --- |
| 解锁 | `0x01` | `S`(0x53) | `0x01` | 132 |
| 上锁 | `0x02` | `T`(0x54) | `0x02` | 132 |
| 开后备箱 | `0x03` | `U`(0x55) | `0x04` | 131 |
| 关后备箱 | `0x04` | `V`(0x56) | `0x04` | 132 |
| 闪灯 | `0x05` | `W`(0x57) | `0x26` | 132 |
| 开车窗 | `0x06` | `X`(0x58) | `0x0c` | 133 |
| 关车窗 | `0x07` | `Y`(0x59) | `0x0d` | 132 |

**2026-11-06 逐动作实车复证**（飞行模式、活动网络为 0、HCI `full`，每次只点一个官方 App 按钮并由用户车旁确认物理结果）：

| 操作 | 外层 `messageId` | `cmd` | `authData` 长度 | 服务端序号 | 物理结果 |
| --- | --- | --- | --- | --- | --- |
| 开后备箱 | 1 | `0x04` | 130 | 2 | 尾门打开 |
| 关后备箱 | 2 | `0x04` | 132 | 4 | 尾门关闭 |
| 闪灯 | 3 | `0x26` | 131 | 6 | 看到闪灯 |
| 开车窗 | 4 | `0x0c` | 130 | 8 | 车窗下降 |
| 关车窗 | 5 | `0x0d` | 131 | 10 | 车窗升起 |

五帧 CRC 均校验通过，`KI`/`ED`/`SN` TLV 均闭合；`KI` 五帧相同，`ED` 与 `SN` 每次不同，DER 签名长度 70/71/72 正好解释长度差。**开/关后备箱仍共用 `cmd = 0x04`，但差异不来自 `cmd`、也不来自 `auth[8:10]`：两帧的 `ED`/`SN` 逐字节不同，动作与方向绑定在服务端签发的一次性材料内部。只看 `cmd` 会把两条指令当成同一条。**

**调用方法**：离线状态下五个动作仍全部生效，且 `XpVehicle.db` 的 `xp_vehicle_xp_key_message` 缓存了云端预先签发、带签名的 `XPBKTH` 一次性材料；static/native 两侧已确认 `createCommandParameters` 把 Base64 payload 解码后在末尾追加 1 字节 `cmdCode`，经 `0xED` 通道写入 BLE。由此得到的调用链是「云端预签发并缓存 → App 取缓存材料 → 追加 `cmd` → BLE 写入」。逐次快照显示每次动作后该表恰好少 2 行（97 → 95 → 93 → 91 → 89），最小 id 每次 +2、最大 id 不变，窗口内无新增行；服务端序号每次 +2。两条被消耗的记录是否分别对应 16 B 控制帧与命令帧尚未证明；App 是否能脱离缓存本地合成材料未直接实测，现有证据只支持「本次走缓存」。具体哪几个字节绑定开/关与动作语义也未定位。原始证据在 `work/ble-capture/<run-id>/`（gitignore），`scripts/btsnoop_decode.py` 可按时间戳窗口过滤并输出结构摘要。

### 6.8 V3 的 TLV 编码规则（`encodeTlvMessage`）
规则由 `SDKBleKeyV3::encodeTlvMessage(uint16 tag, size_t len, const void* value)` 完全确定：**tag** 按需 1 或 2 字节、**大端**（`tag <= 0xFF` 时 1 字节，否则 2 字节，故 `0xa0` 1 字节、`0x7f50`/`0x7f51` 2 字节）；**len** 用 DER 式确定长度（`len < 0x80` 时 1 字节写值，`len >= 0x80` 时首字节 `0x80 | (后续字节数-1)`，后续字节大端）；**value** 原样追加。总长 = tagBytes + lenBytes + len，一次 `malloc` 后按「tag → len → value」回填。

已定位的 tag（调用点反查）：`0x0a`、`0xb0`（RKE 双层）、`0xa0`（Auth0 请求）、`0x7f50`/`0x7f52`/`0x7f53`（Auth0/Auth1/轮询配置容器）、`0xc0`（泊车心跳）、`0xc4`（自校准）、`0xc5`（轮询自定义）、`0xc6`（RSSI 采集）、`0xc7`（设备型号）、`0xc8`（泊车限距，V1/V2 两版）、`0xc9`（轮询开关，V1/V2 两版）。

**解析侧**：`handleXPBleKeyV3Content`（`0x8e634`）先看 `msgType`，等于 2 时把 `tag` 与 `0x7f51`/`0x7f6f` 比对（分别取 0x12 / 0x24 字节定长子结构）；否则按 `tag & 0xf0 == 0xd0` 分流到 `handleSpecialLargeContentData`（长内容、带 subType）与 `handleSingleTlvNormalData`。越界打印 `Malformed TLV data: value length exceeds available data`。

**响应侧子 tag 是另一套编号**（各 `handle*ResponseTlvData` 的 `cmp` 立即数）：

| 处理函数 | 地址 | 接受的子 tag | 落点 |
| --- | --- | --- | --- |
| `handleAuth0ResponseTlvData` | `0x8e4b0` | `0x01`、`0x02` | `0x01` → `[+0]`；`0x02` → `[+9]`，值按 `len` 拷入 |
| `handleRkeResponseTlvData` | `0x8e3d0` | `0x0a`、`0x10`、`0x11`、`0x12` | `0x0a` → `[+1]`（1B）；`0x10` → `[+9]`；`0x11` → `[+0x12]`；`0x12` → `[+0x1b]` 存长度 + `[+0x1c]` 存堆指针（`calloc`） |

`0x0a` 在请求侧是 RKE 外层 tag、在响应侧仍是子 tag 但落点不同；`0x01`/`0x02` 在 Auth0 请求里是信封首字节类型、在响应里是子 tag——**同一数字在不同层含义不同**。`handleAuth0ResponseTlvData` 末尾有 `little_endian_to_host` 转 8 字节（`mov w1,#8`），即 Auth0 响应含一个 **8 字节小端数值字段**（大概率是车端随机数）。

### 6.9 V3 信封与鉴权三帧
V3 车型的车控先拼 `BLEKeyV3Message` 信封再交给 `createSendData`。`createBleKeyV3RkeRequestWithInput(BleKeyV3RkeParams*, int, uint8_t* out, size_t* outLen)`（`0x8f610`）：

1. 取 `rkeType`（`[+0]` 半字）、`subType`（`[+2]`）、`keyId`（`[+3]` 起 8 字节）、`keyIdLen`（`[+0xb]`），调 `getRKEDataWithRkeType` 拼内层 RKE TLV：`inner = TLV(0x0a, [subType]) ‖ TLV(0xb0, data)`，`out = TLV(rkeType, inner)`。`rkeType` 是最外层 tag，`0x0a`/`0xb0` 是内层两个 tag（`0x0a` 包的是 `subType`，不是 `rkeType`）。
2. `authFlag` 非 0 时取 `sessionKey`（`[+0xc]`）、`sessionKeyLen`（`[+0x14]`）、`hmacKey`（`[+0x18]`）、`hmacKeyLen`（`[+0x20]`）：`getXorResult(uint32_t* outLen, uint8_t* a, size_t aLen, uint8_t* b, size_t bLen)` 把两段按较短者截齐逐字节 XOR，输出长度写回 `outLen`——用它从 `hmacKey` 与 `keyId` 派生 IV；再用 `hmac_sha256(hmacKey, hmacKeyLen, RKE 明文, 明文长度, &outLen)` 对 RKE 明文签名，得 32 字节 MAC。
3. 把 `RKE 明文 ‖ MAC` 拼进输出缓冲。`calc_crc16_ccitt(buf, len)` 算 CRC16-CCITT，`host_int16_to_little_endian` 后**小端**存进 `[+0xa]`。结构体 `{ [0]=0x03, [1]=len, [+2]=payload 指针, [+0xa]=crc16 }` 由 `copyBleV3MessageRawData`（`0x90c9c`）摊平；`sizeOfBLEKeyV3Message` = `4 + len`。

```
[0]        0x03                 // 固定类型
[1]        len                  // payload 长度，1 字节
[2..2+len) payload              // RKE 明文 ‖ HMAC-SHA256(32B)
[2+len]    crc16 low            // CRC16-CCITT，小端
[3+len]    crc16 high
```

错误码：参数空 → 7；`keyId` 或 `keyIdLen` 为 0 → 8；`sessionKey`/`hmacKey` 缺失 → 9/10。合法性由 `isEffectiveBLEKeyV3MessageData`（`0x90c60`）判定：首字节减 1 后 ≤ 4（**type 取值 1–5**）且 `[1] + 4 == 缓冲区总长`——抓包可用这两条快速判断帧是否完整。

**三层嵌套**：`TBox 外层 → 0x03 内层信封 → TLV 体`。D55 走 V1/V2，不用这层，内层是 `createCommandParameters` 的「payload + 指令码」。CRC 有两套：链路层 `xp_getCrc32`（CRC-32，大端）、V3 业务层 `calc_crc16_ccitt`（CRC-16-CCITT，小端），不要混用。

**鉴权三帧**：三个构造函数把同一结构体摊平，唯一区别是首字节类型值：

| 构造函数 | 地址 | 信封首字节 | 是否 AES |
| --- | --- | --- | --- |
| `createBleKeyV3Auth0RequestWithInput` | `0x8f284` | `0x01`（`mov w8,#1` @`0x8f43c`） | 是 |
| `createBleKeyV3Auth1RequestWithInput` | `0x8f4c4` | `0x02`（`mov w8,#2` @`0x8f580`） | 可见调用集里没有 |
| `createBleKeyV3RkeRequestWithInput` | `0x8f610` | `0x03`（`mov w8,#3` @`0x8f740`） | 是 |

与 `isEffectiveBLEKeyV3MessageData` 的「首字节 1–5」吻合：1=Auth0、2=Auth1、3=RKE 车控，4/5 未在本库内出现（可能是轮询与泊车）。**适用范围限 V3 协议**：实车抓包（§6.12）里该车握手帧首字节是 `0xd4`/`0x92`/`0xdb`，不是 1/2/3，走的是非 V3 协议。

**Auth0 用硬编码 IV**（`0x8f3a0–0x8f3e8`）：`.rodata:0x50020` 的 16 字节常量 `cc f3 e8 34 2b d6 07 1f de 72 70 df a0 87 6b b8`，固定不变。旁边 `0x50010` 是 `0123456789abcdeffedcba9876543210`（教科书 IV），别混。key 指针 `params+0x45`、长度 `params+0x4d`——**会话密钥由上层算好传入，native 只做 AES**；复算必须先拿到这一步的输入。

**Auth1 的可见调用集**（`0x8f4c4` 全部 `bl`）：`getAuth1FactorTlvData` → `getTlvTotalSize` → `getXorResult` → `calc_crc16_ccitt` → `copyBleV3MessageRawData` → `sizeOfBLEKeyV3Message`，**没有 `aes_256_cbc_encrypt`**。不能据此断言 Auth1 明文传输——`getXorResult` 可能就是混淆手段，或加密在别处。待验：需对真实 Auth1 帧做熵分析。

### 6.10 GATT 绑定与 UUID
实车服务发现结果（`READ_BY_GROUP_RSP` / `READ_BY_TYPE_RSP` 解出）：

| 角色 | 属性 | UUID | 声明 handle | 值 handle |
| --- | --- | --- | --- | --- |
| 主服务 | — | `0000ED28-ABAB-406D-832D-7AD799B479F7` | `0x000a` | — |
| App 写入 | `WRITE \| WRITE_NO_RSP` | `0000ED28-ABAB-9C8C-2801-B1A015E46D6C` | `0x000b` | `0x000c` |
| 车端推送 | `INDICATE` | `0000ED28-ABAB-9C8C-2802-D3DF573FF530` | `0x000e` | `0x000f` |

另有 `0x1800`（Generic Access）、`0x1808`（Glucose）、`0x180a`（Device Information）三个标准服务，与车控无关。CCCD 在 `0x0010`，App 连上后先写 `0x0010 = 0200` 才开始握手。`…6D6E` 在实车会话中未出现。`classes.dex` 里所有 `*-ABAB-*` 形态 UUID（10 个）：

| UUID | 分组 | 说明 |
| --- | --- | --- |
| `0000ED28-ABAB-9C8C-2801-B1A015E46D6C` | 2801 | 写特征（实车证实） |
| `0000ED28-ABAB-9C8C-2801-B1A015E46D6E` | 2801 | 未在实车出现 |
| `0000ED28-ABAB-9C8C-2802-D3DF573FF530` | 2802 | 推送侧，属性 `INDICATE`（实车证实） |
| `0000ED28-ABAB-9C8C-3205-B1A015E46D6C` | 3205 | 早期车型主服务（推论） |
| `0000ED28-ABAB-9C8C-3206-D3DF573FF530` | 3206 | 早期车型推送（推论） |
| `0000ED28-ABAB-406D-832D-7AD799B479F7` | 406D | 主服务（实车证实） |
| `0000ED28-ABAB-406D-832D-7AD799B00000` | 406D | 扫描掩码（尾部补 0，非真实 UUID） |
| `000FF001-ABAB-9C8C-2801-B1A015E46D6C` | FF001 | CarIoT 服务 |
| `000FF001-ABAB-9C8C-2801-B1A015E46D6F` | FF001 | CarIoT 特征 |
| `000FF001-ABAB-406D-832D-7AD799B479F7` | FF001/406D | CarIoT 406D 形态 |

`DEF_UUID_SERVICE`/`DEF_UUID_WRITE`/`DEF_UUID_RECEIVE` 三个**字段名**在 dex 字符串表确认存在（`full_strings.txt:44171–44173`），与 `DEF_MTU`、`DEF_AUTH_TIMEOUT` 同段；字段值在加密 dex 内。2801/3205/3206 组的角色分配属结构推断：`…6D6C` 与 `…6D6E` 只差最后一字节，`…2802-…573FF530` 与 `…2801-…E46D6C` 第 3、4 段不同——靠「成对」推角色会被这种相似性误导。`-9C8C-` 与 `-406D-` 的取舍（量产车 vs 工程/OTA）同为推论。native 内 `ED28`/`FF001`/`ABAB` 命中 0，UUID 不进 native。

### 6.11 入站帧与 msgId 分派
上行（车 → 手机）不走 TLV，走**定长 10 字节记录**。`DataParser::parse(buf, len)`（`0x97d60`）分两种情形：**`len == 4`** 时整段当一个短包，取 `*(uint32*)buf` 塞进 `Auth0ResponseMessage`，随后 `parserEnd()`（鉴权早期的极简回应）；**`len >= 10`** 时按 10 字节一条循环切分（`subdata(buf, off, 10)`），每条为 `[0..1] msgId`（2 字节大端，`rev` + `lsr #16`）+ `[2..9] payload`（8 字节大端，raw 与 byteswap 两份都存进对象 `+0x28`/`+0x30`）。每条处理完 `parseSingleMessage()` 再 `freeSubdata()`，一条 BLE 通知里可串多条记录。

`parseSingleMessage`（`0x97c3c`）按 `msgId` 分派，未命中走虚函数 `specificityMessage()`：`0x82` → `buildBleDoubleAuthMessage`（仅当 payload 低字节 == 2，再拆 bit8–11、bit12–15 与高 48 位）；`0x800` → `buildAuthResultMessage`（取 bit 0x3a，与 `0x0100_0000_0000_0000` 比较得出标志位）；`0x92` → `buildRkeControlMessage`（bit56 作首字节，bit24 起作后 4 字节）。

`D55DataParser::specificityMessage`（`0x96b70`）承接其余 msgId：

| msgId | 处理 |
| --- | --- |
| `0x55` | `buildBleRequestLoactionMessage`（`[+0x31] & 3`） |
| `0x5d` | `buildCdcuLoginMessage` |
| `0x70` | `parseControlResult()` → `buildRkeControlMessage`——**车控回执走这条**。旧抓包标注 `payload[0]`=cmdCode、`payload[4:6]` 小端 16 位=结果码 |
| `0x225` | `buildChargePortMessage`（bit0x23、bit0x2f） |
| `0x281` | `buildPollingMessage`（bit0x31） |
| `0x2d5` | `buildParkingEventMessage` + `buildParkingStateMessage` |
| `0x2fc` | `buildDriveMessage` + `buildPollingMessage` |
| `0x318` | `buildParkingEventMessage` + `buildParkingStateMessage` |

`msgId` 是 16 位，`0x225`/`0x281`/`0x2d5`/`0x2fc`/`0x318` 都是 16 位取值，不是两字节拼的。上表来自 D55 实现，其他车型的 `specificityMessage` 各自不同，msgId 表不通用。

**`0x70` 标注更正（P5 实车）**：`payload[0]=cmdCode` 只是早期抓包的经验标注，已被同一锁车动作的官方/自研回执取值不一致否定，不能作为命令回显判据；`payload[4:6]` 的 `200` 是已知成功码之一。锁车实车另观察到结果码 `163` 且车门确实锁上，但官方结果码表/资源串未定义 `163`，`parseControlResult`/`checkResult`/`successPrediction` 方法体不可读，因此 `163` 是成功、中间态还是失败**无法判定**；同帧 `payload` 中的 `0x2a` 语义也待取证。不得据此把 `163` 写成成功或失败码，也不改变代码已知的 `code===200` 成功判据（附录 §6.92）。

**解析器家族**（9 个类，继承关系由 `_ZTI*` 的 parent 指针逐条解析得出，不是按名字猜）：

```
BaseDataParser                    ← 根
├── DataParser
│   ├── D55DataParser
│   │   └── D22DataParser         ← D22 继承 D55，不是并列
│   ├── E28aDataParser
│   ├── E38DataParser
│   └── F30DataParser
├── BleKeyV3DataParser            ← V3 协议，走 TLV（§6.8）
└── E28DataParser                 ← 直挂根上，跳过 DataParser
```

- `BleKeyV3DataParser` 与 `DataParser` 是并列的两个分支，都直连 `BaseDataParser`，印证 V3 与 V1/V2 两套回执解析。`D22DataParser` 只重写 `parseIBCMFirst`（`0x9660c`）与 `parseAppMsgSecond`（`0x96578`），其余从 D55 继承。`E28DataParser` 直接继承 `BaseDataParser`，**不共用** 10 字节切分逻辑，自带 `parseStateaMessage`/`parseIbcm`/`parseIbcmSysSt3`。
- vtable 大小印证分层：`BaseDataParser`/`BleKeyV3DataParser` 32 字节，`DataParser`/`E28a`/`E38`/`E28`/`F30` 40 字节，`D55`/`D22` 56 字节。
- **接新车型的路径**：在 `DataParser` 下加子类实现 `specificityMessage()` 并补 msgId 表，即可复用 10 字节切分；车型差异大到连切分都不同（如 E28）才直挂 `BaseDataParser`。

D55 自己实现的解析方法（`.dynsym`）：`parseIBCMFirst`（`0x96740`）、`parseIBCMSecond`（`0x9682c`）、`parseIBCMPepsReq`（`0x96a3c`）、`parseAppMsg1`（`0x96af0`）、`parseAppMsgSecond`（`0x96890`）、`parseXpuBleRemotePk`（`0x96984`，184 字节）、`specificityMessage`（`0x96b70`）。`parseXpuBleRemotePk` 在 `E28aDataParser`/`E38DataParser`/`F30DataParser` 也各有实现（280/280/264 字节），D55 版更短，可能只解析部分字段。

### 6.12 握手流程与 msgId 序列
**每条车控命令前都严格走这五步，缺任一步车端回 `0800 06`**：

```
写 0x0010 = 0200            CCCD，开启 indicate
写 ef0104 <4B app_n>    ->  车回 4B car_n
写 ef0110 <16B>         ->  车回 0800 01 44463030482e32   (成功，版本 DF00H.2)
写 ed1118 <24B>         ->  车回 150B 能力表
   （车推 3 组状态 0281/0082/0231）
写 ed118b <命令帧>      ->  车回 0318 系列 + 0225 回执
```

**握手次数与命令次数一一对应**：App 每发一条车控命令都重新走完整握手，`ef0110` 每轮重算，不存在「握手一次复用整段会话」的捷径。

**车端挑战窗口约 2.0–2.5 秒**（收到 `car_n` 后延迟再发 `ef0110`）：延迟 0.2 / 1.0 / 2.0 s 均回 `08000e00000000000000`（result `0x0e`，认证失败，密钥/挑战不匹配）；2.5 s 与 3.0 s 回 `08000600000000000000`（result `0x06`，超时/拒绝）。**窗口边界在 2.0 s 与 2.5 s 之间。**

一轮握手的完整 msgId 序列（31 轮完全同构）：

```
App 写 0xEF 4B  ──┐
App 写 0xEF 16B ──┤ 上行三段
App 写 0xED 17B ──┘
                  ↓ 车端按固定顺序回 15 条 notify
0x0800  01 44 46 30 30 2e 32        → ASCII "DF00.2"（协议/固件版本）
0x0281  0000000000000000
0x02fc  9800000000000000
0x02fb  0000000000000000
0x02fa / 0x02f9 / 0x02f8 / 0x02f7 / 0x02f6   全零
0x0261 / 0x0262 / 0x0263                     全零
0x02d5  fffffff800000000
0x0231  0020008000000000
0x0318  0400004307400080
0x0225  1f02555500000100
0x0281  0010000000000000            ← 同 msgId 第二次，不同 payload
0x0082  ×3  见下
```

**计数验证**：`0x0261`/`0x0262`/`0x0263`/`0x02f6`–`0x02fc`/`0x0800` 在整份抓包里各出现恰好 31 次，与 31 轮握手一一对应。`0x0082` 共 93 条 = 31 × 3，每轮三条，payload 首字节固定是 `02 31`/`02 32`/`02 33`：

```
0231 a503cca8cf0e
0232 5251838b3e83
0233 422827d90000
```

`02 31`/`02 32`/`02 33` 像三个子字段编号，后 6 字节每轮全变；`0233` 末两字节恒为 `0000`。含义未定，不是递增计数器（无单调性）。**`0x0800` 的 `DF00.2` 是车端自报的协议/固件版本**，即 D55 协议族、版本 `DF00.2`。自研客户端可按这 15 条逐一校验：msgId 序列一致即握手成功，不一致即车端拒绝本次鉴权。

**可重复性**：一次 65 分钟抓包里 App 自动做了 31 轮相同起手的三段握手，间隔中位数约 127 秒（相邻 124–133 秒，一次 250 秒、末尾 72 秒与 180 秒为手动操作打断）。该握手是**保活/重鉴权**，2 分钟可作重鉴权周期参考。三段内容每轮全变，但 `KI` 在解锁与上锁之间不变（会话级而非每帧级）。抓包窗口越长噪声越多：65 分钟日志里只有 2 条车控帧。

**时序与延迟**：连接建立到第 1 帧写入约 1.2 s（含服务发现 0.5 s）；三次写 + 九次通知完成约 0.7 s；解锁写入到回执 **0.547 s**，上锁 **0.651 s**——这是 BLE 车控真实响应时间，`checkResult` 超时应显著大于此值。MTU 协商 517/247（`MTU_REQ=517`，`MTU_RSP=247`），单包最大 ATT PDU 153 字节，未触发分片。通知侧 16 条 `HANDLE_VALUE_NOTIFICATION`（`0x1e`）对应 16 条 `INDICATE`（`0x1d`）——车端用 indicate 而非 notify，App 必须逐条回确认，影响弱信号下吞吐。

**实测帧内容**（两轮，定长，仅内容变）：① `0xEF` 4B = `d4e5fee5` / `712c7939`；② `0xEF` 16B = `92b7148348c91f370a898d0ce5855afe` / `e9675575cb8e9bdafffb78a60548ad9a`；③ `0xED` 17B = `db61b5b113d0870e6482ace4772c27e2e0` / `79e7bc63907ddbaa4703eee75aff5654e0`。

第 3 帧的 TBox 外层切开：`00 11 | 8e4ec850 | 00 | db61b5b1…`（len=17 ✓，type=`0x00`，CRC 见 §6.15）。`0xEF` 两帧无 TBox 外层，`b1` 均为 `0x01`（单片）。上行 4 字节短包 `ffdba7e0`（轮 B `59bfc55f`）出现在握手开头，对应 §6.11 的 `len == 4` 分支。新增 msgId `0x02f6`–`0x02fb`（连续 6 个）、`0x0261`–`0x0263`（连续 3 个）、`0x0231` 不在 D55 分派表内，payload 全零，`0x02f6`–`0x02fb` 与 `0x02fc` 连号，像同族「能力/状态位图」逐条上报。`0x0800` 的 payload `0144463030482e32` 后 7 字节是 ASCII `DF00H.2`，首字节 `0x01` 正是 `buildAuthResultMessage` 取的那个标志位。`0x0318` 第一轮上报一次（`0400009307400080`），第二轮三次（`0400009307400080` → `0400000107400080` → `0400002307400080`），末字节 `0x93`/`0x01`/`0x23` 在变，对应某种状态位，与 §6.19 码表无直接关系。

### 6.13 `ef0110` 的 KDF
`ef0110` 的 16 字节 payload 由 native `createAuthKey`（`0x8c13c`）产出：

```
seed4  = hexStringToBytes( hexStringIncrement( stripColon(keyString)[-10:][:8] ) )
K1     = MD5(seed4)                       ← hmac_md5 的 key（16 字节）
msg    = app_n(4B) || car_n(4B)           ← hmac_md5 的 msg
ef0110 = HMAC-MD5(K1, msg)                → 16 字节
```

`hmac_md5`（`0x8385c`）的签名是 `hmac_md5(msg, msglen, key, keylen, out)`——**前两个参数是消息**，`x0`/`w1` 走 `MD5Update(msg)`，`x2`/`w3` 是 key。`keyString` 是**车端 BLE 模块的 MAC 地址**，不是 KI：直接传 32 字符的 KI 进 `createAuthKey` 会 `FORTIFY: strlen: detected read past end of buffer` 然后 abort。**两把 `keyString`，各 100% 命中**：

| 数据集 | 组数 | `keyString` | 命中 |
| --- | --- | --- | --- |
| 主账号 / 真车抓包 | 31 | `00:60:37:85:B9:D0` | **31/31** |
| 子账号 / 桥接日志 | 157 | `08:00:00:00:00:00` | **157/157** |

两个 MAC 都来自 `work/db/XpVehicle*.db` 的 `xp_vehicle_mac.macAddress`：`XpVehicle_after_login.db` 里是真车主模块 `00:60:37:85:b9:d0`，`XpVehicle.db` 里是 `08:00:00:00:00:00`——**子账号登录时服务端下发的占位 MAC**，不是笔误。子账号那 155 次 `0x0e` 与算法无关，也与「车端不认子账号钥匙」无关：占位 MAC 算出的 `ef0110` 数学上自洽（故能 157/157 复现），只是车端用真 MAC 派生，两边对不上。

**复现**：`python3 scripts/ble-kdf-verify.py` 输出 31/31 + 157/157 = 188/188；`node --experimental-strip-types scripts/verify-ble-kdf.mts` 同样 188/188。Python 与 TS 两份独立实现同时命中同一批真实抓包，说明式子不是拟合。只要这两行不是满分，实现就是错的。**自研端实现 `ef0110` 所需全部齐备**：`app_n`（自己生成）、`car_n`（`ef0104` 的回应）、`keyString`（见下条规则）；BLE 链路上已无未知算法。

**`keyString` 必须取当前 GATT 连接的对端 MAC，不能取 `xp_vehicle_mac.macAddress`。** 同一台从模块 `XPED-DC0D30B094C4`，只改 `--key`：

| `--key` | 车端对 `ef0110` 的回应 | 判定 |
| --- | --- | --- |
| `00:60:37:85:B9:D0`（数据库主模块 MAC） | `08000e00000000000000` | `0x0e` 失败 |
| `DC:0D:30:B0:94:C4`（当前连的从模块自己的 MAC） | `08000144463030482e33` | `0x01` 已认证 |

车端在哪个模块上校验，就用那个模块自己的 MAC。App 能用数据库里的值是因为它连的就是主模块；连从模块时应换成从模块的 MAC（未单独验证，与本结论一致）。

**native 直调方法**（后续排查未知量时照做）：`libbledata.so` 在裸 Android 进程里 `dlopen` 直接成功，不需要 JNIEnv stub。`createAuthKey`、`hexStringIncrement`、`hexStringToBytes`、`generateAuthKey`、`generateAuth1DataV3`、`generateSessionKey` 六个符号均可 dlsym 调通。要点：① NDK 交叉编译小二进制，`dlopen` + `dlsym` 直接调；② **先让真函数吐出中间值**（如 `hexStringIncrement` / `hexStringToBytes` 拿到 4 字节 seed），再用 Python 独立算一遍比对，两处一致才算模型正确；③ 反汇编只用来读参数顺序，不代替实跑。裸进程调崩只发生在需要 JNI 全局方法句柄的 `getSessionKey`（`JNI_OnLoad` 里 `GetMethodID` 取的 `hkdfSha256`）上，纯 C 函数不受影响。

### 6.14 `ed1118`：P5V2 verifyKey 与 V3 sessionKey

**P5V2 目标发送路径已确定**：`CarCtrlVerifyPackager` 从 `VerifyCodeUtil.getCode(vin, "1")` 读取 phone verifyKey；随机 int 经 `ByteUtil.int2byte` 后补零为 16 字节，以 AES-CBC、16 字节零 IV、NoPadding 加密。`VerifyCodeUtil` 优先读 `SecurityManager` 的 `VERIFY_CODE#<vin>#<type>`；为空才读普通缓存 `XP_VEHICLE_SDK_XP_AUTH_CODEVERIFY_CODE#<vin>#<type>`。主存储是 `files/mmkv/tee` 中的 XTee 信封，不应只在 `ble_cache_data` 搜索明文验证码。

**独立离线验收**：已有 `work/mmkv/tee` 与 `work/live/tee.bin` 经已有 `/tmp/ks.sqlite` RSA 解封指定 phone 记录，得到 16 字节 verifyKey；31 条互不相同的历史 `ed1118[10:26]` 经 AES-CBC/零 IV/NoPadding 解密后，31/31 的 `[4:16]` 为十二个零，watch key 为 0/31。两份备份不代表两把独立密钥。只解指定验证码记录，未访问账号 token、未联网手机、未输出秘密；脱敏结果见 `work/ble-runtime-20261104/v2-known-key-match.json`。这证明历史 phone key 与旧密文一致，**不证明新账号激活、新鲜物料获取或真实车辆接受**。

**接口静态契约**：`getXpKeyAuthData` 的 JSON Body 为 `vin`、`count:300`、`autoCreateKey:false`；`getBleInfo` 以 JSON Body `vin` 获取 `macAddress`。握手 `keyMac` 来自当前连接的 `peripheral.getAddress()`，不能把接口 `macAddress` 直接当作当前 GATT 对端地址。接口注解与发送路径证据来自本轮已提取文本，未据此执行新鲜账号网络测试。

**P5 实车链路层根因与结果**：官方 App 每轮连接先 `requestMtu(160)`，车端回 `247`，CCCD 写 `0x0200`（INDICATION）；车端 414 条全为 `0x1d` 指示、手机逐条 `0x1e` 确认，三条 `0x0082` 验车分片放在一个 30 字节指示里。自研原生桥若不请求 MTU、且 CCCD 优先 NOTIFY，默认 23 字节链路装不下 30/150 字节指示，只能收到 20 字节状态碎片，严格认证必然超时。这不是认证算法或钥匙错误。修正为服务发现后请求 MTU、在 `onMtuChanged` 成功后写 CCCD 且优先 INDICATION（附录 §6.92）。

修正后，隔离验收入口以 0.x 秒级完成 GATT 连接，三段握手后收到 150 字节状态表及 30 字节 `0x0082` 三分片，严格挑战校验通过；随后解锁、锁车各只写一次命令帧，用户现场确认车门确实解锁和锁上。因此「自研 App 经 BLE 控制本车解锁/锁车」已实车成立。该入口使用本地注入的一条一次性材料与本地校验码；新鲜账号物料的真实响应、无钥匙账号激活流程仍未完成（§9）。

后续生产包在已有登录态下补齐了「登录后自动准备物料 → Control 页按钮 → BLE-only 解锁/锁车」的真车验收：车旁无其他设备占用时，生产路由以 `autoConnect=true` 连接、`status=0`、服务发现与 MTU 160 完成，解锁与锁车各只点一次，用户现场确认两次物理动作生效；两份日志无 MQTT 车控发布。锁车连接成功发生在 12 秒抓窗外，由 logcat 环形缓冲补读确认；未观测到标准命令回执码，锁车后车况 UI 仍短暂显示解锁状态，属遥测刷新滞后而非物理结果反证（§6.93）。

自研 App 已把这 7 个有抓包实证的 P5 V2 命令码接入 DF 车型的按钮路由，并在 Control 页展示一次性操作的准备、连接、认证、下发与断开状态；这不是常驻数字钥匙连接。开/关后备箱共用 `0x04`，服务端一次性材料与具体动作、开关方向的绑定关系仍缺少完整证据，不能把新增 3 个按钮的代码接线等同于实车验收。两个后备箱按钮没有已实证的 MQTT 指令参数，因此只能在 DF 车型使用 BLE 路由；非 DF 车型不渲染、路由层也拒绝回退到 MQTT。锁车回执 `code=163` 在本轮实车上物理动作生效，但官方语义未取得；客户端对所有 `163` 回执以「已发送、结果未确认，请核对车况」第三态呈现，不判成功也不判失败，已知 `code=200` 成功判据不变。

**以下 native XOR/TLV 分析只适用于 V3**，不用于解释上述 P5V2 历史密文。

**帧格式完全确定**（用真实密文重建，与抓包逐字节一致）：

```
ed 11 18 | 00 11 | <crc32> | 00 | <16B 密文> | e0
```

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `[0]` | `0xed` | channel |
| `[1]` | `0x11` | flag |
| `[2]` | `0x18` | **= tboxlen + 7**（17+7=24） |
| `[3:5]` | `00 11` | tboxlen = 17（**不含**尾部 `e0`） |
| `[5:9]` | crc32 | 覆盖 `type + 密文 + tail`（**含** `e0`） |
| `[9]` | `0x00` | type |
| `[10:26]` | 16B | 密文 |
| `[26]` | `0xe0` | 固定尾字节 |

`tboxlen` 与 CRC **覆盖同一个 payload**（`[type]` 之后的全部 17 字节，即 16B 密文 + `e0`），
两者范围一致。早期版本记的「`tboxlen` 不含 `e0`、CRC 含」是表述错误——那句话把
「`e0` 不是独立字段」误写成了「`e0` 不计入长度」。实现见
`scripts/ble_frame.py:build_ed1118()`，用 31 条真帧逐字节验证 **31/31 还原**。

`chunkbyte = tboxlen + 7` 在 `ed118b` 上同样成立（132+7=139=0x8b）。

**调用图**：`generateAuth1DataV3`（`0xa1ac8`，JNI 入口，真正的 `ed1118` 构造）→ `createBleKeyV3Auth1RequestWithInput`（`0x8f4c4`，**主路径**）→ `getAuth1FactorTlvData`（`0x8ed74`，TLV 组装）+ `xorData`（循环 XOR）。`generateEmergencyAuth1Data`（`0xa1e3c`）→ `generateAuth1Packet`（`0x8948c`）是应急分支；`generateAuth1Packet` 在整个 so 里只有一个调用者，`generateAuth1DataV3` 不调它。两条路径最终落到同样的 TLV 组装，但「key 从哪来」的答案在主路径上。

**key 由 Java 传入，native 不派生**。`createBleKeyV3Auth1RequestWithInput` 开头即校验：`8f4f0: ldur x8, [x0, #0xd]`（`params->key` 指针，空则直接返回）、`8f4fc: ldur w8, [x21, #0x15]`（`params->keyLen`，0 则直接返回）。`generateAuth1DataV3` 在 `0xa1b78` 用 `stur x23, [sp, #0x19]` 填这个字段，`x23` 来自 `JNIEnv->GetByteArrayElements`（`0xa1b44`）。

**明文真实结构**（把 key 全置零，`createBleKeyV3Auth1RequestWithInput` 的输出即明文）：

```
val=0x00000000, data=00000 → 7f520d 0104 00000000 0205 0000000000
val=0x00000001, data=00000 → 7f520d 0104 01000000 0205 0000000000
val=0xffffffff, data=00000 → 7f520d 0104 ffffffff 0205 0000000000
val=0, data=0102030405    → 7f520d 0104 00000000 0205 0102030405
```

布局：`0–2` = `7f 52 0d`；`3` = `01`（TLV tag 1）；`4` = `04`（长度 4）；`5–8` = `val`（u32 LE）；`9` = `02`（TLV tag 2）；`10` = `05`（长度 5）；`11–15` = `data`（5 字节）。

XOR 循环模型与 TLV 结构已由 native 实测确认；输出总长 20 = 2 + 16 + 2(crc)，故 key 长 16。**但反推出的 16 字节 key 里只有 7 字节可信**：

| 偏移 | 值（样本 0） | 为什么确定 |
| --- | --- | --- |
| 0–4 | `a4 33 b8 b0 17` | 对应 `7f520d0104` 固定 |
| 9 | `80` | 对应 tag `02` |
| 10 | `a9` | 对应长度 `05` |

其余 9 字节（5–8、11–15）取决于未知的 `val`/`data`：`真实 key[5..8] = ct[5..8] ^ 真实 val`，`真实 key[11..15] = ct[11..15] ^ 真实 data`。

**V3 待验**：真实调用方的 `val`/`data` 与 `sessionKey` 来源仍待确认。把 P5V2 历史密文套进 V3 XOR/TLV 再反推 key 不能证明两者同源；由此得到的 key 字节、候选派生排除结果均不能充当 P5V2 密钥证据。历史模板与自拼帧零响应也不能代替正确 P5V2 AES 路径的实车验收。

**派生函数的 JNI 契约与数据传递已核验**（附录 §6.42d；离线复核命令
`pixi run -e rev python scripts/verify-ble-jni-contract.py`）：

```
native_generateSessionKey(byte[] p1, byte[] p2, int p3, int p4)
Java回调: hkdfSha256(p3_le‖p4_le, p1, p2, 16)
```

两个输入是字节数组：JNI 槽 `0x5c0`/`0x558` 分别是 `GetByteArrayElements`/
`GetArrayLength`，不能解释为字符串或假定 UTF-8 编码。上式仅表示已核实的 Java
回调数组顺序；`AlgorithmUtils.hkdfSha256` 的参数语义、真实数组来源仍待直接调用者证据，
不能仅凭 native 变量名确定哪个数组充当 IKM、salt 或 info。HKDF 在 Java 静态方法里，
native 做 JNI 桥接；裸进程缺少 Java 回调时的零结果不能当作有效派生结果。

**历史候选排除的适用边界**（附录 §6.42c）：24 组密文在假定 V3 XOR/TLV 明文后，对 `ikm`/`salt` 的 9×9 组合、5 种 `info` 排列、MD5 字节序及固定 XOR 关系均未全中。P5V2 样本已由独立 verifyKey 的 AES 解密解释，这些排除不能反证 V3 明文假设成立，也不能证明真实 V3 `ikm`/`salt` 必含非会话量。

**紧急通道是另一套算法**：`MD5(p3_le ‖ p4_le)`，16 字节，JNI 入参只有两个 int，
Java 侧参数名就叫 `rand0`（附录 §6.42e）。用 MD5 公式试普通 `ed1118`，4 组全不匹配。

**车端正常响应是必回的**：抓包里 App 发 `ed1118` 后 31 ms 就收到 150 字节 `0281000000000000000102fc9800…02551f02555500000000`（第二组连接 39 ms，节奏一致）。故零响应意味着**车端校验后直接丢弃**，不是「车端不校验」。150 字节内容为 `02 81 …` 状态快照，含 `02fc98`/`02fb`/`02fa` 一串 `02XX` 键值，末段 `02551f`、`025555`。

### 6.15 命令帧与 CRC 覆盖范围
**`crc32` 只覆盖 `payload`（type 之后的部分），不含 type 字节**：

```
id=2  type=02
  crc(type + payload) = 694554cc
  crc(payload)        = 938fa0ec   ← 帧里就是这个
  frame               = 938fa0ec   ✅
```

99 条命令帧验证：`CRC(f[10:])` 正确 99 / 错误 0。`ed1118` 的 type 恰好是 `0x00`，`crc(f[9:])` 与 `crc(f[10:])` 碰巧都是 `8e4ec850`，所以握手帧怎么算都对；一旦换成 `type=0x02/0x03` 的命令帧就全错，车端直接丢弃。**两条 CRC 已验的真帧**（服务端签发、ECDSA 签名完整）：

```
cmd=2 (上锁) len=141
ed118a0083938fa0ec025850424b5448010000826ae9f3d100544b49001012a774ba5b82bddb8bae973e35bed8e845440010fa505edb64d340d979be62b26cdbd5d9534e004630440220374e1b84242466e6f48bc2c283ee3ffd1cb79388362dbf2f8c2f74e8f12f04b30220505c22fc883f6368c59c802353b23762f515c1492dd0701ffbfd77797fdc22e302

cmd=3 len=141
ed118a00834faab57d035850424b5448010000826ae9f3d100554b49001012a774ba5b82bddb8bae973e35bed8e8454400104fad163352224877e37d1df9a6a2e6a0534e004630440220196dd0047f013d2dbb0f96829a24827375bfe7c76087a03b4b227baede08320e02207ee33f96d2961c86a591c4d4ca23e540d9aa4609552384d5edc42be7c45d001103
```

内层结构：

```
ed118a 0083 <crc32> 02 | 5850424b5448 01 0000 82 6ae9f3d1 00 | 84 | KI ED SN | 02
                        "XPBKTH"    header(9B)          flag  TLV*   cmd
```

| tag | 值（cmd=2 帧） |
| --- | --- |
| `KI` | `12a774ba5b82bddb8bae973e35bed8e8` |
| `ED` | `fa505edb64d340d979be62b26cdbd5d9` |
| `SN` | `30440220374e...22e302`（DER ECDSA，71 字节） |

### 6.16 签名链路：ECDSA P-256 + SHA-256，签的就是 `ED`
**公钥可从两帧签名反推**（ECDSA 的 `(r,s)` 加消息摘要可还原候选公钥，至多 4 个）。以「`ED` 原文作消息、SHA-256」分别还原解锁帧与上锁帧，两帧落到同一个公钥：

```
压缩公钥   02 143bdc4ed3a761c41e0a8b32038ed28afeff7cde04e55f672d423d0fa207caec
非压缩     04 143bdc4e…0fa207caec  38ea7275…88a9f3f3c4
曲线       secp256r1 / P-256（在曲线方程上验证通过；secp256k1 上不成立）
```

验证结果：解锁帧签名对 `ED_un`+SHA-256、上锁帧签名对 `ED_lk`+SHA-256 均**通过**；解锁帧对 `ED_lk`、上锁帧对 `ED_un`、解锁帧对 `0x01‖ED_un` 均**失败**。`ED`+头部、`ED`+`KI`、`XPBKTH`+头部+`KI`+`ED`+指令码、`ED`+指令码等 11 种组合均不成立，只有「`ED` 裸 16 字节 + SHA-256」能在两帧上同时还原同一公钥。**签名覆盖范围 = `ED` 的 16 字节原文**，不含指令码、不含头部、不含魔数。**跨会话稳定**：用该公钥验另一次抓包的 5 条新帧，5/5 通过——历史抓包标签为 `open trunk cmd=0x04 flag=U`、`close trunk cmd=0x04 flag=V`、`flash lights cmd=0x26 flag=W`、`open window cmd=0x0c flag=X`、`close window cmd=0x0d flag=Y`（`flag` 只作该次抓包标签，不是稳定字段，见 §6.7）。签名私钥跨会话不变；签名**不保护** `cmd`/`type`/`flag`/`header`，改这些字段签名依然成立，车端不会通过签名发现指令被篡改，完整性只能靠 `KI` 加密或会话状态（未验证）。

**私钥不在 APK 里**：公钥按非压缩 DER、压缩 DER（`02`/`03` 前缀）、base64、无 padding base64 四种编码在整个 `work/apk/` 下二进制搜索，零命中。结合「同一会话内 `KI` 不变而签名每次不同」，最可能的模型是密钥对在蓝牙钥匙激活时于设备侧生成、私钥存 Keystore、公钥注册到车端/云端。这与 §6.17 的 HKDF 协商是两条独立链路。私钥不可从现有帧推出：两次签名的 `r` 不同（`f78a764c…` vs `85fb448e…`），无 nonce 复用。

**`KI` 是 AES-128 密钥**：两轮握手的 `0xED` 帧 payload 前 16 字节用 `KI` 作 AES-128-ECB 解密，得到 `轮 A: f4eee6ef 000000000000000000000000`、`轮 B: 42b10da7 000000000000000000000000`，即 **4 字节有效数据 + 12 字节零填充**，加解密往返一致。随机密钥产生这种结构的概率约 2⁻⁹⁶，故 `KI` 确实是这一层的 AES 密钥，该层零填充到 16 字节。`0xEF` 那两帧的 16 字节用 `KI` 解不出这种结构，握手三段用了不同密钥或不同层。

**`ED` 不是用 `KI` 加密的**：`KI` 作密钥的 ECB / CBC(IV=0) / CBC(IV=上轮明文)、由握手材料派生的密钥（HKDF-SHA256 六种 info、SHA-256 前/后 16 字节、MD5、`KI⊕nonce`，共 40 余个候选）、以及连接里出现过的每个 16 字节值（两轮握手 5 个块）都无结构。`ED` 自身 16 字节全不同、零字节 0 个、首字节 `0xfd`/`0x8f`，是随机数形态。**结论：`ED` 是 16 字节随机 nonce（或随机密文），用现有材料无法判定内部结构。**

### 6.17 会话密钥派生与密码学原语
`SDKBleKeyV3::getSessionKey`（`0xa0344`）把两个 int 按小端写进 8 字节缓冲（`stp w24, w23`），将两个输入数组和该缓冲传给 `hkdf_sha256_jni`，输出长度 16。Java 回调的已证顺序为 `hkdfSha256(LE32(a)‖LE32(b), p1, p2, 16)`；数组语义与真实来源见 §6.14 的待解边界，不能把本地变量名称当成 IKM/salt/info 的证明。

`hkdf_sha256_jni`（`0xa3528`）不实现 HKDF，使用 JavaVM 获取 JNIEnv 后调用 `AlgorithmUtils`。其中 `0x10006` 是 JNI 版本值，不能解读为 Mac 初始化参数；真实 HKDF 实现在 Java 方法中，尚未取得其方法体。

**密码学原语一览**（`SDKBleKeyV3::` 下的符号全是 4 字节 `b` 跳板，实体是 `*_jni` 函数，即全部转 Java）：

| 符号 | 实体 | 用途 |
| --- | --- | --- |
| `SDKBleKeyV3::aes_128_cbc_encrypt` / `_decrypt` | `aes_128_cbc_{en,de}crypt_jni`（`0xa40c0` / `0xa43fc`） | V1/V2 载荷加解密（IV 与 key 都校验 16 字节） |
| `SDKBleKeyV3::aes_256_cbc_encrypt` / `_decrypt` | `aes_256_cbc_{en,de}crypt_jni`（`0xa3b2c` / `0xa3e00`） | V3 载荷加解密 |
| `SDKBleKeyV3::hmac_sha256` | `hmac_sha256_jni`（`0xa38a8`） | 鉴权因子签名 |
| `SDKBleKeyV3::hkdf_sha256` | `hkdf_sha256_jni`（`0xa3528`） | 会话密钥派生 |
| `SDKBleKeyV3::calculateAuth1SessionKey` | `resc_calculateAuth1SessionKey`（`0x891e4`） | Auth1 阶段的救援/备用派生路径 |

纯 native 实现：`MD5Init/Update/Final`（`0x839f4`/`0x83a08`/`0x8457c`）、`hmac_md5`（`0x8385c`）、`getXorResult`（`0xa00d4`）、`xorData`（`0x88f08`）。MD5 与 HMAC-MD5 属 V1 遗留的历史兼容路径，V3 不走。

**实现 `AlgorithmUtils` 时**：`aes_128/256_cbc_*_jni` 实参是 `(vector<uint8>, vector<uint8>, const uint8_t* key)`，解密侧带长度校验（`cmp x9, #0x10` 等），**key 长度、IV 长度在 native 侧强校验**，不能省。AES 的 IV/padding 语义必须与 `Cipher.getInstance("AES/CBC/PKCS5Padding")` 完全对齐，否则密文对不上。

### 6.18 指令面：可用的车控动作
`BLE_CAR_*` 常量共 82 个（`work/ble_analysis/const_cmd_ble_car.txt`）：

| 类别 | 常量 |
| --- | --- |
| 门锁 | `BLE_CAR_LOCK`、`BLE_CAR_UNLOCK`、`BLE_CAR_TRUNK_LOCK`/`UNLOCK` |
| 后备箱 | `BLE_CAR_OPEN_TRUNK`、`BLE_CAR_CLOSE_TRUNK` |
| 启动 | `BLE_CAR_START`（对应 DiDi 侧 `CarService.startCar` 与 `MonaCarCtrlService$unLockAndStartCarByBle`） |
| 四门车窗 | 每门 `10/20/…/90` 十档 + `AUTO_UP`/`AUTO_DOWN`/`MANUAL_UP`/`MANUAL_DOWN`/`STOP`，前缀 `BLE_CAR_DRV_`/`PASS_`/`LEFT_`/`RIGHT_`；另有 `BLE_CAR_WIN_VT_OPEN`/`CLOSE`（通风开合） |
| 寻车 | `BLE_CAR_FIND`、`BLE_CAR_FIND_DIRECTION_LAMP`、`BLE_CAR_FIND_HORN` |
| RPA | `BLE_CAR_ACTIVE_RPA`、`BLE_CAR_RPA_IN`/`OUT`/`STOP`、`BLE_CAR_CALL`、`BLE_CAR_EXIT_RPA`、`BLE_CAR_ACTIVE_RPA_IN_HEART` |
| 查询/上报 | `BLE_CAR_STATUS_BATTERY_SOC`、`BLE_CAR_STATUS_ODOMETER_INFO`、`BLE_CAR_STATUS_PARK_STATUS`、`BLE_CAR_KEY_EVENT_NOTIFY`、`BLE_CAR_CONTROL_REQ`/`RESP` |

**第二套 `CAR_CTRL_*`**（`full_strings.txt:36100–36200` 连续段）：`CAR_CTRL_LOCK`/`UNLOCK`、`CLOSE_TRUNK`/`UNLOCK_TRUNK`、`OPEN_WINDOW`/`CLOSE_WINDOW`、`OPEN_LEFT_SLID_DOOR`/`CLOSE_LEFT_SLID_DOOR`（右侧同）、`FLASH_LIGHT`、`WHISTLE`、`ENTER_BLE_PARK`、`REQ_AUTO_PARK`、`REQ_SUPER_LOCK_LOCK`/`UNLOCK`、`LOCK_QUICK_CHARGING`/`SLOW_CHARGING`、`UNLOCK_QUICK_CHARGING`/`SLOW_CHARGING`。这些是**字符串键**（日志/埋点/路由名），不是指令字节。

**第三套 `REQ_*`**（`full_strings.txt:98490–98570` 连续块，81 个）——动作覆盖面最全，比 `BLE_CAR_*` 多出滑门、剪刀门、超级锁、拖车钩、充电口锁、泊车：

```
REQ_LOCK / REQ_UNLOCK / REQ_LOCK_TRUNK / REQ_UNLOCK_TRUNK / REQ_TEMPORARY_LOCK / REQ_OPEN_BONNET
REQ_OPEN_WINDOW / REQ_CLOSE_WINDOW / REQ_OPEN_SUNROOF / REQ_CLOSE_SUNROOF
REQ_{LEFT,RIGHT}_{FRONT,REAR}_DOOR_{OPEN,CLOSE}
REQ_SLIDE_DOOR_{LEFT,RIGHT}_{OPEN,CLOSE} / REQ_SCISSORS_DOOR_{DRIVER,PASSENGER}_{OPEN,CLOSE}
REQ_SUPER_LOCK / REQ_SUPER_UNLOCK
REQ_OPEN_{FAST,SLOW}_CHARGE_PORT / REQ_CLOSE_{FAST,SLOW}_CHARGE_PORT
REQ_{LOCK,UNLOCK}_{QUICK,SLOW}_CHARGING
REQ_CHARGE_PORT_{ALLOWED,FORBIDDEN} / REQ_TRUNK_UNLOCK_{ALLOWED,FORBIDDEN}
REQ_TRAILER_HOOK_{OPEN,CLOSE,STOP,RESET}
REQ_FLASH_LIGHT / REQ_HONK / REQ_FLASH_LIGHT_AND_HONK / REQ_SEARCH
REQ_ENTER_BLE_PARK / REQ_AUTO_PARK / REQ_REMOTE_LIVE
REQ_POLLING_{ENABLE,DISABLE,LOCK,UNLOCK,WELCOME} / REQ_WELCOME_MODE
REQ_E28_{MAIN,VICE}_{OPEN,CLOSE} / REQ_H93_{LEFT,RIGHT}_{OPEN,CLOSE}
REQ_EMERGENCY_KEY_{LOCK,UNLOCK}
REQ_PAIR / REQ_AUTH / REQ_VERIFY_CAR / REQ_INIT
REQ_CAR_STATE / REQ_CAR_STATUS_SERVICE / REQ_NOTIFY_IN_CAR / REQ_NOTIFY_OUT_CAR
REQ_UPDATE / REQ_DELETE / REQ_DELETE_TEST_KEY / REQ_TIMEOUT / REQ_TIME_OUT
REQ_REJECTED / REQ_CODE_TEAM_NAME / REQ_OVERLAY_PERMISSION_CODE
```

全 dex 正则匹配 `REQ_[A-Z0-9_]+` 得 **127 个**，多出的 46 个散落在别处，含协议结构名（`REQ_HEADER`/`REQ_BODY`/`REQ_INNER`/`REQ_BIT1`/`REQ_BIT2`/`REQ_CMD`）、状态名（`REQ_ERROR`/`REQ_NONE`/`REQ_NETWORK`/`REQ_LOCATE`/`REQ_DISCONNECT`/`REQ_FASTEN`）与一批电动门（`REQ_*_ELECTRIC_DOOR_*`）。**只有连续块内的 81 个同块同源、最可能属同一枚举**，散落的 46 个来源不明。

**三套词表的关系**（推论，依据是覆盖面与命名粒度）：`REQ_*` 是业务动作全集（含车型专属 `E28_*`/`H93_*` 与协议控制项）；`BLE_CAR_*` 是已下移到 BLE 通道的子集，粒度更细（车窗十档）但缺滑门/剪刀门/超级锁/拖车钩；`CAR_CTRL_*` 是界面/埋点层动作名，粒度最粗。**三套词表都没有数值**——取值在加密 dex 的常量类静态初始化里（`BleCmdDefine`），native 侧也没有这些名字。这一层必须靠 HCI 抓包补（§9）。抓包时按 `REQ_*` 的名字对照 `type` 字节，命中率高于对着 `BLE_CAR_*`。

### 6.19 错误码
**上行响应的业务类型全集**（`classes.dex` 全量正则，各 12 与 11 个）：`BLE_RESP_*` = `AUTH_OK`、`AUTH_FAIL`、`CAR_STATUS`、`CAR_SYSTEM_REQ_RESEND_CMD`、`CAR_SYSTEM_WAKE_UP_FAIL`、`CHARGING_STATUS`、`CONTROL_FAIL`、`LOGIN_VEHICLE_EVENT`、`MAIN_DRIVING_STATUS`、`PARK_ERROR`、`PARK_STATUS`、`PASSENGER_SIDE_STATUS`；`BLE_DATA_*` = `CHARGE_UNLOCK`、`COLLECT`、`DISABLE_SDK`、`ENABLE_SDK`、`LOGIN_VEHICLE_RESULT`、`PARK_APA_ACCOUNT`、`PARK_APA_SWITCH`、`PROCESS`、`REQ_DISCONNECT_BLE`、`REQ_LOCATE`、`TBOX_4G_READY`。

这 23 个是**回执语义的分类维度**，与 §6.11 的 `msgId`（16 位）是两层：`msgId` 决定走哪个 `build*Message`，`BLE_RESP_*` 是构建完成后打给业务层的类型标签，取值在加密 dex 内。其中 `BLE_RESP_CAR_SYSTEM_REQ_RESEND_CMD` 与 `BLE_RESP_CAR_SYSTEM_WAKE_UP_FAIL` 说明**车端可主动要求重发或报告唤醒失败**——链路层有车端发起的重传协商，不是纯 App 主导。忽略这两条，弱信号下表现为「指令无响应」。

**车端码表**：`res/values-zh-rCN/strings.xml` 里 `vsdk_ble_msg_*` 共 92 条，编号分布 `0, 200, 300, 400, 500`；`10404–10422`；`10901–10913, 10915–10923, 10927–10956, 10958–10965`；`11009, 11010`；`14901–14906`。另有 `vsdk_e28_ble_msg_01`–`08`（E28 专属）。完整码表可直接照抄：

```
0     操作失败，请重试            200   成功
300   操作失败，请重试            400   请重试操作，若未成功请联系400客服
500   操作失败,请重试
10404 打开充电口失败              10405 关闭充电口失败
10406 请置于P档再重试             10407 请置于P档再重试
10408 请置于P档再重试             10409 请先关闭车门
10410 请先关闭前舱盖              10411 请先关闭后备箱
10412 请稍后重试                  10413 请先关闭车门
10414 请先关闭前舱盖              10415 请先关闭后备箱
10416 车辆已启动，解锁暂不可用    10417 主驾有人，解锁暂不可用
10418 开启超时,请重试             10419 请置于P档再重试
10420 请先解锁车门                10421 关闭超时,请重试
10422 请注意观察周围环境
10901 解锁失败                    10902 上锁失败
10903 后备箱开启失败，请重试      10904 后备箱关闭失败，请重试
10905 车辆已下电，临停不可用      10906 主驾有人,锁车不可用
10907 请关闭车门与前后盖再重试    10908 当前锁车不可用
10909 主驾有人,临停不可用         10910 请驻车后重试
10911 续航低,临停不可用           10912 请关闭车门与前后盖再重试
10913 当前临停不可用              10915 操作失败,请重试
10916 请关闭尾箱再重试            10917 请置于P档再重试
10918 请关闭前盖再重试            10919 请关闭车门再重试
10920 请关闭前盖再重试            10921 请关闭车门再重试
10922 请关闭尾箱再重试            10923 请置于P档再重试
10927–10933 左侧滑门开启失败，请重试（10929 例外：请置于P挡后重试）
10934 侧滑门处有异物，请手动开启侧滑门
10935–10939 左侧滑门关闭失败，请重试
10940 侧滑门处有异物，请手动关闭侧滑门
10941–10947 右侧滑门开启失败，请重试（10943 例外：请置于P挡后重试；10945 例外：请先解锁车辆）
10948 侧滑门处有异物，请手动开启侧滑门
10949 侧滑门无法完全打开,请关闭充电口盖后重试
10950–10954 右侧滑门关闭失败，请重试
10955 侧滑门处有异物，请手动关闭侧滑门
10956 智慧场景运行中，禁用离开自动闭锁
10958 拖车钩开启失败，请重试      10959 拖车钩关闭失败，请重试
10960 请先锁车后重试              10961 超级锁启动中，开启超级锁失败
10962 超级锁上锁失败，请重试      10963 左滑门无法打开，请关闭口盖后重试
10964 请先锁车后重试              10965 超级锁退出失败，请重试
11009 请在车辆上电时使用          11010 请置于P档再重试
14901/14903/14905 请在车辆上电时使用
14902/14904/14906 请置于P挡后重试
```

**码表反推的产品面事实**（推论，有文本支撑）：① **滑门（MPV）与超级锁是车控能力**，与 `CAR_CTRL_OPEN_LEFT_SLID_DOOR` / `CAR_CTRL_REQ_SUPER_LOCK_LOCK` 对应，各有 7–8 个失败分支（含异物、口盖未关）；`BLE_CAR_*` 里没有它们，说明滑门/超级锁走另一组指令码，不在那 82 个常量内。② `10416`/`10417` 区分「车辆已启动」与「主驾有人」两种拒绝解锁原因，`10906`/`10909` 同理区分锁车与临停——车端会做**座舱占用检测**并在回执里返回不同码。③ `10905` 与 `14901` 都是「车辆已下电」语义，但分属 109xx 与 149xx，暗示两段对应不同指令族（149xx 可能属泊车/RPA）。

码表本身完整可抄（只是资源文件，不在加密 dex 内）；取不到的是「哪个码由哪个分支产生」，逻辑在 `XpErrorCodeHandler` 方法体内。`XpErrorCodeHandler` 在 dex 里有 7 处引用，方法体不可读，故「用 `getIdentifier("vsdk_ble_msg_" + code)` 动态拼名字」属推论。

**客户端侧预检错误族**（`work/ble_analysis/const_error_ble.txt`，96 个，与车端 `vsdk_ble_msg_*` 是两套完全不同的东西）。这些是 App 在**发出任何一帧之前**自己判定的失败，自研客户端要复刻，否则用户看到的是「无响应」而不是「蓝牙未开」：

```
连接层：BLE_CONNECTION_FAILED / BLE_CONNECTION_AUTH_FAILED / BLE_AUTH_FAILED
        BLE_ERROR_NO_CONNECTED / BLE_TBOX_STATE_ERROR / MSG_BLE_CONN_FAIL / SCAN_BLE_FAIL
预检层：CHECK_FAIL_BLE_UNABLE / CHECK_FAIL_BLE_AUTH_FAIL / CHECK_FAIL_NO_BLE_PERMISSION
        CHECK_FINAL_FAIL_BLE / CODE_ERROR_BLE_CONNECT_FAIL / CODE_ERROR_NOT_SUPPORT_BLE_KEY
        RESULT_BLE_NOT_AUTHENTICATION / RESULT_BLE_SWITCH_IS_OFF
        RESULT_BLE_WALLET_SERVICE_ERROR / ERROR_CODE_BLE_OFF
激活层：ERROR_BLE_ACTIVE / ERROR_BLE_ACTIVE_F2 … _F6 / ERROR_BLE_ACTIVE_TIMEOUT
        ERROR_BLE_TIMEOUT / ERROR_SENCE_BLE / ERROR_SENCE_BLE_AUTH
```

`ERROR_BLE_ACTIVE_F2`–`F6` 五个并列码说明激活流程（首次配对/钱包激活）有 6 条不同失败路径，只报一个「激活失败」会丢排障信息。`ERROR_SENCE_BLE` 里的 `SENCE` 是 `SCENE` 的拼写错误，代码里就这么写——与 §6.4 的 `AUTHO` 一样，搜索时要按错拼找。

**触发链路的类名核实**（`classes.dex` 计数）：`CmdExecutor$cmdQueue`、`CmdExecutor$runningCmd` 各 1 处，`CmdCallbackProxy` 24 处，`BaseWidgetCmd$retry` 2 处，`VehicleCmd$checkResult` 6 处，`XpErrorCodeHandler` 7 处。这些名字确认存在但方法体全部不可读——§6.5 里的排队、串行化、`successPrediction` 重试都是从类名与字段名反推的行为描述。

### 6.20 实现约束（会踩的坑）
**假车侧：recv 特征必须带 NOTIFY 位。** 假车 properties 只声明 `0x20`（INDICATE）时，App 订阅后只干等 5 秒超时断开，从不发 `ef0110`，只发 `ef0104`；改成 `0x30`（NOTIFY|INDICATE）后**立刻走完 ef0104 → ef0110 → ed1118**。`GattCharacteristic` 只有 `uuid`/`properties`/`permissions`/`callback_id` 四个字段，CCCD 由 netsim 自动生成（`desc 00002902-0000-1000-8000-00805f9b34fb`，`descs=1`），属性位是唯一可调的开关。特征属性、而不是 `KI`，才是假车打通的拦路石。

**Android GATT 四坑**（不是协议问题，自研端照抄即可）：① **`setCharacteristicNotification` 不够，必须显式写 CCCD 描述符**（`00002902-…`）——只调前者时蓝牙栈只在本地注册路由，服务端 `OnCharacteristicObserveRequest` 不触发，日志表现为「车端回了但 App 收不到」。② **CCCD 取值须按实测链路选择**：模拟器/netsim 早期实验写 `ENABLE_NOTIFICATION_VALUE` 才能订阅；P5 本轮实车 HCI 抓包为 `0x0200`（INDICATION），车端用 `0x1d` 指示、手机用 `0x1e` 确认，且验车分片位于 30 字节指示内，详见 §6.14、附录 §6.92。③ **GATT 客户端是单槽写队列**——回调里连续 `writeCharacteristic` 时第二次直接返回 `false` 且不报错，必须自维护队列，在 `onCharacteristicWrite` 里出队下一帧。④ **`ef0104` 不能在 `onServicesDiscovered` 里发**，那时 CCCD 写还在队列里会被单槽规则吃掉，应在订阅完成回调里发第一帧。

**帧编码约束**（每条错了帧就不合法）：

| 约束 | 说明 |
| --- | --- |
| CRC 只覆盖 payload | 不含 `type` 字节；`crc(type‖payload)` 在 `type=0` 时碰巧相同，换命令帧就全错（§6.15） |
| CRC 初值 0 | 非 `0xFFFFFFFF`，无最终异或，多项式 `0xEDB88320`（§6.6） |
| `ed1118` 长度与 CRC 覆盖不对称 | `tboxlen` 不含尾部 `e0`，CRC 含（§6.14） |
| `chunkbyte = tboxlen + 7` | `ed1118`（17+7=24）与 `ed118b`（132+7=139=0x8b）都成立 |
| `keyString` 取当前连接模块的 MAC | 不能取 `xp_vehicle_mac.macAddress`，否则回 `0x0e`（§6.13） |
| 开/关后备箱共用 `cmd = 0x04` | 方向不由材料携带，**由车端按当前开合状态决定**：2026-11-10 复核，`token_json` 只有 `cardNo`/`message` 两键、无方向列，材料服务端批量预签 300 条且请求不带动作参数，故不可能预先绑定方向；同次抓包的开/关两帧除随机 `ED`/`SN` 与计数器外字节全同。客户端侧表现为切换键（§6.7） |
| 每条命令前重新握手 | 无会话复用；挑战窗口 2.0–2.5 s（§6.12） |
| CCCD 先写 `0200` 再握手 | `0x0010 = 0200`，开启 indicate（§6.10） |

**常驻连接（自研端 2026-11 引入，非官方行为）**：把「每条命令建连一次」改成「钥匙物料就绪即持有连接」，省掉建连 + 服务发现 + MTU 协商约 1.2 s 与首连 `133` 重试，**但握手省不掉**——上面「每条命令前重新握手」的约束不变，每条命令仍完整走 `ef0104 → ef0110 → ed1118 → ed118b`。

**关键纠正（2026-11-12 真车实测）：「连上不认证」撑不住常驻。** 只建连、不发握手时，车端每 **4.88–4.93 s** 主动断开（`onClientConnectionState status=19 / GATT_CONN_TERMINATE_PEER_USER`），连续 8 个周期波动 <0.05 s，是固定计时器而非「被别的手机抢连接槽」那种忽快忽慢；与 §1537「假车只声明 INDICATE 时 App 干等 5 秒超时断开」一致。**所以常驻 = 连上立即三段认证 + 周期性重鉴权**。认证材料一次性（`BleV2MaterialService.take()` 每条消息只能用一次、失败不归还，队列耗尽才向服务端补拉），故每轮重鉴权都要重新取一条材料。官方 App 一次 65 分钟抓包里自动重鉴权 31 轮、中位间隔约 127 秒（§1223），即此机制的官方取值；实测把握手放到 `auto:false` 直连之后，连接从「每 5 秒被踢」变为「一次认证后稳定保持约 123 秒」，与官方 ~127 秒重鉴权周期吻合。

**连接层前提：后台连接（`autoConnect=true`）在本机蓝牙栈不可靠。** 实测 `connectDiagnostic`（`autoConnect=true`、45 s）发出后只登记一个「等广播」的后台连接，45 s 内拿不到任何 `onConnectionStateChange`；改走 `connect`（`autoConnect=false`、10 s 前向连接）后，首连偶发 `133`、随即重试即 `status=0` 成功——与原生模块重试逻辑只在 `autoConnect=false` 上验证成功一致。

**官方「靠近自动解闭锁」机制（2026-11-12，静态证据）**：`com.xiaopeng.common.car.ble.ipc.BleService` 跑在独立进程 `:BLE`，由 `ProcessForegroundMonitor` 维持，挂常驻通知「手机钥匙 / 正在运行」（`ble_polling_service_title`、`ble_polling_service_desc_default`=「正在运行」、`ble_polling_service_info`=「手机无感钥匙已启动」）；清单声明 `WAKE_LOCK` 与 `RECEIVE_BOOT_COMPLETED`。判距不是直接换算米数，而是先在「主驾门 1 米 / 后尾门 1 米」做**手动校准**（`AdjustBleByHandActivity`，文案「手机距离主驾门1米」「手机距离后尾门1米」），再按灵敏度档（`PollingSettingActivity`、`desc_polling_sensitivity`）判定；字段名 `pollingIntervalMs`、`pollingUserUnlockDistance`、`scanIntervalDispose`、`keepAliveInterval`。**官方后台是保持连接 + 周期保活**（`keepAliveInterval` 与 §1223 的 ~127 s 重鉴权吻合），不是只扫描。具体阈值/间隔在加密 dex 内，静态取不到，只能在车边标定。

**车端在已有 GATT 连接时不广播（2026-11-12 真车实测）。** 前台持有连接期间，按 `00:60:37:85:B9:D0` 过滤的判距扫描连续 20 轮 `results=0`（连无关设备都收不到），`Connections: 1`；退到后台、`release()` 断开连接后，同一扫描立刻扫到车，`results=1–11`、RSSI 稳定在 `-83…-90 dBm`。因此「前台保持连接」与「后台判距扫描」互斥，不能同时跑；车边标定的阈值必须按「无连接时的广播 RSSI」取，不能用连接期间的信号。另：`SCAN_MODE_LOW_POWER` 在本机实测也能收到结果（02:52 那次 36 条），但为稳妥用 `BALANCED`。

**判距扫描与 GATT 建连争用同一控制器（2026-11-12 真车实测）。** 扫描运行中发起连接直接吃 `133`（`GATT_CONN_FAIL_ESTABLISH`），原生层三次重试都落在同一窗口内全部失败；改为「动作前停扫描、动作后恢复」后同一动作 2.4 s 内成功（`action=unlock ok`）。

**自研端分工（2026-11-12，用户确认）**：前台保持连接；退到后台释放连接、只跑扫描，命中「靠近/离开」才临时连一次、认证、发一条解/闭锁。判距用「进入/离开双阈值 + 停留时间」（滞回挡临界抖动、较长离开停留挡路过误锁）。**不查车锁状态，靠近即解锁、离开即闭锁**（用户明确选择；代价是车本已解锁时仍会重发一次解锁、经过车尾需超过离开停留才闭锁）。后台扫描环的计时必须在原生侧：RN 的 `setTimeout` 在 Activity 后台/息屏时被暂停（见下条），扫描节奏交给 JS 会停摆。

**前台服务只抬进程，不防 CPU 休眠。** 息屏进 Doze 后 RN 的 JS 定时器全停：实测息屏 150 s 内退避重连**一次都没发生**（被踢后 3.5 分钟零重连尝试，拉回前台瞬间恢复）。常驻保活必须在 `connectedDevice` 前台服务里持 `PARTIAL_WAKE_LOCK`（Doze 对超过 10 min 的 wakelock 判失效，需到期前重取），代价是持续唤醒 CPU、耗电增加。

其余会踩的坑：① GATT 客户端只有一个连接槽，常驻会占住它，同车官方 App 的蓝牙钥匙会被挤掉；② 原生模块在 `gatt != null` 时对新连接直接回 `E_BUSY`，常驻期间任何新连接请求都会撞上它；③ 权限被撤销、蓝牙被关掉这类前置条件错误必须单独识别，否则无限退避会变成每 30 s 一次的无效重连；④ 前台服务保活（`connectedDevice` 类型）在 Android 14+ 缺 `BLUETOOTH_CONNECT` 时 `startForeground` 抛 `SecurityException` 直接崩进程——实测复现，必须在服务里接住并 `stopSelf()`，不能靠调用方先查权限兜底（服务运行期间权限随时可能被撤销）。

### 6.21 取证手段与边界
- **`am dumpheap` 绕过 Frida 的 ptrace 保护**：`adb shell am dumpheap <pid> /data/local/tmp/app.hprof` 产出约 82 MB（约 20 秒）。走 `Debug.dumpHprofData` 系统路径，不需要 ptrace，加固壳挡不住。
- **`TestBleKeyV3Activity` 必须用 root 启动**：`adb shell su -c "am start --user 0 -n com.xiaopeng.mycarinfo/com.xiaopeng.common.car.home.TestBleKeyV3Activity"`。该 Activity 未导出，`shell`（uid 2000）直接启动会报 `SecurityException: not exported from uid 10235`。标题「测试数字钥匙3.0」，9×4 绿色按钮矩阵，覆盖整条 V3 握手与车控链路。九行按钮：① 支持V3 / 启动BLE / 创建钥匙 / 分享钥匙 ② 删除钥匙 / 拉取报文 / 连接蓝牙 / 解锁 ③ 闭锁 / 闪灯 / 开窗 / 关窗 ④ 自标定 / 进入泊车 / 订阅车况 / 泊车心跳 ⑤ 清空报文 / AUTH0_REQ / AUTH0_RSP / AUTH1_REQ ⑥ AUTH1_RSP / RKE_REQ / RKE_RSP / ICCOA=>GOOGLE ⑦ ICCE / 获取钥匙列表 / 清空小米拉活配置 / 获取MAC地址 ⑧ 获取报文数量 / 获取报文 / 开通钥匙账号联登 / 关闭钥匙账号联登 ⑨ 获取联登状态 / 延时杀死主进程 / 延时杀死蓝牙进程 / 当前是否使用应急钥匙。
  **但这 39 个按钮点击后 `onClick` 不执行**（主进程零日志输出），窗口本身在 `InputDispatcher` 里注册正常（`inputConfig=0x0`、`touchableRegion` 全覆盖、`ownerUid=10235`、`responsive=true`），按钮也 `clickable=true`/`enabled=true`。原因未明，故**这个界面目前不能用来抓 sessionKey**（附录 §6.42f）。
  该界面在 4.2.0 里不存在，是 5.x 新增的（附录 §6.42g）。
- **Frida 会打断真实蓝牙连接**：`:BLE` 进程 attach 成功后 App 的蓝牙连接随即断开，pid 在崩溃重启循环里递增（30664 → 32409）。杀 frida-server 与所有 watcher 后立刻能连上（用户两次独立确认）。hook 抓不到握手帧的原因是 `:BLE` 进程在每次握手前被重建（4112 → 4523 → 5033 → 5338），而 `libbledata.so` 懒加载，attach 上去时握手往往已完成。
- **HCI 抓包无需 root**：`settings put global bluetooth_btsnoop_log_mode full`（注意是 `global` 域的 `bluetooth_btsnoop_log_mode`，不是 `secure` 域的 `bluetooth_hci_log`），再 `cmd bluetooth_manager disable` / `enable` 使设置在蓝牙重启时被读取，之后 `adb bugreport` 取 zip 内 `FS/data/misc/bluetooth/logs/btsnoop_hci_*.log`。解析用 `scripts/btsnoop_decode.py`（不依赖 tshark）。

### 6.22 未解决项

| 项 | 状态 |
| --- | --- |
| P5V2 `ed1118` 与钥匙物料 | 隔离入口及已有登录态生产链路的解锁/锁车均已完成真车验收；无钥匙账号激活、新鲜物料全链路和其它命令未验。V3 `val`/`data`、sessionKey 来源另待确认（§6.14、§6.93） |
| `0x70` 的结果码与 `payload[0]` 语义 | `payload[0]` 不是稳定命令回显；`163` 和同帧 `0x2a` 的官方语义不可得，保留为待取证缺口（§6.11） |
| 握手是否硬前置 | **未知**。观察到的时序是每条命令前都重新握手，但「跳过握手能否发命令」未做 A/B/C 对照，现有证据不支持「车端必然丢弃」的强断言（§6.12） |
| `ED` 是否被车端校验内容 | 未验证。若车端只验签名，`ED` 随便填；若当 nonce 防重放，必须与车端协商。需发一帧 `ED` 全零的车控帧看是否被拒，有风险 |
| `ED` 时效、`KI` 跨会话稳定性 | 接口每轮新发 `ED`，但车端是否拒旧帧未实测；`KI` 同一会话内稳定，跨握手轮次未验证（只有一轮里出现了车控帧） |
| `0xEC` 通道含义 | 该帧 `TBox type = 0x00`，payload 8 字节 ASCII `23897711`，紧跟解锁回执之后，更像车辆序列号或会话标识，非登录。需更多样本 |
| 未定位语义的字节/msgId | `header[4..8]`（`6a 7b 5f e0`，作 BE 是 2026-08-11 17:46 UTC，早于抓包 82 天，作 LE 是 2089 年）；`0x0231`/`0x0261`–`0x0263`/`0x02f6`–`0x02fb` 不在 D55 分派表内且 payload 全零，疑为同族状态位图；`0x0082` 三条子字段后 6 字节每轮全变、`0233` 末两字节恒零，非递增计数器；`0x0318` 末字节 `0x93`/`0x01`/`0x23`，疑为状态位 |
| 2801/3205/3206 组 UUID 的角色分配 | 仅 `406D` 组与 `…6D6C`/`…2802-…573FF530` 经实车证实，其余属结构推断 |
| RSSI 阈值、超时、退避曲线、`CmdSelectChannel` 判定逻辑 | 在加密 dex 内 |
| `BleCmdDefine` 各枚举取值、`TYPE_BLE_*` 载荷结构 | 在加密 dex 内；「载荷是 `{mac, cmdType, payload, timeout}`」一类说法都是猜的 |
| `XmartV1LocalKey*` 轮换周期 | 未验（§9） |

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
| 登录与会话 | ✅ 闭环（真号实测，§4.2） | 0 |
| 令牌续期 | ✅ 闭环，连续 5 次成功 | 0 |
| MQTT 连接与凭据 | ✅ 闭环 | 0 |
| MQTT 车控指令 | 🟡 14 条可固定参数下发；临停/远程查看/远程启动真机取证结论见 §5.6、§5.7 | 云端远程启动需自研有效登录态签发 `<TOKEN>`；其 TTL / 复用性未验 |
| BLE 握手 `ef0110` | ✅ KDF 解出，188/188（§6.13） | 0 |
| BLE 握手 `ed1118` | ✅ P5V2 隔离验收入口在本车完成严格挑战校验（§6.14）；V3 另待验 | 无钥匙账号激活与其余命令的新物料链路 |
| BLE 车控帧下发 | ✅ 隔离入口与已有登录态生产 BLE-only 链路在本车各完成一次解锁/锁车并由用户现场确认（§6.14、附录 §6.92、§6.93） | 其余 5 个动作、标准命令回执、车况 UI 刷新 |

**客户端身份与令牌生命周期已完成既有账号验证。** BLE 的 `ef0110` KDF 已解出并双实现验收；P5V2 `ed1118` 的 Java AES verifyKey 路径、隔离入口及已有登录态生产 BLE-only 解锁/锁车链路已在本车验证。剩余验收包括无钥匙账号激活、其余动作的新鲜物料链路、标准命令回执和车况 UI 刷新；V3 sessionKey 的未知不能概括为本车唯一卡点（§6.14、§6.93）。

**两个必须先接受的约束**：

- **单会话**：同一账号同时只允许一个有效会话，自研 App 登录会把官方 App 踢下线。
- **跟版**：appId/secret 一旦轮换、canonical 一旦改版，客户端立刻失效，必须跟随官方版本更新。§2.2 的 dump 流程就是跟版时的重新取证手段。

**成本边界**：云端车控与 BLE 验收分开估算；P5V2 隔离入口及已有登录态生产 BLE-only 解锁/锁车结果，不能替代无钥匙账号激活、其余动作的新鲜物料链路、标准回执和车况 UI 刷新验收。

### 8.2 挂在官方进程上（兜底一）

不复刻 App，只做「界面壳 + 官方进程」：钥匙物料、TEE、签名全部沿用官方链路，自己只接管 UI 与连接策略。依据是 §6.2——BLE 协议层是纯函数、无调用方校验，hook 进去可直接调 native 原语，绕开官方那套 217 个类的轮询状态机。

代价：需 root 或 Frida，而 **Frida attach `:BLE` 进程会打断真实蓝牙连接**（§6.21），只能做一次性取证，不能作为运行期架构。另外官方改 native 接口就要跟；分发撞版权。

### 8.3 改包精简（不可行）

改包必换签名 → TEE 绑定的 `XTeeSecurityAlias` 与 `KeyTokenDao` 数据失效，数字钥匙不可用；服务端签名判定也会命中 `err_ban`（「被屏蔽所有操作，可能由于签名不正确或无权限」）。且需先脱壳才能改 dex。**不要走。**

### 8.4 不动 APK，从外围治（兜底二）

官方 App 自带可调项：`PollingSettingV3Activity`（轮询灵敏度）、`AdjustBleByHandActivity` + `SelfCalibrationManagerV3`（手动蓝牙校准）、`UnlockMethodActivity`（解锁方式）、`BleCheckNewActivity`（蓝牙自检）。

App 自己承认两处结构性弱点：`ble_check_fail_des` = 「先关闭蓝牙，再打开，可解决90%问题」，`adjust_ble_by_hand_suggest_one_title` = 「自动解闭锁功能需小鹏App常驻后台，手机系统关闭App会导致功能失效」。这两句指向**后台保活与蓝牙栈状态**，而非协议本身。

顺带一点：远程车控走 MQTT over TLS，**不走 BLE**。把解锁上锁切到云端指令即可绕开蓝牙链路，代价是多一次网络往返。

---

## 9. 未验证项

**BLE**

- **P5V2 新鲜钥匙物料与其它动作**：本地注入的一次性材料已通过本车隔离验收；已有登录态的生产 BLE-only 解锁/锁车也已真车验收。无钥匙账号激活流程、其余 5 个动作的新鲜物料与方向绑定、标准命令回执和锁车后车况 UI 刷新仍未完成（§6.14、附录 §6.92、§6.93）。
- **`0x70` 回执语义**：`200` 是已知成功码之一；锁车物理生效时观察到 `163`，但其成功/中间态/失败语义及同帧 `0x2a` 未取得官方定义，均为待取证缺口（§6.11）。
- **V3 sessionKey、`val` / `data` 的真实调用参数**：native XOR/TLV 与 Java JNI 契约已确认，但不得用于反推 P5V2 AES 路径（§6.14）。
- **握手是否为命令的硬前置**：`§6.35e` 的原始实验用了自拼坏帧，结论已作废，需用修好 CRC 的帧重做（§6.21）。
- **`ED` 的时效与防重放是否被车端校验**：若校验，服务端签发的帧必须在有效期内用掉（§6.21）。
- **子账号改成真 MAC 后能否握手成功**：按 §6.13 的因果应当可以，但需要车在身边实测。
- **App 连从模块时是否也换 `keyString`**：`§6.13` 只验证了连主模块的情形。
- **`ed1118` 与 `ef0110` 是否同源**：`§6.13` 留的悬案，目前只确认「不同源」。
- **车端限流阈值**：目前只有 3 个采样点，`0x0e` 后需冷却 ≥45 s（§6.14）。
- **修好 CRC 的独立探针帧**：`§6.15` 的帧已逐字节校验通过；本轮隔离验收另以已组装的解锁/锁车命令帧各发一次并由用户现场确认生效（附录 §6.92）。
- **`0xEC` 通道解密后的明文内层布局**：本次只出现一条，payload 是 8 字节 ASCII，疑似会话标识（§6.7），未定。

**自研客户端现状边界**：当前 `commands.ts` 没有导出 `service_type:11` 或 `st=9 ct=3/6`，自研 App 的 Control 页只展示 `remote_start_status` / `temp_lock_st`、没有远程查看与远程启动按钮；脚本侧只有临停 `temp-park` 与只读 `camera-state`。摄像头初始化、拉流、四个单路视角与关流的 `cmd_value` 已由真机逐项点击和精确配对闭环，可直接接入；远程启动 `<TOKEN>` 生成链仍未闭环，但两者都不是现网缺陷，而是接入这些功能前的前置条件。BLE `startCar` 虽可绕开 `<TOKEN>`，当前只验收了解锁/锁车，未接通远程启动。

**MQTT 车控指令**

- **单扇车窗的指令码**：`st=12` 能读四个车窗位置，控制值未找到。App 发的请求报文未抓到。
- **除霜、内外循环、座椅加热通风、智能清洁/除味/香氛**：同因，控制报文抓不到（§5.9）。
- **远程查看扩展视角**：当前车机界面的前/后/左/右四路已闭环（§5.7）；静态枚举里的 `CAMERA_360`、`CAMERA_TOP`、`CAMERA_FOUR_GRID`、`CAMERA_OMS` 等扩展视角没有在本车界面出现，其 `cmd_value` 与 `camera_type` 未验证。
- **遮阳帘 99→48 的跳变**：未解释（§5.9）。

**协议与接口**

- **`/biz/v4/*` 的签名算法**：`/biz/v4/vehicle/v2/myVehicles` 返回 `11001101 check v4 sign fail`，说明 v4 在线但签名算法不同。**未验证。**
- **`/sp-vowner-mapp/*` 的路由主机**：所有候选网关均返回空体，真实入口未定位。
- **官方 App 的真实续期路径**：运行堆里 `token/refresh` 命中 0、`WEEB` 命中 0，其续期不走该接口；但 `tee` 确实会每约 3 小时自动更新（§2.6）。该能力在加密 dex 内，无法静态读取。

**登录**

- **运营商一键登录是否可用**：`oneclickLogin` 端点与三家 SDK 均在 App 内（§4.2），但 `accessCode`/`token` 必须在真机 + 真实 SIM 上由运营商网关鉴权换取，模拟器无法验证。若可用，这是完全绕开短信与滑块的入口。

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


后续新增的取证脚本：

- `scripts/btsnoop_decode.py`：解析 btsnoop HCI 抓包（§6.12）。
- `scripts/ble_frame.py`：BLE 帧编解码，`--selftest` 自检（§6.13 → 现 §6.12）。
- `scripts/fake_car.py`：模拟器内虚拟车端（§6.5）。
- `scripts/ble-kdf-verify.py` / `scripts/verify-ble-kdf.mts`：`ef0110` KDF 的 Python 与 TS 双实现验收，188/188（§6.13）。
- `scripts/ble-prep-frames.py`：从 `XpVehicle.db` 取 CRC 已验证的帧，输出可直接喂给探针的十六进制（§6.15）。
- `scripts/ble-handshake-probe.swift` / `scripts/ble-direct-cmd-probe.swift`：Mac 端直连车端的握手与指令探针（§6.15）。

---

## 附录：不可复现的实测数据

按调研轮次记录的实测值（native 偏移、抓包样本、设备拓扑、明文帧、取证命令）
单独存放在 [`xpeng-app-teardown-appendix.md`](xpeng-app-teardown-appendix.md)。

正文没有这些内容的副本，APK 与 dump 不入库，重跑需要 root 真机与车旁实测——
需要具体数值时去那里查，不要重新做实验。

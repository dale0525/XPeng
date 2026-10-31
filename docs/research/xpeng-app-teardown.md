# 小鹏 App（com.xiaopeng.mycarinfo）逆向调研

目的：为「自研 App 替代官方」评估技术成本与卡点。结论按「自研 + 钥匙从官方服务端接口获取」这条路线组织。
调研对象：国内版 5.19.0（`versionCode 10639`，265 MB）为主，4.2.0（`versionCode` 未记，120 MB）作对照。

> 本文档只保留**当前成立**的结论。已被实测推翻的判断集中在附录 A，仅供避免重走弯路。

---

## 0. 结论速览

**客户端身份层已全部闭环**：签名、appId、secret、密钥池、本地密钥、信封格式、MQTT 凭据全部打通并线上验证。

**续期已闭环**：一次登录 + refresh 循环即可长期免重登。连续 5 次续期全部成功，每次 `keyIndex` 轮换。**注意**：重新登录后若解出的 token 尾部不变，说明 `mmkv_read` 读到了 MMKV 里的历史值，见 §4.6。

**车控已打通 13 条**：解锁、锁车、闪灯、遮阳帘开关、空调开关、设温度、全车车窗升降、极速降温、极速升温、高温抑菌、鸣笛、哨兵开关、哨兵灵敏度。均实测成功并有 `code:200` 回执。

**未打通**：单扇车窗、除霜、内外循环、座椅加热通风、智能清洁/除味/香氛（风量官方 App 无此功能，不需打通）。**后备箱开关不在 MQTT**（走 BLE，用户 10-31 确认，见 §5.6）。**「解锁并启动」的启动那一步不在 MQTT**（走 BLE，见 §5.6）。**远程查看**只读可用，开流与视角切换本车无环视硬件（`avm_exist=0`）无法实测。**鸣笛**按用户要求不再排查。剩余项原因统一为「App 实际发的请求报文抓不到」——报文在内存中存活极短，Frida 被易盾反调试阻断，且 App `flags=0x0` 不可调试（`am instrument` 反射枚举方案不成立）。

| 子问题 | 状态 |
| --- | --- |
| 请求签名（双层 HMAC） | ✅ 闭环 |
| appId / secret | ✅ `xp_xmart_android` / `<XP_SECRET>` |
| 客户端证书 | ✅ 可提取，国内主机不要求 |
| 钥匙物料链（tenant → 密钥池 → 本地密钥） | ✅ 闭环 |
| `Xp-Authorization` 信封 | ✅ 闭环（分版本，见 §3.3） |
| 登录 | ✅ 打通，但滑块需复用官方 |
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

### 2.7 没有任何证书 pin

- 四份网络配置（`network.xml`、`jz_network_security_config.xml`、`network_security_config.xml`、`network_security_config_2.xml`）只有 `<base-config>` / `<domain-config>` 的 `cleartextTrafficPermitted`，**无 `<trust-anchors>`、无 `<pin-set>`**；dex 内无 `sha256/` 形式 pin 常量。
- `res/raw/my_ca.pem` 是一张 Charles Proxy CA，但四份配置都没引用它，dex 内 `raw/my_ca` 命中 0，属开发期遗留。

但**这不等于可以 MITM**：`targetSdkVersion=31`，按 Android 7+ 规则不信任用户 CA。实测 mitmproxy 抓到 `Client TLS handshake failed. The client does not trust the proxy's certificate for apps.xiaopeng.com`。系统信任库三个路径全部只读，模拟器 `adb remount` 报 `Device must be bootloader unlocked`。**不要指望 MITM。**

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

**验证码双滑块**：滑块共两次，不是异常。`smsType=1/2` 在**发短信前**验一次；短信校验通过后**换 token 时**再验一次。第二次同样强制。

接口直连下发短信对任何号码（含真实号码）统一返回 `12051401 短信发送失败`，而 App 界面路径成功——说明 UI 额外带了 Yidun `validate` ticket 或设备上下文头，纯 API 调用无法复现。**自研客户端应复用官方滑块或改用其他登录方式，不要试图绕开。**

### 4.2 令牌结构

登录成功后，token **不在 HTTP 头里**，而在内层明文末尾：

```
UUID + base64({"xpSign":"…"}) + "&accessToken=" + JWT(968 B)
```

post-login 的 canonical 头集合与登录前不同：出现 `XP-UID`，且 `appVersion`/`brand`/`deviceModel`/`osVersion`/`versionCode` 改为小写形式，另加 `XP-OTA-DATA-WITH-OBJECT-VALUE=1`、`XP-OTA-DATA-WITH-VERSION=1`；`XP-TEE-ID`、`XP-PTOKEN` 不再作为独立头出现（TEE 值仍嵌在 `Xp-Authorization` blob 内）。

### 4.3 令牌寿命

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

### 4.4 续期（已闭环）

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

### 4.5 单会话约束

同一账号同时只允许一个有效会话，自研 App 登录会把官方 App 踢下线。已在真实账号上触发过一次，**尚未找到共存办法**。

### 4.6 重新登录后解出的 token 仍失效——MMKV 追加写陷阱（2026-10-30 定位并修复）

**现象**：用户退出并重新登录后，`unseal-token.py` 解出的 accessToken 尾部不变（`ou-tBUvxONOK0SaI`），`renew.py status` 返回 `12010101 登录状态已过期`，`renew.py renew` 返回 `12010201`。App 自身却工作正常。

**误判过程（本应避免）**：一度怀疑 token 存在别处、试图从 `/proc/PID/mem` 捞明文（读 `I/O error`，SELinux `u:r:su:s0` 下受限）、试了 `vehicle/list`、`queryList` 等错误路径。文档 §4.4 已写明续期闭环，正确做法是先读文档再排查。

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
| 登录与会话 | ✅ `/sso/app/v5/smsLogin` | 滑块需复用官方 |
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

- **滑块验证码能否程序化通过**：未验。两次滑块均强制，UI 路径成功而纯 API 下发短信被拒（`12051401`）。这是登录环节的硬风险项。
- **真正的验证码下发接口**：`/sso/app/v3/getSmsCode` 返回 `12001100`（遗留路径），正确接口未定位。

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
| 可以 MITM 抓明文 | **错**。`targetSdk=31` 不信任用户 CA，系统信任库只读 | mitmproxy 实测拒绝 |
| 5.19.0 无法在模拟器运行 | **错**。可运行，是 5.23.5 崩 | 实测 |
| 哨兵模式只能读不能写 | **错**。`st=8 action:2` 可写，`SENTINEL_MODE_VIDEO` 就是开关位 | 写 1/0 后 `soldier_camera_status` 0→1→0 |
| `st=8` 的 `settings[]` 按数组位置对齐 | **错**。按键名匹配，顺序无关；未知 `code` 被静默忽略 | 首元素塞 `ZZ_BOGUS` 后灵敏度仍正确落位 |
| `SENTINEL_MODE` / `SENTINEL_ACTION` 是哨兵开关的字段名 | **错**。写这两个键不改变任何状态；开关是 `SENTINEL_MODE_VIDEO` | 三者分别写入后读 `st=19` 对照 |

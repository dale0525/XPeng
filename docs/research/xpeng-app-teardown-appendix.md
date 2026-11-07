# 小鹏 App 逆向调研：不可复现的实测数据

本文件是 `xpeng-app-teardown.md` 的附录，单独存放以免正文过长。

收录按调研轮次记录、**删掉就永久丢失**的实测值：native 函数偏移与符号地址、
AES IV / CRC 常量、真实抓包样本与统计分布、设备 MAC 与拓扑、KI/ED/SN 明文帧、
堆地址与命中数、frida 版本矩阵、取证命令、错误码组合。

正文没有这些内容的副本，APK 与 dump 不入库，重跑需要 root 真机与车旁实测。

**这里的结论可能已被正文推翻**——凡遇到「全断」「不可能」「唯一缺口」一类断言，
以正文对应章节为准。轮次编号沿用拆分前的 §6.x，与正文 §6.x 不是同一套。

---

### 6.19　静态代码定位：APK 版本对不上，dex 被 360 加固，但 native 层是明文

#### 6.19a　手头 APK 比手机旧了 4 个版本

| | 版本 | 来源 |
| --- | --- | --- |
| `work/apk/XP_MobileAPP_Android_gw.apk` | **5.19.0**（versionCode 10639） | 之前下载的 |
| 手机实装 `com.xiaopeng.mycarinfo` | **5.23.6**（versionCode 10829） | `dumpsys package`，2026-10-29 更新 |

5.23.6 的 base.apk 已从手机直接拉取到 `work/apk/v5236/base.apk`（303 MB，2026-11-01）。**此前所有基于 5.19.0 的静态结论都可能过期**，凡与实车抓包冲突的以抓包为准。

#### 6.19b　`XPBKTH` 在两个版本的 APK 里都不存在

对 5.23.6 全树（10273 个文件）做二进制搜索：`XPBKTH` 0 命中、`PBKTH` 0 命中。5.19.0 同样 0 命中。

所以魔数**不是以字面量存在于任何文件里**——它要么在加固段中于运行时解出，要么由代码拼装（如 `'X'<<24 | ...`）。这不影响 §6.18 的结论（那是从字节反推的），但意味着「搜字符串定位构造代码」这条路走不通。

#### 6.19c　dex 被 `com.secneo.apkwrapper`（360 加固）包裹

`classes.dex` 文件 118.7 MB，但 **dex 头自称只有 104 KB**：

```
file_size  = 118720184        ← 整个文件
header_size= 112
data_off   = 19160
data_size  = 84928            ← 真正的 dex 只有 19160+84928 = 104088 字节
```

`class_defs` 只有 180 个，全是 `com.alibaba.android.arouter.routes.*` 和 `com.secneo.apkwrapper.*`（`AP`/`AW`/`CP`/`H`/`a`/`b`）——**这是壳的引导 dex，不含任何业务代码**。

偏移 104088 之后是壳的私有段，标记为 `dexdata0`：

```
01 00 00 00 | 14 f0 11 07 | 08 00 00 00 | "dexdata0" | 00 f0 11 07 | 06 9a c0 00 | <加密数据...>
```

`0x0711f000` 是内存映射基址，`0x00c09a06`（≈12.6 MB）是加密段长度。该段熵 **7.63 bit/byte**（8.0 为完全随机），确认是加密或强压缩。

**推论**：`RpaSigManager` / `BleCmdBuilder` / `BleCmdConstants` / `MonaBleCommunication` 这些类名确实出现在 dex 的字符串池里（说明它们被壳的引用表登记），但 **class_def 不在明文 dex 中**，jadx 报 `Input class not found`。要拿到它们的字节码必须动态脱壳（运行期 dump 内存中的 dex），静态走不通。

#### 6.19d　native 层没有加固，帧构造就在 `libbledata.so`

`lib/arm64-v8a/` 下的 so 是**明文**的，`libbledata.so`（5.23.6 版 1181688 字节，2513 个导出符号）包含：

```
createCommandParameters              0x08bcb0
createCommandParametersWithDecodeToken 0x08beac
createCommandPayload(BLEBoxCommand, const void*, size_t, size_t*)      0x08aa50
createCommandPayload(BLEBoxCommand, void*, size_t, size_t*)            0x08aab0
createKeyStringCommandPayload(BLEBoxCommand, const char*, size_t*)     0x08ab10
createKeyStringCommandPayloadV3(BLEBoxCommand, const char*, size_t*)   0x08aba0
```

反汇编 `createCommandParameters` 的前 60 条指令确认它做的是：取输入长度 → 分配 `len+1` → 拷入 → **在末尾追加 1 字节**（`strb w23, [x25, x19]`，`w23` 是第一个参数）→ 再分配一次并复制。

这与 §6.18a 观察到的「**指令码写在 payload 最后一字节**」完全对应：`w0` 就是 cmdCode。§6.6 当年的推断由此在指令层得到独立佐证。

`libbledata.so` 里**没有任何 ECDSA 符号**（无 `ECDSA_sign`、无 `EC_KEY`、无 `i2d_ECDSA_SIG`），只有 AES-128/256-CBC、HMAC-SHA256、HKDF-SHA256（`SDKBleKeyV3` 命名空间）。**所以签名不在这层做**——要么在加固的 Java 代码里（`RpaSigManager` 这个名字强烈暗示），要么在另一个 so。

`libkmssdk.so` 只有 `PsoKmsGetKey` / `Java_com_xiaopeng_kmslib_KmsSdk_getKey` 两个入口，是密钥获取的 JNI 桥，不做签名。

#### 6.19e　下一步的两条路

1. **动态脱壳**：在模拟器或真机上让 App 跑起来，从内存 dump 出解密后的 dex，再用 jadx 反编译 `RpaSigManager`。可行，但要处理壳的反调试，且需要在真机上（数字钥匙功能依赖真实车端）。
2. **动态挂钩**：用 Frida hook `libbledata.so` 的 `createCommandParameters` 和 Java 层的签名调用，直接看运行时参数。比脱壳轻，但同样需要能附加到进程的设备。

两条路都依赖「能在真机上 attach 进程」，这需要用户配合（手机 root 或能装 frida-server）。**在拿到其中任一条之前，静态侧能做的已经到顶了。**

#### 6.19f　但签名链路本身已经够用

需要强调的是：§6.18f 已经把签名算法、曲线、消息范围、公钥全部解出。**即使永远脱不了壳，自研客户端也只需要一把符合要求的 P-256 私钥就能签发合法帧**——不需要知道官方 App 的代码长什么样。真正缺的只有那把私钥（§6.18h）。

#### 6.19g　native 层定位结果：全是接收解析，没有签名

对 5.23.6 的 `libbledata.so` 逐函数反汇编后，native 侧的职责已经划定清楚：

**`D55DataParser::specificityMessage`（`0x96d50`）是 msgId 分派表**，编译出的立即数比较如下：

| msgId | 分支 |
| --- | --- |
| `0x0055` | `parseBleReq` 路径 |
| `0x005d` | 位域解析后回调 |
| `0x0070` | 尾调用（`b 0x114f00`） |
| `0x0225` | 位域解析后回调 |
| `0x0281` | 位域解析 |
| `0x02d5` | 位域解析后回调 |
| `0x02fb` / `0x02fc` | 经虚表 `br x1` 重定向 |
| `0x0318` | 经虚表 `br x1` 重定向 |

与实车抓到的 msgId 集合（`0x55 0x5d 0x70 0x225 0x231 0x261–0x263 0x281 0x2d5 0x2f6–0x2fc 0x318`）对照，**`0x55`、`0x5d`、`0x70`、`0x281`、`0x2fb`、`0x2fc`、`0x318` 全部命中分派表**。这从 native 侧独立证实了 **§6.17 的判断：这台车走 D55 协议族**。此前只能靠「msgId 不在 V3 表内」反推，现在是正向命中。

**但所有 `parse*` 函数都是纯接收解析**。以 `parseIBCMFirst`（`0x96920`）和 `parseBleReq`（`0x96b08`）为例，函数体只做：

```
ldr  x21, [x0, #0x30]        ; 取 64 位字
ubfx x8, x21, #0x34, #4      ; 抽 4 位
strb w8, [sp, #5]            ; 填进栈上结构
bl   #0x114ee0               ; 交给回调
```

即「从位域抽字段 → 填结构 → 回调」。`parseIBCMFirst` 更进一步，用 `dup v0.2d` + 四条 `ushl` + `uzp1` 做 SIMD 位域抽取，一次解多个字段。**没有一处调用 AES、HMAC 或 ECDSA**，也没有构造任何上行帧。

**六个 App 自有 so 的 ECDSA 符号统计全为零**：

```
libbledata.so       0
libkmslib.so        0
libkmssdk.so        0
libijiami_H5SDK.so  0
libmsaoaidsec.so    0
libNetHTProtect.so  0
```

`libbledata.so` 的密码学符号只有 `aes_128_cbc_encrypt/decrypt`、`aes_256_cbc_encrypt/decrypt`、`hmac_sha256`、`hkdf_sha256`，全在 `SDKBleKeyV3` 命名空间下——那是 **V3 协议族**（AES+HMAC），与实车用的 D55（ECDSA 签名）是两套独立栈。

**结论**：签名发生在加固的 Java 层，`RpaSigManager` 是唯一的名字线索。native 侧没有可挖的签名实现，静态分析到此确实到顶。

#### 6.19h　`KI` 的来源：设备侧持有，车端不明文下发，握手推不出来

§6.18g 确认了 `KI` 是 AES-128 密钥（能解握手帧出 `4B + 12B 零`）。本节回答更关键的问题：**自研客户端能不能自己算出 `KI`**。

**答案是不能。** 三条独立证据：

1. **`KI` 不由握手随机数派生**。同一连接两轮握手的 `0xED` 帧，`dec(KI, payload[:16])` 分别得到 `42b10da7` 和 `f4eee6ef`（都是 4 字节 + 12 字节零，规律稳定）。以这两个 4 字节值（大小端各一）作输入，试 `SHA-256[:16]`、`SHA-256[16:]`、`MD5`、`HKDF-SHA256`，**零命中**。
2. **`KI` 不由握手三段任意组合派生**。`r1`/`m16`/`ed` 的 9 种拼接 × 4 种 KDF，**零命中**。
3. **车端从不明文下发 `KI`**。整个 3932 秒抓包里，`KI` 的字节序列只出现 **2 次**——就是两条车控帧的 `KI` TLV。扫描全部 ATT 载荷，命中位置只有 `ts=0xe33cf0ef79d9e2` 和 `0xe33cf0efeb2f10`（即解锁、上锁两帧）。**没有任何一条下行帧携带它。**

**推论**：`KI` 是**设备侧持久化存储的凭据**，随蓝牙钥匙激活时下发并落盘，此后长期复用（两条车控帧间隔 7.4 秒、同一次连接，值完全相同）。跨会话是否变化**仍未验证**——这是第 4 项任务（再抓 2–3 条指令帧）要回答的核心问题。

**这对自研客户端意味着**：即使拿到 ECDSA 私钥，也必须同时拿到 `KI`。`KI` 不可推导、车端不下发，只能从设备上取——而设备侧不可读：

```
$ adb root
adbd cannot run as root in production builds
$ adb shell id
uid=2000(shell) gid=2000(shell) ... context=u:r:shell:s0
$ adb shell ls /data/data/com.xiaopeng.mycarinfo/
ls: /data/data/com.xiaopeng.mycarinfo/: Permission denied
```

**手机是生产版 ROM，未 root，无法 `adb root`，读不到 App 私有目录，也就装不了 frida-server。** 因此：

- 动态脱壳取 `RpaSigManager` 字节码 —— **不可行**
- Frida 挂钩看运行时 `KI` 与私钥 —— **不可行**
- 静态挖 native 层 —— **已到顶**（§6.19g）

三条路全堵。**在不改变设备前提（不 root）的情况下，自研客户端走蓝牙通道的唯一可行路线是：拿到官方 App 的激活流程，让自研客户端自己完成一次激活，从而由服务端下发属于它的 `KI` 和密钥对。** 这需要先确认激活接口是否接受第三方客户端（需实测，静态查不到）。

#### 6.19i　`KI` 的作用确认：它是握手层的静态共享密钥，31 轮全部验证

§6.18g 只在 2 轮握手上验证了「`dec(KI, payload[:16])` = 4 字节 + 12 字节零」。现在对**全部 31 轮**做了同一测试，结果一致：

```
0xED handshake frames decryptable with KI: 31 / 31
每一轮：pad12zero = True，第 17 字节 = 0xe0（恒定）
```

31 个解出的 4 字节值无任何递增或周期规律（相邻差值在 ±3×10⁹ 间随机跳动），是**每轮新生成的随机数**。

**这确定了 `KI` 的语义**：它不是会话密钥（否则每轮握手都该变），而是**跨会话、跨轮次恒定的长期共享密钥**，用于加解密握手层的随机数交换。这也解释了为什么它既不由握手派生（§6.19h），也不由车端下发（§6.19h）——它是**双方预先共享的**，只能在激活时建立。

**握手的实际形态**（据此可以完整重写）：

```
App → 车:  0xEF 通道, [r1: 4B 随机]                      （明文，发起）
App → 车:  0xEF 通道, [m: 16B]                            （用途未定，非 AES(KI,·)）
App → 车:  0xED 通道, TBox type=0x00, [AES(KI, n‖0¹²) ‖ 0xe0]
                                                          n = 4B 随机
车 → App:  0x318 / 0x225 / 0x55 / 0x5d / 0x70 ...          （msgId 回执）
```

第 3 帧的 17 字节是 `AES-ECB(KI)` 加密的 `n‖0¹²` 再拼一个恒定 `0xe0` 尾字节。**用 `KI` 就能自己造出合法的握手帧**——这一步自研客户端可复现，前提仍是持有 `KI`。

**对第 4 项任务的意义**：既然 `KI` 在 31 轮（跨 65 分钟、多次重连）里恒定，那么「`KI` 跨会话是否稳定」这个问题**大概率答案是不变**——但要确认「跨 App 重启/跨天」而非仅「跨连接」，仍需新抓包。

#### 6.19j　帧编解码已实现并自测通过

`scripts/ble_frame.py` 把 §6.18 的格式固化成了可复用的解析/构造模块，`--selftest` 用实车两帧做往返验证：

```
UNLOCK: cmd=0x01 type=0x01 crc=True tbox_rt=True payload_rt=True construct_rt=True
LOCK:   cmd=0x02 type=0x02 crc=True tbox_rt=True payload_rt=True construct_rt=True
SELFTEST PASS
```

`construct_rt=True` 意味着：**从解析出的字段重新组装，能得到与实车完全一致的字节**。帧格式这一层已经彻底闭环，不再有未知字段。

两个在实现中确认的细节：

- **`tbox_len` 只计 payload，不含 `type` 字节**。132 字节 payload 的帧里 `tbox_len == 132`，不是 133。此前若按「含 type」实现会全部错位。
- **`flag_byte` = `cmd + 0x52`**。解锁 `0x01+0x52=0x53`（'S'）、上锁 `0x02+0x52=0x54`（'T'）。两帧吻合，但样本只有 2 个，**该规律是推测**——其它指令码是否同样成立需更多样本验证。

模块只做字节编解码，签名与密钥不在此层：`construct()` 要求调用方提供 `ki`/`ed`/`sn`。这是刻意的边界——签名需要 P-256 私钥，而私钥与 `KI` 都不在本机（§6.19h）。

#### 6.19k　App 自有日志这条路也堵了（但发现了新的可读面）

**发现**：`/sdcard/Android/data/com.xiaopeng.mycarinfo/files/` **不需要 root 就能读**（`ext_data_rw` 组权限，shell 属于该组）。里面有 `xiaopeng/logs/`，按天分文件：

```
logs_BLE_20261101.xlog   3188938 B   22:35 仍在写    ← 正好覆盖本次抓包时段
logs_core_20261101.xlog    34125 B
logs_20261101.xlog        180732 B
```

还有 10 天的历史 `logs_BLE_*.xlog`（每天 2.4–5.7 MB）。**App 自己记录了完整的 BLE 交互**，如果可读就是金矿。

**但解不开**。这些是 mars xlog 格式，且**整文件加密**（连 header 都是密文）：

```
first16 = 07 9a 00 17 00 b7 c7 00 00 92 59 56 94 f8 a7 69
```

按 mars xlog 的明文字段（`magic=0x07`、`len LE`、`zero`、`seq LE`、`begin_hour`、`end_hour`、`client_version`）逐字段尝试，全部对不上：`begin_hour` 解出 2449473735（对应 2047 年）、`verlen` 解出 27047。**说明新版 mars xlog 用了全文件加密**，需要 App 侧私钥才能解。

而密钥在 `com.tencent.mars.xlog` 的初始化处（`com/xiaopeng/base/log/LogUtils` / `LogHelper`），这些类在加固段里，**拿不到**。

**dex 里的相关线索**（只能确认存在，取不到值）：

- `LOG_KEY`、`BLE_ENCRYPT_KEY`、`TNET_LOG_KEY`、`DOMAIN_NETLOG_KEY`、`IFAA_TRANSPORT_ENCRYPT_KEY`
- `com.xiaopeng.protect.*`（`SafeActivity` 等）—— 除 360 壳外还有第二层保护

**logcat 也没有**：当前缓冲区里 `digitalkey`/`davinci`/`blekey`/`BleCmd`/`RpaSig` 相关 tag 计数为 **0**，App 把这些全部写进了加密 xlog，不走 logcat。

**结论**：不需要 root 的可读面（sdcard）确实存在，但内容加密且密钥在加固层内。这条路与动态脱壳等价，同样被「无 root」挡住。

#### 6.19l　握手往返的完整 msgId 序列（每轮 15 条，31 轮完全一致）

> 已提升到 §6.11a。
#### 6.19m　`ED` 定性结论：随机 nonce，不是计数器也不是密文

汇总 §6.18g 与本节的全部测试，`ED` 的性质可以定了：

| 假设 | 检验 | 结果 |
| --- | --- | --- |
| 计数器 / 时间戳 | 两帧逐字节比对 | **否**。16 个位置**无一相同**，异或后无规律，无单调性 |
| 由帧内静态字段派生 | `SHA-256`/`MD5` 作用于 header、`KI`、`header‖KI` | **否**，零命中 |
| 用 `KI` 加密的密文 | `KI` 作 AES 密钥，ECB/CBC 多种模式 | **否**，解不出结构 |
| 由握手材料派生的密钥加密 | 40 余个 KDF 候选 | **否**，全部落空 |
| **随机 nonce** | 熵 4.00 / 3.88 bits/byte，16 字节全不同，零字节 0 个 | **与观测一致** |

**定论**：`ED` 是**每帧新生成的 16 字节随机数**。它的作用是为签名提供**防重放的唯一性**——128 位随机值不需要任何共享状态就能保证不重复，车端只需验签名有效且该 `ED` 未见过。

**这也解释了为什么解不开它**：它不是密文，没有「明文」可解。之前把它当密文去找密钥，方向本身错了。

**对自研客户端的直接意义**：`ED` 可以自己生成，用 `os.urandom(16)` 即可，**不需要向车端或云端索取**。这把原本以为的「硬缺口」彻底消掉了。

于是自研客户端走蓝牙通道，真正缺的只剩两样：

1. **ECDSA P-256 私钥**（§6.18f，不在 APK 里，推测在 Keystore）
2. **`KI`**（§6.19h，设备侧持有，不可推导，车端不下发）

**第 4 项任务该测什么也随之明确**：`ED` 已无需再测。抓新帧真正要回答的是——
- `flag_byte = cmd + 0x52` 是否对其它指令码普遍成立（现在只有 2 个样本）
- `KI` 跨连接是否稳定（决定要不要每次重新激活）
- 不同指令是否走不同回执 msgId（现在只见过 `0x70`）

### 6.20　第二次实车抓包：5 条新指令，`KI` 与密钥对跨会话确认稳定

> 内容已并入 §6.8a（指令码表）、§6.8b（后备箱方向）、§6.18i（密钥对稳定性）。

### 6.21　`KI` 获取路径全梳理：它存在手机上，加密后落 SharedPreferences

#### 6.21a　先纠正一个方向性判断

此前（§6.19h）判断 `KI` 是「设备侧持有、不可推导、车端不下发」，据此推出「只能让自研客户端自己走激活流程」。**这个结论的方向是错的**——`KI` 不是拿不到，它就**存在这台手机上**，只是被加密后写进了 SharedPreferences。

#### 6.21b　完整调用链（全部有符号实证）

```
MonaBleKeyMgrService.getBleKeyInfo(vin, callback)        ← 取 key 的入口
  └─ getBleKeyInfoReal(vin, callback)                    ← 实际实现
       └─ BleKeyInfo(uidVin=…)                           ← 模型
BleKeySpManager.hasBleKey / updateBleKey                  ← 读写本地
  ├─ "BleKeySpManager updateBleKey: json "
  ├─ "BleKeySpManager updateBleKey:encrypt failed"
  ├─ "BleKeySpManager hasBleKey decrypt success"
  └─ "BleKeySpManager hasBleKey decrypt failed"
```

四类符号：

| 类 | 作用 |
| --- | --- |
| `com.didi.davinci.digitalkey.dkservice.BleKeySpManager` | SharedPreferences 读写 + 加解密 |
| `…dkservice.model.BleKeyInfo(uidVin=…)` | key 的数据模型 |
| `…dkservice.model.BleKeyConfigModel(vin=…)` | 配置模型 |
| `…mona.carserviceimpl.MonaBleKeyMgrService` | 对外服务，`getBleKeyInfo(vin, callback)` |

**`BleKeySpManager` 的两条日志直接说明机制**：`updateBleKey` 时 `json` → `encrypt` → 存盘；`hasBleKey` 时 `decrypt` → 解析。所以磁盘上是一段**加密的 JSON**，明文包含 `KI`。

#### 6.21c　关键推论：不需要激活，只需要解密

既然 `KI` 已经以加密形式存在于本机，那就不必「重新走激活流程拿一份新的」，而是**把已有的解密出来**。这比之前的方案简单得多，也不涉及服务端是否接受第三方客户端这个未知数。

问题只剩：**加密用的密钥是什么、在哪**。

已确认排除的：
- 不是 `KI` 自己加密自己（会循环）
- 不是公钥（公钥是公开的，用它加密等于没加密）

待验证的候选（按可能性排序）：
1. **Android Keystore 里的 AES 密钥**——最符合 Android 常规做法，且 `BleKeySpManager` 在加固段里、调 Keystore 是标准姿势
2. 硬编码在 SDK 里的固定密钥——若如此则可直接从 APK 提取
3. 由设备指纹（ANDROID_ID / 序列号）派生——可复现

#### 6.21d　这条路为什么比激活路线好

| | 解密现有 key | 重新激活 |
| --- | --- | --- |
| 依赖服务端配合 | 否 | 是（未知） |
| 会不会影响官方 App | 否（只读） | 可能顶掉现有钥匙 |
| 未知数 | 加密密钥位置 | 服务端是否接受新公钥 |

**且 §6.20c 已证明 `KI` 跨会话稳定**，所以解密一次就能长期使用。

#### 6.21e　唯一障碍仍是 root

`/data/data/com.xiaopeng.mycarinfo/shared_prefs/` 不可读（§6.19h 实测 `Permission denied`），而 `BleKeySpManager` 的加密密钥若在 Keystore 里，即便拿到 SP 文件也无法解密——**除非能在 App 进程内执行代码**。

因此 `KI` 获取的可行路线收敛为三条：

1. **root 后直接读**：读 SP 文件 + Keystore（root 下可 dump）。最直接，但需要解锁 Bootloader 刷机，会清数据。
2. **在 App 进程内 hook**：Frida 挂 `BleKeySpManager.hasBleKey` 的返回值，直接拿解密后的 JSON。需要 frida-server，同样要 root。
3. **静态解密**：若加密密钥是硬编码的（候选 2），则 SP 文件可以从备份或 `adb backup` 取到后离线解密。**这是唯一不需要 root 的可能路径**，值得优先验证。

#### 6.21f　下一步该做什么

优先验证候选 2（硬编码密钥）：反编译 `BleKeySpManager` 找加密调用。但该类在加固段里，静态拿不到字节码——**除非能从 `libbledata.so` 或其他 so 里找到对应的 JNI 实现**。

`BleKeySpManager` 是 Kotlin 类（`.kt` 后缀在字符串池里），大概率纯 Java/Kotlin 实现，走 `javax.crypto`，密钥可能来自常量或 `SecureRandom` 种子。**如果是后者，则无解**（每次随机生成、存在 Keystore）。

#### 6.21g　静态路线走到终点：密钥由服务端下发，静态解密不可能

按用户约束（无 root，只走路线 3「静态解密」），逐条验证后**结论是否定的**。证据链如下。

**① `adb backup` 不可用**：`AndroidManifest.xml` 里 `android:allowBackup="false"`（`aapt2 dump xmltree` 实证）。这条路关闭。

**② `run-as` 不可用**：`run-as: package not debuggable: com.xiaopeng.mycarinfo`。这条路关闭。

**③ 加密方案是 AndroidX Security Crypto**：dex 里存在

```
SHARED_PREFERENCES_ENCRYPTION_KEY_NAMESPACE_SUFFIX
SHARED_PREFERENCES_IV_SUFFIX
SHARED_PREFERENCES_DATA_IDENTIFIER_SUFFIX
SHARED_PREFERENCES_STORE_VERSION_SUFFIX
SHARED_PREF_DEVICE_ID_KEY
```

这组后缀是 **`EncryptedSharedPreferences`** 的典型标志。该库把主密钥存在 **Android Keystore** 里，用 Keystore 的 AES 密钥加密 SP 内容。

**④ 更关键：主密钥是服务端下发的，不是硬编码**

```
com.didi.davinci.digitalkey.dkservice.MonaFactoryManager
  ├─ createMasterKey
  ├─ getMasterKey        ($$inlined$fromJson$1)
  ├─ saveMasterKey
  └─ removeMasterKey
com.didi.davinci.digitalkey.mona.carserviceimpl.MonaBleKeyMgrService
  └─ updateMasterKeyActiveStatus  ($$inlined$serverData$1)
```

注意两处 `$$inlined$serverData$1` —— 这是 Kotlin 协程里**「数据来自服务端」的内联展开标记**。`createMasterKey` 和 `updateMasterKeyActiveStatus` 都带这个后缀，说明**主密钥从服务端拉取**。

**⑤ native 层也不帮忙**：`BleKeySpManager`、`BleKeyInfo`、`BleKeyConfig`、`updateBleKey`、`hasBleKey` 在 `libbledata.so` / `libkmslib.so` / `libkmssdk.so` 里**全部零命中**。它是纯 Kotlin 实现，不走 JNI。

#### 6.21h　结论：路线 3 不可行，三条路全断

| 路线 | 结果 | 依据 |
| --- | --- | --- |
| 1. root 读 SP + Keystore | 需刷机 | 用户明确不走 |
| 2. Frida 挂钩 | 需 root | 同 1 |
| 3. 静态解密 | **不可行** | 见下 |

路线 3 不可行的原因有三层，任一层单独都足以阻断：

1. **拿不到密文**：`allowBackup=false`、不可 `run-as`、`/data/data` 无权限。
2. **拿到了也解不开**：密钥在 Keystore 里，Keystore 密钥**不可导出**，只能在 App 进程内使用。
3. **密钥还是服务端下发的**：即便绕过 Keystore，`MasterKey` 也要向服务端请求，而该请求需要合法的 App 身份。

**所以：在不 root 的前提下，`KI` 拿不到。** 这不是分析方法不够深的问题，是 Android 安全模型的设计目的——凭据存在受保护存储里，密钥绑定硬件，跨进程/跨设备都取不出来。

#### 6.21i　剩下的选项（都需要用户重新权衡）

1. **接受 root**：解锁 Bootloader 刷机，会清空数据。root 后 Frida 挂 `BleKeySpManager.hasBleKey` 一行代码即可拿到明文。
2. **走激活流程拿自己的 key**：不需要 root，但需要服务端接受一个新客户端的公钥——未知，且可能顶掉现有数字钥匙。
3. **蓝牙通道只做只读**：用官方 App 发指令、我们只监听解析。已经能做（抓包链路已通），但不能自主发指令。
4. **放弃蓝牙，只走 MQTT**：MQTT 车控已闭环。代价是蓝牙独有能力（后备箱、数字钥匙相关）用不了——但 §6.8a 实测显示闪灯、车窗**也走蓝牙**，所以这个代价比预想大。

**我的建议**：先确认第 2 条（激活流程）服务端是否接受，因为它不需要 root 且不改变设备状态。这需要一次实测——让自研客户端调用激活接口，看返回。这是唯一还有希望的无 root 路线。

#### 6.22　模拟器激活路线分析：`KI` 是每账号每车独立生成，不能复现主账号的钥匙

用户提出「在模拟器里用子账号登录并激活数字钥匙，从而拿到 `KI`」。用户已确认子账号可随意顶号，所以「顶掉官方 App」不再是阻碍。本节只做静态分析，不操作模拟器。

#### 6.22a　好消息：davinci 数字钥匙不依赖 TEE

先排除了一个本来最担心的障碍。`com.xiaopeng.xtee` 确实存在且强依赖 TEE：

```
com.xiaopeng.xtee.security.TeeSecurityImpl
com.xiaopeng.xtee.token.TeeTokenImpl
com.xiaopeng.xtee.utils.KeyStoreUtils
```

但 `com.didi.davinci.digitalkey.*` **对 xtee 零引用**。搜索 `davinci.*xtee` 与 `xtee.*davinci` 的组合，唯一命中是 `SteeringWheelModel`（方向盘状态模型，与安全无关）。**所以模拟器没有 TEE 不构成阻断**。

#### 6.22b　决定性证据：`KI` 按 `(uid, vin)` 独立生成

`BleKeyInfo` 的字段集合（字符串池实证）：

```
uidVin  vin  key  keyId  keyVersion  btMac  salt  seed  keyStatus  activeStatus
```

**`salt` 与 `seed` 与 `key` 在同一个模型里，这一条就定了性**：如果 `KI` 是从 VIN 派生的固定值，根本不需要 `salt`；需要 `salt` 说明**每次激活都用不同的盐派生一份独立密钥**。

补充验证：用 VIN（`L1NSPGH91NA142515`）作输入，试 `SHA-256[:16]`、`SHA-256[-16:]`、`MD5`、`SHA-1` 截断，**全部零命中**。`KI` 不是 VIN 的哈希。

`uidVin` 这个字段名本身也说明作用域是「用户 + 车辆」的二元组，不是「车辆」。

#### 6.22c　结论：模拟器能拿到「另一把钥匙」，不是主账号那把

| 问题 | 答案 | 依据 |
| --- | --- | --- |
| 模拟器能否激活数字钥匙？ | **取决于车端是否接受**，需实测 | `MSG_BIND_BLUETOOTH_KEY_REQUEST/RESULT_REPLY` 需车机回应 |
| 拿到的 `KI` 与主账号相同吗？ | **不同** | `salt`/`seed` 存在 + `uidVin` 作用域 |
| 模拟器激活会顶掉主账号钥匙吗？ | **不会** | key 按 uid 隔离 |

**所以模拟器路线能产出一份可用的 `KI` 和密钥对，但那属于子账号。** 用它发车控指令，车端会认——因为它验证的是「这个 uid 的钥匙是否被授权」，不是「是不是主账号」。

#### 6.22d　这条路真正的价值

如果子账号也被授权使用这辆车（能激活数字钥匙就说明是），那么：

1. **自研客户端可以用子账号的 `KI` + 密钥对发指令**，不需要主账号的。
2. 主账号的钥匙完全不受影响，手机上的官方 App 照常用。
3. 子账号被顶号无所谓（用户已确认）。

**这实际上是比「解密主账号 `KI`」更好的方案**——不需要 root，不需要破解 Keystore，也不影响主账号。

#### 6.22e　待实测的未知数

1. **模拟器能否完成激活**：需要车机响应 `MSG_BIND_BLUETOOTH_KEY_REQUEST`。模拟器没有真实蓝牙，这一步可能卡住。**这是最大风险点。**
2. **车端是否接受模拟器的蓝牙 MAC**：`BlackMacAddressUtil` 存在说明有 MAC 黑名单机制，模拟器 MAC（`02:00:00:00:00:00`）可能被拒。
3. **激活是否要求手机在车旁**：若要求近距离蓝牙，模拟器无论如何做不到。

如果第 1 或 3 条成立，模拟器路线就走不通，只能回到「主账号 + root」或「MQTT」。

### 6.23　模拟器路线实测：数字钥匙已启用，xtee 密钥材料全部提取成功

按用户授权（子账号可随意顶号），在 `emulator-5554` 上完成验证。**结论远超预期**。

#### 6.23a　模拟器可以 root，这是整条路成立的前提

```
$ adb -s emulator-5554 root
restarting adbd as root
$ adb -s emulator-5554 shell id
uid=0(root) ...
```

真机是生产版 ROM 无法 root，**但模拟器是 userdebug，`adb root` 直接可用**。这一条把此前「三条路全断」的判断全部推翻。

#### 6.23b　子账号能看到数字钥匙，且状态是「已启用」

模拟器里用子账号登录后进入数字钥匙页面，截图显示：

```
收到的车辆授权
沪AAV2168
罗辑  186****45  对方帐号
蓝牙钥匙   ● 已启用
被授权人将获得以下权限：车辆控制 / 车辆空调 / 数字车钥匙 / 发送地址
```

**关键**：子账号的数字钥匙**已经是「已启用」状态**，不需要重新激活。这意味着 `KI` 和密钥对**已经存在于这台模拟器上**。

#### 6.23c　数字钥匙数据存放在 MMKV，不在 SharedPreferences

`/data/data/com.xiaopeng.mycarinfo/files/mmkv/`：

```
ble_cache_data          8192 B   00:56 仍在写   ← 数字钥匙数据
ble_cache_data.crc      4096 B
XP_KEY_LIST_INSTANCE    8192 B                  ← 钥匙列表
XP_MAC_INSTANCE         4096 B
XP_TOKEN_INSTANCE      65536 B
mmkv.default          262144 B                  ← 明文，业务数据
tee                     8192 B                  ← xtee 密钥库
```

`ble_cache_data` 是加密的（按 MMKV 格式解析在 `vallen` 处失败），有独立 cryptKey。

#### 6.23d　xtee 密钥链完整提取成功（重大突破）

`tee` MMKV 里是明文键值对，内容如下：

```
XTeeSecurityIv        FuKKH+jcVVV/sMJPBtV0Tw==        (16 B IV)
XTeeEncryptAesKey     bOaWT8c6AIZ3...                 (256 B，RSA 密文)
IndivKeySet           QwZZySYxgFre11c1FPBcZw==
XmartV1LocalKey0..9   (各 44 B base64)
accessToken           Aa/waPK6P+PLv/ys2GCX...          (300 B 密文)
refreshToken          Aa/waPK6P+PLv/ys2GCX...
```

**解密链路（三步全部成功）**：

**① Keystore 里找到 `XTeeSecurityAlias`**

`/data/misc/keystore/persistent.sqlite` 的 `keyentry` 表共 22 条，其中：

```
XTeeSecurityAlias    namespace=10232   ← 正是 App 的 uid
```

**② 从 `blobentry` 提取 RSA-2048 私钥**

`subcomponent_type=0` 的 blob（1353 B）前 5 字节是头 `00 a7 04 00`，之后是完整 PKCS#8 DER：

```python
raw = blobentry.blob
der = raw[raw.find(b'\x30\x82'):]
der = der[:4+int.from_bytes(der[2:4],'big')]
key = serialization.load_der_private_key(der, password=None)

### 6.25　Mac 直连车端 BLE 成功：GATT 特征绑定彻底闭合，握手可被车端响应

2026-11-02 晚，在用户授权下从 Mac（CoreBluetooth）直连车端数字钥匙模块，完成服务发现、订阅推送、写入握手帧，并收到车端回应。**这是本项目第一次由非官方 App 的客户端与车端完成协议交互。**

#### 6.25a　认错了模块：`00603785B9D0` 不是数字钥匙

此前 §6.19 把 `XPED-00603785B9D0` 判为数字钥匙模块，理由是它连不上（「只接受已绑定设备」）。**这个判断是错的。**

实测（4 次连接，3 次完全一致）：

| 设备 | 连接结果 | 服务 |
| --- | --- | --- |
| `XPED-00603785B9D0` | **始终超时** | — |
| `XPED-DC0D30B094C4` | **稳定连上** | `180A` + `0000ED28-ABAB-406D-832D-7AD799B479F7` |

数字钥匙模块是 **`XPED-DC0D30B094C4`**。`00603785B9D0` 是车上另一个 BLE 模块，与数字钥匙无关（可能是胎压/OBU 一类），其连接超时与绑定无关。

用户已确认**只有一台小鹏车**，所以这两个 XPED 设备是同一台车上的两个模块。

#### 6.25b　§6.15 缺口 3 闭合：写特征与推送特征确定

`0000ED28-ABAB-406D-832D-7AD799B479F7` 服务下：

```
chr 0000ED28-ABAB-9C8C-2801-B1A015E46D6C  [WRITE|writeNoRsp]   ← 写指令
chr 0000ED28-ABAB-9C8C-2802-D3DF573FF530  [INDICATE]           ← 收推送
（另有 2A23/2A24/2A25/2A26/2A27/2A28/2A29/2A2A/2A50 九个标准 Device Information 特征，只读）
```

**这直接推翻了 §6.15/§6.9 的推断**：那里说 `…2801-…6D6C` 是主服务、`…6D6E` 是写特征。实际 `…6D6C` **就是写特征本身**，`…6D6E` 根本不在这个服务里。

#### 6.25c　握手是请求-响应式，不是「App 连发三帧」

重新解码 `btsnoop_hci_261101_224622.log` 的时序，真实的握手是交替的：

```
App  → WRITE  ef 01 04 8fe82373                              7B  channel 0xEF
车   → IND   f7bd2e19                                         4B  ← 车端挑战
App  → WRITE  ef 01 10 16bb123ae2fa52cc7ec3ca0016039458      19B  channel 0xEF
车   → IND   08 00 01 44463030482e32                         10B  msgId 0x0800, 认证结果 0x01
App  → WRITE  ed 11 18 0011aaae476c00307e6979a2924255...     27B  channel 0xED
车   → IND   02 81 ... （150B 状态全量）
```

> **2026-11-04 补测：上面这个「`ed1118` → `0281` 150B 状态」的配对是对的，此前一度被推翻，现恢复。**
>
> 中间几轮曾记「`ed1118` 无响应」，那是把观察对象搞错了：那些观测来自**我方在 Mac 上
> 自己发帧**，车端不回是因为帧无效（子账号 KI / 旧密文 / 会话不匹配），
> 不是这类帧不产生响应。用手机侧 btsnoop 按 `flags & 1` 区分方向后，
> 两轮完整握手都稳定出现 `ed1118` → `0281` 150B 的配对：
>
> ```
> 手机 -> WR_NR  ef0104 6f70b55a
> 车端 -> CONF   d79224c8
> 手机 -> WR_NR  ef0110 63566990168dda77b77ec766cefb9555
> 车端 -> CONF   0800 01 44463030482e32
> 手机 -> WR_NR  ed1118 0011 efa74d70 00 ef4681dd…6b e0
> 车端 -> CONF   0281 0000…（150B）
> ```
>
> 顺带首次拿到 `car_n`，`build_auth1` 用它逐字节验证通过（见 §6.25d 补记）。

**§6.17c 记的「三帧下行」漏掉了中间的两次车端回应**，把交替序列误读成单向连发。长度也对不上：那里记 4/16/17，实为 7/19/27（后者是含分片头的完整帧长度）。

#### 6.25d　重放实测：车端响应了，但认证被拒

把三帧按原顺序写入 `…6D6C`，订阅 `…573FF530`，得到：

```
-> ef01048fe82373
<- d5f60359                      ← 车端回了新的 4B 挑战（与抓包的 f7bd2e19 不同）
-> ef011016bb123ae2...（重放的旧值）
<- 08000e00000000000000          ← msgId 0x0800，结果字节 0x0e = 认证失败
[*] disconnected
```

**三条确定结论**：

1. **车端接受了 GATT 连接与写入**，不需要预先绑定，不存在连接层白名单。
2. **第 1 帧的回应每次不同**（`d5f60359` vs 抓包的 `f7bd2e19`），确认是**挑战-响应**机制，4 字节是车端现生成的随机数。
3. **`0x0800` 的结果字节是认证状态**：`0x01` = 成功（抓包），`0x0e` = 失败（重放）。这修正了 §6.17d 把 `0x0800` 首字节仅当作「标志位」的理解——它就是认证结果码。

#### 6.25e　第 2 帧的 16 字节是 KDF 输出，尚未解出

第 2 帧 `16bb123ae2fa52cc7ec3ca0016039458` 必然由 `KI` 与双方 nonce 算出。用真实配对样本（`app_n=8fe82373`、`car_n=f7bd2e19`、`target=16bb...`）穷举了：

- `ECB/CBC` × `{app‖car, car‖app, 各种补零/重复}`
- `CBC` 以 `app_n`/`car_n` 补零作 IV
- `HMAC-SHA256(KI, app‖car)[:16]`
- `KI` 与 nonce 异或后再加密

**全部不命中。** 另外 `ECB-dec(target)` 也不含任何可识别的 nonce，说明不是简单的一次 AES。

候选方向：HKDF（§6.12 曾推断握手与 HKDF 有关）、多轮迭代、或 16 字节本身是加密后的密钥材料而非派生结果。

#### 6.25f　现在的处境

| 能力 | 状态 |
| --- | --- |
| Mac 连接车端数字钥匙模块 | **可以**（不需绑定） |
| 服务/特征发现、订阅 indicate | **可以** |
| 向车端写数据并收到回应 | **可以** |
| 完成握手（通过认证） | **卡在 KDF** |
| 发送车控指令 | 需要先过握手 |

**唯一剩余障碍是第 2 帧的派生算法。** 这不是密码学上的不可能，而是一个待解的 KDF——输入已知（`KI`、两个 nonce），输出已知，只需找到函数。而且现在**可以主动向车端发起任意多次握手**，每次都会得到一组新的 `(car_n)` 样本，足以做差分分析。

### 6.26　第 2 帧（Auth1）的构造链已在 native 层完整解出

2026-11-02 晚，反汇编 `libbledata.so`（5.23.6），把握手第 2 帧的生成路径完整还原。**§6.25e 里「KDF 未解出」的说法需要修正：那不是 KDF，是 TLV + XOR。**

#### 6.26a　调用链

```
Java (hkdfSha256V2 / createBleKeyV3Auth1RequestWithInput)
  └─ createBleKeyV3Auth1RequestWithInput(BleKeyV3Auth1Params*, u8* out, size_t* outLen)   @0x8f584
       ├─ getAuth1FactorTlvData(u32 tagVal, u8* ptr, size_t len, TLV** out)                @0x8ee34
       ├─ getTlvTotalSize(tlv)                                                             @0x9fa4c
       ├─ getXorResult(u32* outLen, u8* data, size_t dataLen, u8* key, size_t keyLen)       @0xa02b4
       ├─ calc_crc16_ccitt(u8* data, u32 len)                                              @0x?
       └─ host_int16_to_little_endian(crc)
```

#### 6.26b　`getAuth1FactorTlvData` 的结构

```c
TLV1 = encodeTlvMessage(tag=0x0001, len=4,  value = LE32(params->field0))
TLV2 = encodeTlvMessage(tag=0x0002, len=params->len, value = params->ptr)
inner  = TLV1 || TLV2
out    = encodeTlvMessage(tag=0x7F52, len=len(inner), value = inner)
```

`encodeTlvMessage` 的 tag 与 length 都是 **2 字节小端**。用抓包样本验证，`app_n=8fe82373`、`car_n=f7bd2e19` 时构造出的 TLV 是：

```
52 7f 10 00                                    外层 tag=0x7F52, len=16
  01 00 04 00  8f e8 23 73                     内层 TLV1, tag=1, len=4, app_n (LE u32)
  02 00 04 00  f7 bd 2e 19                     内层 TLV2, tag=2, len=4, car_n
```

结构与实际长度（16 字节）完全吻合。

#### 6.26c　`getXorResult` 是纯 XOR

反汇编确认它只做 `out[i] = data[i] ^ key[i]`，长度取 `min(dataLen, keyLen)`，并有 SIMD（`eor v0.16b`）与标量（`eor w12`）两条路径。没有 KDF、没有加密。

#### 6.26d　因此第 2 帧 = XOR(TLV, sessionKey)

```
frame2 = XOR(TLV(app_n, car_n)[:16], sessionKey)[:16]
```

反推 sessionKey（`frame2 XOR TLV[:16]`）得到三组样本各自的 key：

| app_n | car_n | 反推出的 sessionKey |
| --- | --- | --- |
| `8fe82373` | `f7bd2e19` | `44c4023ae3fa56ccf12be97314039058` |
| `5167cd7a` | `b3861a1d` | `d0af25273cd0d4fb41c433111adff0ef` |
| `ea2cb99f` | `a7c4dffd` | `dc1f1053d89a5f927f730ff6c6161279` |

**三组各不相同**，所以 sessionKey 是每会话派生的，不是 `KI` 本身。

#### 6.26e　sessionKey 的派生入口是 `generateSessionKey`（JNI）

`SDKBleKeyV3::getSessionKey(u8* out, size_t outLen, u32 a, u32 b, u8* key, size_t keyLen)` @0xa0524 是一个薄封装：

```c
u8 buf[8];
memcpy(buf, &a, 4); memcpy(buf+4, &b, 4);        // 两个 u32 小端拼成 8 字节
hkdf_sha256_jni(pid /*info 字符串*/, key, keyLen, salt, saltLen, buf, 8, out, outLen)
```

注意它调用的是 **JNI 版** `hkdf_sha256_jni`（`_Z15hkdf_sha256_jniPKciPKhmS2_mS2_m`），第一个参数是 `const char*`，即 HKDF 的 **info 字符串**。

`SDKBleKeyV3::generateSessionKey` @0xa2330 是它的上层，从 `BleKeyV3Auth1Params` 取 ptr/len 两组字段，再调用 `getSessionKey`。

#### 6.26f　剩下的唯一未知量

`hkdf_sha256_jni` 的 `info` 字符串与 `salt`，以及 `generateSessionKey` 传给 `getSessionKey` 的两个 `u32` 取哪个字段——这些都在 **Java 层构造**，而 Java 层在 360 加固段（`dexdata0`）里，静态取不到字节码。

已试过但**全部不命中**的猜测（用三组样本交叉验证，任一组不符即淘汰）：

- `HKDF-SHA256(KI, salt={none,KI,app‖car,car‖app}, info={none,0x50090 常量,app‖car,car‖app})`，输出长度 16/32
- `HMAC-MD5(KI, app‖car)`、`HMAC-SHA256(KI, app‖car)[:16]`
- `MD5(KI‖app‖car)`、`MD5(app‖car‖KI)`
- `createAuthKey` 那条 HMAC-MD5 路径（它属于 RKE/应急钥匙，不是握手）

#### 6.26g　结论

帧结构、TLV 编码、XOR、CRC16 全部解出，`construct()` 只差一个 sessionKey 输入。**这是「参数未知」而非「算法未知」**——算法已经确定是 HKDF-SHA256，缺的只是 `info`/`salt` 两个实参。

拿到它们只有两条路：动态 hook `hkdfSha256V2`（需可 root 设备），或从加固 dex 脱壳。

#### 6.26h　补充：Auth0 走 AES-256-CBC，Auth1 走 XOR，两者不同

继续反汇编 `createBleKeyV3Auth0RequestWithInput` @0x8f344（576B），发现 Auth0 与 Auth1 的密码学路径**完全不同**：

```
Auth0（第 1 帧）:
  getAuth0FactorTlvData(tag=0xA0, ...)
  encodeTlvMessage(0xA0, ...)
  aes_256_cbc_encrypt(plain, len, key, iv=rodata@0x50090, &outLen)   ← AES-256-CBC
  calc_crc16_ccitt → host_int16_to_little_endian → 尾部

Auth1（第 2 帧）:
  getAuth1FactorTlvData(...)
  getXorResult(&outLen, tlv, tlvLen, key, keyLen)                    ← 纯 XOR
  calc_crc16_ccitt → host_int16_to_little_endian → 尾部
```

`0x50090` 的 16 字节 `ccf3e8342bd6071fde7270dfa0876bb8` 在 Auth0 里作为 **AES IV** 使用（`ldr q0, [x8]` → `stur q0, [x29, #-0x20]` → 作为 `x3` 实参）。这解释了它的存在，但它不是 HKDF 的 info。

#### 6.26i　`BleKeyV3Auth1Params` 的 key 字段是 `std::vector`

`createBleKeyV3Auth1RequestWithInput` 里：

```
ldur x3, [x21, #0xd]      key.begin()
ldursw x4, [x21, #0x15]   key.end() 低 32 位（编译器算 vector size 的方式）
```

偏移 `0xd` 与 `0x15` 相差 8，符合 `std::vector<uint8_t>`（24 字节 begin/end/cap）的布局，不是「指针+长度」对。所以 key 是一个 vector，由 Java 层填好后传入。

#### 6.26j　已排除的推导路径（三样本交叉验证，全部不命中）

| 尝试 | 结果 |
| --- | --- |
| `info` = so 内全部 11284 个字符串 × {IKM: KI/app‖car/car‖app} × {salt: none/KI/empty} × {L: 16/32} | 0 命中 |
| `info` = 270 个常见命名（session/auth/key/ble/v3/xpbkth… 加 1/2/_v3 后缀），验证方式为 AES 解密后检查 TLV 结构 | 0 命中 |
| `HKDF(KI, salt={none,KI,app‖car,car‖app}, info={none,const,app‖car,car‖app}, L=16/32)` | 0 命中 |
| `HMAC-MD5/SHA256(KI, app‖car)`、`MD5(KI‖app‖car)` | 0 命中 |
| `createAuthKey` 的 HMAC-MD5 路径 | 属 RKE/应急钥匙，非握手 |
| TLV 用 1 字节 tag/len、2 字节 tag/len、大端/小端、内外层 tag 换位、nonce 换序 | 推出的 key 均不恒定 |

#### 6.26k　结论：静态边界

**算法层面已完全清楚**：Auth0 = AES-256-CBC + CRC16，Auth1 = XOR + CRC16，TLV 编码规则已知，`.rodata` 常量已知。

**缺的是 Java 层传入的两个实参**：Auth0 的 AES key、Auth1 的 XOR key（即 session key 的派生结果）。两者都由 `hkdfSha256V2` 在 Java 侧算好后传入，而 Java 侧在 360 加固段（`dexdata0`）。

**盲猜 `info`/`salt` 已穷尽合理空间**（11284 个 so 内字符串 + 270 个常见命名 + 20 余种组合），全部不命中。继续猜下去命中率不会提高。

拿到它们只剩两条路：**动态 hook `hkdfSha256V2`**（需可 root 的设备），或**从 `dexdata0` 脱壳**（同样需要动态环境）。

### 6.27　模拟器内虚拟车端跑通：假车方案成立

2026-11-02 晚，用 Android Emulator 自带的虚拟蓝牙栈，在模拟器内部搭出一台"假车"，并让 guest 完整识别、连接、写入。**这解决了 §6.26k 里"拿不到 Java 层 key 参数"的死结——不需要 root 真机，也不需要真车。**

#### 6.27a　模拟器有虚拟 BLE 外设能力

`$ANDROID_SDK/emulator/lib/` 下有两个此前未注意的 proto：

- `emulated_bluetooth.proto` —— `EmulatedBluetoothService.registerGattDevice(GattDevice)`
- `emulated_bluetooth_device.proto` —— `GattDeviceService`（读/写/订阅回调）、`GattProfile`、`Advertisement`

模拟器启动时带 `-grpc <port>`，就会把 `netsimd` 的 gRPC 暴露出来。调用 `registerGattDevice` 后，**模拟器会拉起 `nimble_bridge` 进程，把注册的 profile 呈现为真实的 BLE 外设**。

这推翻了此前 §「模拟器蓝牙透传限制」的结论：**宿主机蓝牙适配器确实无法透传，但根本不需要透传**——虚拟外设走的是 netsim 内部 HCI，与宿主机蓝牙无关。

#### 6.27b　假车已实测可被发现、可连接、可写入

`scripts/fakecar/fake_car.py` 实现 `GattDeviceService`，冒充 `XPED-DC0D30B094C4`，GATT 树与真车一致（§6.25b）：

```
svc 0000ED28-ABAB-406D-832D-7AD799B479F7
  chr …2801-B1A015E46D6C  [WRITE|writeNoRsp]
  chr …2802-D3DF573FF530  [INDICATE]
```

注册返回 `callback id 58904`，`nimble_bridge` 随即拉起（`--with_device_proto` 指向我们生成描述文件）。

guest 侧用自写探针（`scripts/fakecar/probe/`）验证，三个阶段全部通过：

| 阶段 | 结果 |
| --- | --- |
| 广播发现 | `DEV 03:00:00:00:00:00 name=XPED-DC0D30B094C4 rssi=20` |
| GATT 连接 | `[conn] 55:b3:fa:0d:99:4b -> CONNECTION_STATE_CONNECTED` |
| 写入握手帧 | `<- WRITE #1 (7B) ef01048fe82373` |
| 车端回推 | `-> INDICATE (4B) d5f60359` |

**连接、服务发现、写特征、indicate 订阅全部工作**，且时序与真车一致（§6.25c）。

#### 6.27c　Frida 可注入，但必须用 spawn 模式

App 主进程加载了 `libnesec.so`（网易易盾），`attach` 到运行中进程会超时。改用 `spawn` 在壳初始化前注入则成功：

```
spawned 6795
[*] waiting for libbledata.so
resumed
```

`frida-server` 以 root 部署到 `/data/local/tmp/`，通过 `adb forward tcp:27042` 接入。

`scripts/fakecar/hook_hkdf.js` 挂钩 `hkdf_sha256_jni`（`_Z15hkdf_sha256_jniPKciPKhmS2_mS2_m`），打印 `info`/`ikm`/`salt` 三个参数。**Frida 17 的模块查找 API 与旧版不同**，脚本里做了兼容处理（`Module.findByName` / `Process.findModuleByName` / 遍历 `Process.enumerateModules()` 三路兜底）。

#### 6.27d　尚未完成的一步

`libbledata.so` 在 App **未登录**时不加载（四个进程的 `/proc/<pid>/maps` 里都没有它），因此 hook 仍停在"等待库加载"。

App 当前未登录（`xp_shared_preferences.xml` 无 uid/vin/token）。**登录并进入数字钥匙界面后，`libbledata.so` 才会加载，握手才会触发，hook 才能拿到参数。**

这一步需要用户在模拟器里登录子账号。

#### 6.27e　与真机路线的关系

| | 真机 | 模拟器假车 |
| --- | --- | --- |
| 需要 root | 是 | 否（模拟器天生可 root） |
| 需要真车在场 | 是 | **否** |
| 能拿到 hkdf 参数 | 能 | **能** |
| 能验证车端接受帧 | 能 | 否（假车不校验） |

两者互补：**假车负责拿参数，真车负责验真**。而验证真车这一步，Mac 侧已经能直连车端数字钥匙模块（§6.25）。

#### 6.27f　版本错配：模拟器上装的不是 5.23.6

实测发现一处此前未被察觉的前提错误：

| 位置 | 实际版本 | 有 `libbledata.so` |
| --- | --- | --- |
| 模拟器 `xp19` 原装 | **4.2.0**（versionCode 8916，120 MB） | **无** |
| `work/apk/XP_MobileAPP_Android_gw.apk` | 5.19.0（278 MB） | 有 |
| `work/apk/v5236/base.apk` | 5.23.6（303 MB） | 有 |

**此前 `hook_hkdf.js` 一直等不到 `libbledata.so`，根因不是"未登录"，而是模拟器上那个 4.2.0 根本没有这个库。** 4.2.0 的 63 个 so 里 `SDKBleKeyV3`、`hkdf_sha256` 全部不存在。

5.23.6 的 `libbledata.so`（1.18 MB）符号完整，§6.26 的 native 结论对它仍然成立：

```
_Z15hkdf_sha256_jniPKciPKhmS2_mS2_m
_ZN11SDKBleKeyV313getSessionKeyEPhmjjPKhmS2_m
_ZN11SDKBleKeyV312getXorResultEPjPhmS1_m
_ZN11SDKBleKeyV313parseAuth0MsgE…
```

#### 6.27g　5.23.6 在 Android 17 上崩溃（未解决）

把 5.23.6 覆盖安装到模拟器后（`install -r -d` 成功，登录数据保留），App 启动即崩：

```
Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x3dc
```

tombstone 显示崩在 ART 内部，不是 App 自身代码：

```
#00 libart.so  art::CodeInfo::DecodeGcMasksOnly(OatQuickMethodHeader const*)
#01 libart.so  art::ReferenceMapVisitor::VisitFrame()
#04 libart.so  art::gc::collector::MarkCompact::CheckpointMarkThreadRoots::Run()
```

**这是 Android 17（SDK 37）的 ART 在解析加固壳改造过的 oat 代码时解析 GC 栈映射表出错**，GC 期间触发。4.2.0 在同一环境正常运行，说明是版本组合问题。

已试过且无效：`dalvik.vm.usejit=false` + `dex2oat-filter=interpret-only`（仍崩）。

可行的下一步（未执行）：

1. **换 Android 14/15 镜像**——但 Google 当前源里 `system-images;android-34`、`android-35` 的 arm64 版本均已下架，只剩 36+，需另找镜像源
2. **退回 4.2.0 做假车验证**——4.2.0 能跑，但它没有 `libbledata.so`，握手密码学在别处（未定位）
3. **用 5.19.0**（`work/apk/` 里那个 278 MB）——它同样带 `libbledata.so`，且比 5.23.6 老，与 Android 17 的兼容性可能更好

第 3 项成本最低，值得先试。

#### 6.27h　假车方案本身已验证成立（与版本问题无关）

不管装哪个版本，`registerGattDevice` 这条路都已经实测打通，结论不依赖 App 版本：

- 模拟器启动加 `-grpc 8554` → netsimd 暴露 gRPC
- `fake_car.py` 注册后，`nimble_bridge` 拉起，guest 侧能扫到 `XPED-DC0D30B094C4`
- 探针完成连接 / 服务发现 / 写特征 / indicate 全链路，帧字节与真车一致

### 6.29　握手第 2 帧的明文结构已完全解出（5.23.6 反汇编）

在 §6.26h 的基础上，用 5.23.6 的 `libbledata.so` 把 `createBleKeyV3Auth1RequestWithInput` 整条链路读通，第 2 帧的构造过程不再有猜测成分。

#### 6.29a　调用链

```
createBleKeyV3Auth1RequestWithInput(0x8f584)
  ├─ getAuth1FactorTlvData(0x8ee34)          → 生成 16 字节 TLV 明文
  ├─ getXorResult(0xa02b4)                   → 明文与 sessionKey 逐字节 XOR
  ├─ host_int16_to_little_endian(0x114070)   → CRC16 转小端
  └─ 帧头：byte0=0x02, byte1=len，末尾追加 2 字节 CRC16
```

#### 6.29b　明文的确切布局

`getAuth1FactorTlvData(u32 v, u8* data, size_t dataLen, size_t* outLen)` 的实际行为（逐条指令核对）：

```
v_le  = host_int32_to_little_endian(v)        // 0x114060
TLV_A = encodeTlvMessage(tag=0x0001, len=4, value=v_le)
TLV_B = encodeTlvMessage(tag=0x0002, len=dataLen, value=data)
inner = TLV_A || TLV_B                        // 12 字节
outer = encodeTlvMessage(tag=0x7F52, len=12, value=inner)   // 16 字节
```

`encodeTlvMessage(tag, len, value)` 的布局是 **tag 2 字节大端 + len 2 字节大端 + value**（`getTlvTotalSize` 返回 4+len 佐证）。

所以第 2 帧明文恒为 16 字节：

```
7f52 0010 0001 0004 <u32 LE> 0002 0004 <car_n 4B>
```

这与实测帧长吻合：`ef0110` + 16 字节 = 19 字节，去掉 3 字节分片头后 payload 正好 16 字节。

#### 6.29c　XOR key 仍未解出

`getXorResult(&outLen, data, dataLen, key, keyLen)`（0xa02b4）逐字节异或，长度取 `min(dataLen, keyLen)`。

用 31 组完整握手样本（`app_n`、`car_n`、`f2` 全部配对，来自 `btsnoop_full.log` 的 18 个连接）反推：

- 按 §6.29b 的明文结构算出 key，**31 组各不相同**，说明 key 是每轮派生的
- 同一连接内多轮（实测有 2 轮、3 轮的连接）key 也不同，排除「连接建立时固定」

`generateSessionKey`（0xa2330）已读通，它调用 `getSessionKey(out, outLen, u32 a, u32 b, key, keyLen, x6, x7)`，而 `getSessionKey`（0xa0524）内部把 `a`、`b` 拼成 8 字节作为 HKDF 的 **info**，`key` 作为 **salt**，`x6` 作为 **ikm**。

**但 `a`、`b` 不是两个 nonce。** 这两个 u32 由更上层传入，穷举 `app_n`/`car_n` 的所有组合（含大小端、拼接顺序、ikm/salt 互换，共 1728 种 HKDF 组合 + HMAC/SHA 变体）均无命中。

#### 6.29d　BleKeyV3Auth1Params 结构体已解出

`generateAuth1DataV3`（0xa1ca8）在栈上填充该结构体后调 `createBleKeyV3Auth1RequestWithInput`：

```
+0x00  u32    ← generateAuth1DataV3 的第 3 个参数，最终进 TLV tag=1
+0x04  ptr    ← 第一个 buffer
+0x0c  u8     ← 第一个 buffer 的长度
+0x0d  ptr    ← 第二个 buffer（XOR 用的 key）
+0x15  u32    ← key 的长度
```

与 `createBleKeyV3Auth1RequestWithInput` 的读法逐字段吻合（`[x0]`、`[x0+4]`、`[x0+0xc]`、`[x0+0xd]`、`[x0+0x15]`）。

`calculateAuth1SessionKey`（0x892a4，跳转桩 → 0x1146f0）与 `resc_calculateAuth1SessionKey`（0xa0680）都走 **MD5**：

```
md5( le32(a) || le32(b) )  → 16 字节
```

#### 6.29e　剩余缺口：XOR key 的派生输入

已排除的假设（均用 31 组样本验证，全部失败）：

- `f2` 只依赖 `app_n`（含大小端）
- HKDF-SHA256，`ikm`/`salt`/`info` 取 `app_n`/`car_n`/`KI` 的 1728 种组合
- HMAC-SHA256、SHA256 直接截断
- `MD5(le32(a)||le32(b))`，`a`/`b` 取 `app_n`/`car_n`/`KI`/零 的所有配对
- `MD5(明文)`、`MD5(app||car)`、`MD5(car||app)`

结论：**XOR key 由 `BleKeyV3Auth1Params` 的 `+0x0d` 指针传入，该 buffer 由加固的 Java 层算好后交给 native**，与 §6.26 中「签名私钥在 Java 层」是同一处边界。native 侧只负责 TLV 组装与 XOR。

轮次间隔实测约 127 秒（31 轮，18 个连接），符合保活周期。

#### 6.29f　为什么静态追不到 key 的来源

关键事实：`libbledata.so` 对外只导出 6 个密码学 JNI 原语，**没有**任何「构造 Auth1 帧」的 JNI 入口：

```
hkdf_sha256_jni(0xa3708)        hmac_sha256_jni(0xa3a88)
aes_256_cbc_encrypt_jni(0xa3d0c) aes_256_cbc_decrypt_jni(0xa3fe0)
aes_128_cbc_encrypt_jni(0xa42a0) aes_128_cbc_decrypt_jni(0xa45dc)
```

也就是说 `createBleKeyV3Auth1RequestWithInput`、`generateAuth1DataV3` 这些 C++ 符号是**内部实现**，由 native 内部经虚表调用（反汇编中可见 `ldr x8,[x8,#0x580]; blr x8` 模式）。

实测验证：

- `bl` 直接调 `createBleKeyV3Auth1RequestWithInput` 的 PLT 桩（`0x114b44`）的指令：**0 条**
- 引用 `generateAuth1DataV3` 的 GOT 槽（`0x127b90`）的代码：**0 条**
- 说明全部走间接调用，静态无法建立调用边

`generateAuth1DataV3` 与 `generateAuth0DataV3` 的 GOT 槽相邻（`0x127b90` / `0x127b78`），属同一虚表；`+0x0d` 与 `+0x45` 两处 key 字段分别在 `BleKeyV3Auth1Params` 和 `BleKeyV3Auth0Params` 里，两个结构体不同。

#### 6.29g　Auth0 与 Auth1 的 key 不同源

`createBleKeyV3Auth0RequestWithInput`（0x8f344）读：

```
key  = [params+0x45]，长度 = [params+0x4d]     ← AES-256 的 32 字节 key
IV   = 0x50090 处的常量 ccf3e8342bd6071fde7270dfa0876bb8
```

而 Auth1 的 XOR key 是 `[params+0x0d]`，长度 16。两者不同源，不能从 Auth0 的密文反推 Auth1 的 key。

#### 6.29h　结论

第 2 帧的**帧结构已 100% 确定**，可以自己构造出合法帧；只差 XOR key 的 16 字节取值。取到它的路径只剩两条：

1. 动态 hook `getXorResult` 或 `generateAuth1DataV3`，读 `params+0x0d` 指向的 buffer（需解决 §6.1 的脱壳问题）
2. 继续往上追 `generateAuth1DataV3` 的调用者，找到给 `+0x0d` 赋值的 Java 侧逻辑

### 6.30　实测：不完成握手，车控帧一律被拒

2026-11-02 深夜，用 Mac 直连车端 BLE（`XPED-DC0D30B094C4`，ED28 服务），跳过握手直接写车控帧，验证「车端是否要求先认证」。

#### 6.30a　实验方法

`scripts/ble-direct-cmd-probe.swift`：连上后只做 GATT 发现，不写任何 `0xEF` 认证帧，直接写一条从官方 App 抓来的完整车控帧（142 字节，含 3 字节分片头，签名与 KI 都是原帧的，必然有效）。

两帧都试了：

| 帧 | auth[8:10] 低字节 | 指令 | 回执 |
| --- | --- | --- | --- |
| 抓包第 1 帧 | `0x83`（长度 131，非方向码） | 解锁 | `08000600000000000000` |
| 抓包第 2 帧 | `0x84`（长度 132，非方向码） | 上锁 | `08000600000000000000` |

两帧回执逐字节相同，且**车没有任何动作**（用户现场确认未解锁）。

#### 6.30b　结论

- 回执走 `0x0800` 通道，不是车控回执的 `0x70` 通道（§6.18c）。说明车端把 `0xED` 通道的帧按**认证请求**处理，根本没进车控分支。
- 结果字节 `0x06` 是拒绝码。对照 §6.17d：握手重放失败时回 `0x0800 0e`，那是认证失败；`0x06` 是另一种拒绝。
- **车控帧自包含（KI + ED + SN 齐全、签名有效）并不够**：车端还要求当前连接处于已认证状态。

这推翻了「车控帧自包含即可下发」的假设（§6.19 曾据签名只覆盖 ED 推测可改指令重放）。**握手是硬前置，绕不过去。**

#### 6.30c　对后续路线的影响

假车路线（§6.27）与改包路线（§8.3）都已堵死，现在又确认不能跳过握手。自研客户端要控车，只剩一条路：**完整实现握手，即解出 XOR key 的派生**。

`libbledata.so` 里已确认存在完整的握手实现（§6.29），缺的只有 `BleKeyV3Auth1Params +0x0d` 那个 16 字节 key 的来路。

### 6.31　5.19.0 的 dex 是空壳：类名全是诱饵，代码只在运行时内存

> 内容已并入 §1.4（5.19.0 的 dex 是空壳）。

### 6.32　握手时序修正：第 2 帧写进去车端就认可

此前把三帧握手记成「单向连发」，实际解码 31 轮完整抓包（`btsnoop_full.log`）后的时序是**写-收交替**：

```
写 ef0104 <4B app_n>      → 车回 INDICATE 4B <car_n>
写 ef0110 <16B>           → 车回 INDICATE 10B: 08 00 01 44 46 30 30 48 2e 32
写 ed1118 <24B>           → 车回 INDICATE 150B 能力列表
```

**第 2 帧的回执 `08 00 01` + ASCII `DF00H.2` 是认证成功**，31/31 全部成功，零失败。

对照实验（§6.30）里跳过握手直写车控帧得到 `08 00 06`，**`0x06` 是拒绝码**。所以 `0x0800` 通道的结果字节含义：`0x01` 成功、`0x06` 未认证拒绝、`0x0e` 认证失败（§6.17d 的重放实验）。

#### 6.32a　31 组样本的字段性质

| 字段 | 长度 | 31 轮是否全不同 |
| --- | --- | --- |
| `app_n`（第 1 帧） | 4 B | 是，31/31 |
| `car_n`（车端挑战） | 4 B | 是，31/31 |
| 第 2 帧 | 16 B | 是，31/31 |
| 第 3 帧 | 24 B | 是，31/31 |

`app_n` 与 `car_n` 都是随机数，无单调性、无重复、无结构规律（已验）。第 3 帧前 2 字节恒为 `0011`，其余随轮次变。

### 6.33　数字钥匙服务端接口实测：密钥材料按 keyId 下发，不随卡片信息返回

2026-11-02 深夜，用模拟器（5.19.0，已登录子账号）解出的真实 token 直接调数字钥匙服务端，拿到了这条链路的第一手数据。

#### 6.33a　token 解出方法（已跑通，可复用）

`scripts/unseal-token.py` 因多设备在线时 adb 无 `-s` 失败，手工流程已验证：

1. `adb pull /data/misc/keystore/persistent.sqlite` → 查 `keyentry.alias='XTeeSecurityAlias'` 拿 `id`
2. `blobentry` 里 `subcomponent_type=0` 的 blob（1352 B），切 `b[5:5+4+int(b[7:9])]` 得 DER RSA-2048 私钥
3. `adb pull /data/data/<pkg>/files/mmkv/tee`（8192 B），MMKV 变长编码：`key名` + `varint外层长度` + `varint内层长度` + base64 值
4. `XTeeEncryptAesKey` 用 RSA PKCS1v15 解出 **16 字节 AES-128 key**；`XTeeSecurityIv` 解 base64 得 IV
5. `accessToken` / `refreshToken` 用 AES-CBC 解出，明文是 `eyJ...` JWT

#### 6.33b　接口前缀与可用路径（实测）

基址 `https://apps.xiaopeng.com`，数字钥匙服务是 `xp-smart-digital-key-boot`。**路径前缀不统一**，实测：

| 路径 | 结果 |
| --- | --- |
| `/digital-key/v1/key/ble/card-info/own` | **200**，需 `{vin}` |
| `/digital-key/v1/key/ble/card-info/detail` | 存在，需 `receiver` |
| `/digital-key/v1/key/ble/activate` | 存在，需 `vin`+`cardNo`+`ifaaRequest` |
| `/digital-key/v1/key/ble/create` | **200**，返回 `cardNo` |
| `/digital-key/v1/key/create/check` | **200**，返回 `hasBleKey`/`hasNfcPhoneKey` |
| `/digital-key/v1/key/ble/get` `/check` `/modify` `/common/get` | **404**（这几个不在此前缀下） |
| `/xp-smart-digital-key-boot/app/ble/v1/getAuthData` | 存在，需 `count`+`keyId` |
| `/xp-smart-digital-key-boot/app/ble/v1/createKey` | 存在，返回 `1019 The vehicle certificate is not pre-set` |

真正的 BLE 接口名是 `createKey` / `deleteKey` / `getAuthData` / `getEmergencyAuthData` / `shareKey`，**不是** `get`/`check`。

#### 6.33c　关键结论：卡片信息里没有密钥材料

`/digital-key/v1/key/ble/card-info/own` 返回的 `cardList` 单条记录字段全量如下：

```
cardNo  status  nickName  effectiveTime  validTime  cardType
deviceId  userId  shareFrom  vin  createTime  updateTime  channel  protocol
```

**没有 `key`、`privateKey`、`salt`、`seed`。** 只有卡片元数据。

而 `getAuthData` 明确要求 `count` + `keyId` 两个参数——**密钥材料是按 `keyId` 单独取的，不在卡片信息里**。这修正了 §6.22b 把 `salt`/`seed` 当作与 `key` 同源下发的推断：它们同属 `BleKeyInfo` 本地模型，但服务端是分开下发的。

#### 6.33d　子账号实测：卡片能建，密钥没下发

| 步骤 | 结果 |
| --- | --- |
| `create/check` 前置 | `hasBleKey: false` |
| `ble/create` | `200`，`cardNo = B11793633545540` |
| `card-info/own` 复查 | 卡片已存在，`status: 2`，绑定本机 `deviceId` 与 `uid` |
| `create/check` 复查 | **仍为 `hasBleKey: false`** |
| `ble/activate` | 缺 `ifaaRequest`，未走通 |

**`create` 只建了卡片记录，没有产出 `hasBleKey: true`**。说明激活是独立一步，且需要 IFAA 生物认证请求（`ifaaRequest`）。

### 6.34　决定性突破：服务端直接下发完整可用的车控帧，不需要私钥

2026-11-02 深夜实测。这一条推翻了 §6.19–§6.29 全部围绕「解握手 / 取私钥」的路线判断。

#### 6.34a　接口与实测响应

> 已提升到 §6.25a。
#### 6.34b　与抓包帧的对照

抓包帧（§6.25c）在 `XPBKTH` 前多 7 字节 `00 84 <4B> 00`，且 SN 的 tag 写成 3 字节 ASCII `SN` + 2 字节长度；服务端用 TLV 外层 tag `0x5380` 包住。**除封装差异外，密码学字段完全同构。**

所以自研客户端拿到 `authDataList` 后，只需补上分片头 `ed 11 <len>` 和 7 字节前缀，就是一条可直接写入车端的合法帧。

#### 6.34c　为什么这条路能成

车端验的是「签名对不对 + 这个 uid 是否被授权」，不验「签名是不是本机私钥签的」。服务端持有私钥，为客户端代签。这正是 §6.26 里「私钥不在 APK」的原因——它从来不需要在客户端。

#### 6.34d　待实测

帧已按 `ed 11 82 | 00 84 | 00000000 | 00 | XPBKTH...` 构造完成，下一步实测车端是否接受。

#### 6.34e　附带拿到的车端信息

`/digital-key/v2/key/ble/getBleInfo` 返回本车 BLE 拓扑，可直接用于连接策略：

```
name BLE      mac 00:60:37:85:b9:d0   hv H.2   partNo 8810005DF10000
slaveMacList:
  BLEFR  dc:0d:30:b0:94:c4   H.3
  BLER   dc:0d:30:b0:c4:a4   H.3
  BLEFL  dc:0d:30:b0:79:01   H.3
```

**这解释了 §6.25 的困惑**：`XPED-00603785B9D0` 是主模块（尾号 b9:d0），`XPED-DC0D30B094C4` / `B0C4A4` 是左右后视镜与车头的从模块。Mac 能连上 DC0D30 是因为它是从模块，主模块只在被唤起时广播。

#### 6.34f　服务端下发的 authData 性质（实测三次）

> 已提升到 §6.25b。
#### 6.34g　车端仍然拒绝，原因定位

把服务端 authData 按抓包格式重新封装（3 字节 tag `SKI`/`EED`/`SN`，补 `ed 11 <len>` + 7 字节前缀），写入车端仍得 `0800 06`。

对照两把钥匙的 KI：

| 来源 | KI | 车端反应 |
| --- | --- | --- |
| 官方 App 抓包（主账号） | `7a32fc31ace4afd950b24f60eb9b2545` | 接受 |
| 服务端下发给本机 | `12a774ba5b82bddb8bae973e35bed8e8` | `0x06` 拒绝 |

配合 `/digital-key/v1/key/create/check` 恒返回 **`hasBleKey: false`**（即使 `ble/create` 已建出卡片记录、`card-info/own` 能查到 `status: 2`），结论：

**卡片记录建了，但钥匙没有在车端激活。** `ble/create` 只写服务端记录，真正的激活是 `ble/activate`，而它强制要求 `ifaaRequest`（IFAA 指纹/人脸认证请求），模拟器无生物识别硬件，这条路在模拟器上走不通。

#### 6.34h　当前唯一缺口与两条可行路径

自研客户端要控车，需要的三样东西（KI、ED、签名）**服务端一次调用全部给齐**，且格式已验证可封装成合法帧。缺的只有「让车端认可这个 uid」。

路径 A（推荐）：在**真机**上完成一次 `ble/activate`。真机有指纹，IFAA 能过；激活后服务端下发的 authData 车端就会认。~~自研客户端此后只需调 `getXpKeyAuthData` 拿帧，不需要私钥、不需要握手、不需要 root。~~ **「不需要握手」是错的，见 §6.78a**：`getXpKeyAuthData` 只下发命令帧，而 `ef0110` 是命令的硬前置（§6.35e 实测：握手失败后车端静默丢弃后续所有帧）。激活只解决「钥匙归属」，不解决握手。

路径 B：用主账号的钥匙。主账号在手机上已激活（KI `7a32fc31...` 实测被车端接受），但它的 token 在手机上、手机无 root，取不到。若能在模拟器登录主账号，则同样可走路径 A 的接口直接拿帧。

> **2026-11-04 更新：手机已 root，且 §6.54 的「296 条帧」已确认是子账号的。**
>
> `XpVehicle.db` 的 `xp_vehicle_xp_key_message` 表在 root 手机上共 **296 条**，
> 但 `xp_vehicle_keys.key_info` 里 `shareFrom=2389771`、`user_id=25400867`
> ——**手机登录的是从主账号分享出来的子账号**，不是主账号本身。
> 这 296 条的 `KI` 全是 `12a774ba…`（子账号那把，车端 `0x06` 拒绝），
> 与 §6.54b 记的模拟器情况完全一样。
>
> 所以「手机上就有主账号的帧」不成立：**手机自己也拿不到主账号的帧**，
> 它靠云端 MQTT 控车（联网时 btsnoop 里一个 BLE 帧都没有，实测两次）。
> 只有断网后 App 才走 BLE，而那时发的仍是子账号的握手帧。
>
> 主账号 `KI = 7a32fc31ace4afd950b24f60eb9b2545` 在手机文件与内存里都搜不到，
> 不在本地明文存储。

**路径 A 的关键前提**：真机上要能截获 `ble/activate` 的完整请求（含 `ifaaRequest`）与响应，确认激活后 `hasBleKey` 变 `true`。

### 6.35　握手是命令的前置条件（实测确认），缺口收敛到 ef0110 的 16 字节

#### 6.35a　完整命令前置序列（从 31 次连接的抓包中提取）

> 已提升到 §6.19a。
#### 6.35b　重放握手实测：车端校验 car_n，重放必败

把抓包里的三帧原样重放到车端：

```
-> ef0104 8fe82373
<- 4B  c6d269b6                    ← 车端返回了新的 car_n（与抓包时的不同）
-> ef0110 16bb123ae2fa52cc7ec3ca0016039458
<- 10B 0800 0e 00000000000000      ← 0x0e = 认证失败
```

而原连接里同样位置返回的是 `0800 01 ... 成功`。

**结论：车端用当次新生成的 `car_n` 校验 `ef0110`，抓包里那 16 字节只对当次的 `car_n` 有效，重放一定失败。** 这也解释了为什么主账号那条原本可用的命令帧，现在单独写入同样被拒——命令帧本身没问题，是缺了前置握手。

#### 6.35c　car_n 与 sessionKey 的统计特征（31 组样本）

- `app_n`：31 个全不重复（App 侧随机）
- `car_n`：31 个全不重复（车端随机挑战）
- `ef0110` 的 16 字节：31 个全不重复，字节分布无固定位置

把明文按 `7f52 <len> 01 04 <app_n> 02 04 <car_n>` 构造（15 字节）与密文前 15 字节异或，得到的候选 key **15 个字节位置上全部各不相同**——即 key 不是固定值，每轮独立派生。

**因此 `ef0110` 不是「固定密钥 XOR 明文」，而是每轮由 `(app_n, car_n, KI)` 派生。** 这与 §6.29 的 HKDF 判断一致，参数在加固 Java 层。

#### 6.35d　服务端接口无法提供握手数据

`getAuthData`（唯一可能返回握手材料的接口）强制要求 `ifaaRequest` 为**非空对象**：

| 传入 | 结果 |
| --- | --- |
| 缺失 / `null` | `11090002 参数[ifaaRequest]may not be null` |
| 字符串 | `11090002 请求报文json格式错误` |
| 对象 `{}` 及各种字段组合 | `11099999 服务器开小差`（校验深入后失败） |

IFAA 是硬件级生物认证（`org.ifaa.android.manager`），模拟器无信任根，这条路在模拟器上不通。

#### 6.35e　握手失败会静默丢弃后续所有帧（实测）

实验设计：连上车端后依次写 `ef0104`（随机 app_n）→ `ef0110`（16 个 `0xAA`，故意错）→ `ed1118` → 命令帧。

结果：

```
-> ef0104 d4e5fee5
<- 4B 770f6cd5              ← 车端正常返回 car_n
-> ef0110 aaaa...（错）
<- 10B 0800 0e ...          ← 认证失败
-> ed1118 ...               ← 车端无任何响应
-> ed118b <命令帧>          ← 车端无任何响应
[*] timeout
```

**握手失败后车端不报错、不断连，只是静默丢弃后续所有帧。** 这意味着命令帧必须建立在成功握手之上，没有任何「跳过握手」的余地。

这也最终解释了 §6.34g 的现象：服务端下发的 authData 命令帧本身合法（签名有效、KI/ED 齐全），但单独写入必然被静默丢弃——**缺的不是签名，是握手**。

#### 6.35f　缺口收敛

| 环节 | 状态 |
| --- | --- |
| 取 KI / ED / 签名 | ✅ 服务端 `getXpKeyAuthData` 一次给齐 |
| 构造合法命令帧 | ✅ 结构已验证，与抓包同构 |
| 连接车端 GATT | ✅ Mac 可连 `XPED-DC0D30*` 从模块 |
| `ef0104` 发 app_n | ✅ 车端正常回 car_n |
| **`ef0110` 16 字节** | ❌ **唯一缺口**：需由 `(app_n, car_n, KI)` 每轮派生 |
| `ed1118` | 待 `ef0110` 成功后验证 |
| 写命令帧 | 待握手成功 |

`ef0110` 的派生算法在加固 Java 层（§6.29），31 组样本已排除简单 HKDF/MD5 组合。

#### 6.35g　ed1118 的 24 字节也每轮变化，末字节恒为 0xe0

31 组 `ed1118` 样本：

```
ed1118 0011 8e4ec850 00 db61b5b113d0870e6482ace4772c27e2 e0
ed1118 0011 404a1008 00 79e7bc63907ddbaa4703eee75aff5654 e0
ed1118 0011 8d3fbf8a 00 2d27d6e8b9598fbe315068a45aa985e5 e0
```

结构：`ed 11 18`（分片头）+ `00 11` + 4 字节（每轮变）+ `00` + **16 字节**（每轮变）+ `e0`（恒定）。

末字节 `e0` 恒定、中间 16 字节全变，说明这 16 字节同样由 sessionKey 参与加密。**握手三步（`ef0104`/`ef0110`/`ed1118`）是一条密码学链，`ef0110` 是入口。**

#### 6.35h　4.2.0 的 dex 也是加固壳，静态路线封死

`110_e0a334a53b43b151237ca5549e377b21.apk`（4.2.0，120 MB）的 `classes.dex` 有 40 MB，但 header 声明：

```
class_defs_size: 31        ← 只有 31 个类
string_ids_size: 1132
data_size: 49068           ← 声明数据区仅 49 KB
file_size:  40395592       ← 但文件 40 MB
```

**声明数据区在 `0x10174` 结束，之后有 40,329,684 字节未被 dex 结构覆盖**，其熵约 6.26 bits/byte（压缩或加密载荷）。

`strings` 能搜到 `Lcom/xiaopeng/common/car/digitalkey/blekey/ble/AuthPackager`、`BleAuthManager`、`BleKeyConnectionManager` 等类名（在字符串池里），但 `dexdump` 看不到这些类的定义。

**结论：4.2.0 与 5.19.0 一样是加固包，`AuthPackager` 的真实实现只在运行时内存。** 之前「4.2.0 是明文 Java 实现、可静态反编译」的判断被推翻。

#### 6.35i　每条命令前都重新握手，无复用捷径

> 已提升到 §6.19b。
#### 6.35j　静态穷举已尽，结论如下

已用 31 组样本验证且**全部不命中**的算法：

| 类别 | 已试组合 |
| --- | --- |
| 直接 KDF 输出 | `hmac(KI,an+cn)`、`hmac(KI,cn+an)`、`md5(an+cn)`、`md5(KI+an+cn)`、`sha256(KI+an+cn)[:16]`、`sha256(an+cn+KI)[:16]` |
| HKDF 参数 | salt ∈ {无, KI, an, cn} × info ∈ {an+cn, cn+an, an, cn} × {SHA-256, SHA-1} |
| 常量穷举 | salt/info ∈ {`xiaopeng`,`XPBKTH`,`BleKey`,`sessionKey`,`XPeng`,`D55`,`DF`,`DF00`, 全零} 共 14×14×4 组合 |
| AES | `AES-128-ECB(KI, an+cn)`、`AES-128-ECB(KI[:16], 7f52 结构)` |
| 两段关系 | `ef0110 XOR ed1118[7:23]`，31 组全不同，非同 key |

**判定**：`ef0110` 的派生依赖至少一个尚未识别的常量（salt 或 info 前缀），该常量在加固 dex 的运行时内存里，静态拿不到。

#### 6.35k　当前完整状态

| 环节 | 状态 | 依据 |
| --- | --- | --- |
| 取 KI / ED / 签名 | ✅ | `getXpKeyAuthData` 一次给齐，KI 稳定、ED 每轮新 |
| 构造合法命令帧 | ✅ | 与抓包同构，签名有效 |
| 连接车端 GATT | ✅ | Mac 可连 `XPED-DC0D30*` |
| `ef0104` 发 app_n | ✅ | 车端正常回 car_n |
| **`ef0110` 16 字节** | ❌ | 唯一缺口，需运行时常量 |
| 握手失败后果 | 已知 | 车端静默丢弃后续所有帧，无跳过余地 |
| 4.2.0 静态脱壳 | ❌ | 同样是加固包，40MB 加密载荷 |
| 服务端代签握手 | ❌ | `getAuthData` 强制 IFAA，模拟器无信任根 |

### 6.36　订正：子账号的蓝牙钥匙**是激活状态**，`hasBleKey` 不是判据

#### 6.36a　界面实证推翻 §6.34g

模拟器（5.19.0，子账号登录）进入「数字钥匙」页面，显示：

```
手机蓝牙钥匙            ← 卡片存在，无「激活」按钮
解 锁并登录大屏   [开启]
使用说明
```

**没有「激活钥匙」按钮，蓝牙钥匙卡片直接可见。** 这与用户的实际观察一致。

§6.34g 依据 `/digital-key/v1/key/create/check` 返回 `hasBleKey: false` 判定「卡片没激活」，是**误判**——该接口的 `hasBleKey` 反映的是另一层含义（很可能是「本机是否已下载密钥材料到本地」），不是「服务端是否已授权」。

**因此 §6.34g/§6.34h 里「必须走 IFAA 激活」的结论作废。** 用户的钥匙本来就能用。

#### 6.36b　明文布局订正：16 字节，不是 15

§6.35c 用的 `7f52 0c 0104 <app_n> 0204 <car_n>`（15 字节）是错的。正确布局：

```
7f 52 00 10 | 01 04 <app_n> | 02 04 <car_n>      = 16 字节
```

`00 10` = 0x0010 = 16，是**整条 TLV 总长**语义（不是内层长度）。校验样本：

```
app_n=d4e5fee5  car_n=ffdba7e0  ef0110=92b7148348c91f370a898d0ce5855afe
明文 = 7f520010 0104d4e5fee5 0204ffdba7e0
key  = ede5149349cdcbd2f46c8f081a5efd1e
```

31 组样本用此布局算出的 key 全不相同（`ede51493…`、`96355565…`、`a66394e3…`…），与「key 每轮独立派生」一致。

**§6.26b 与 §6.29b 的 TLV 长度描述互不自洽**（按各自规则数出来是 20 和 16/20 混用），需一并订正。基于 15 字节布局得出的全部「已排除」结论（§6.35j 的 9 条）**已作废**，但用 16 字节布局重跑这些组合**仍然全部不命中**。

#### 6.36c　模拟器假车能广播，但被硬件扫描过滤器挡住

假车（`fake_car.py`）注册成功，模拟器内可见：

```
00:20:33 INFO registered as '58942' — the guest should now see XPED-00603785B9D0
```

App 也确实发起了扫描：

```
bt_shim_scanner: Scan: in shim layer started
bt_shim_scanner: ScanFilterAdd: in shim layer
bt_shim_scanner: ScanFilterEnable: in shim layer
```

但 **App 收不到任何扫描结果**。原因：App 用 `ScanFilter`（硬件级过滤）按**服务 UUID `0000ED28-ABAB-406D-832D-7AD799B479F7`** 过滤，而模拟器的 `Advertisement` proto 只有三个字段：

```
device_name, connection_mode, discovery_mode
```

**没有 service UUID / service data 字段，假车无法在广播里带上该 UUID**，所以被过滤器全部丢弃。

这是模拟器蓝牙模拟的硬限制，不是配置问题。

#### 6.36d　假车方案的可行解法（待实施）

| 方案 | 要点 |
| --- | --- |
| native hook 过滤层 | 在模拟器蓝牙栈 hook `ScanFilterAdd`/`onScanResult`，让结果绕过 UUID 匹配 |
| 改 netsim 广播合成 | 在 netsimd 或 `fake_car.py` 的 gRPC 层伪造含 service UUID 的 AD 结构（proto 无此字段，需改 proto） |
| 放弃假车，用真车 | Mac 直连真车，但缺 `ef0110` |

`libbledata.so` 在所有 App 进程中都未加载（`maps` 计数为 0），说明握手库确实按需加载，且尚未被触发。

#### 6.36e　16 字节布局下重跑的密码学检验（全部不命中）

用正确的 `7f520010 0104<app_n> 0204<car_n>` 明文重新验证：

| 类别 | 组合 | 结果 |
| --- | --- | --- |
| HKDF-SHA256/SHA1 | salt ∈ {无, KI, app_n, car_n, app_n+car_n, car_n+app_n} × info ∈ {app_n+car_n, car_n+app_n, app_n, car_n, 空, KI} | 0 命中 |
| HMAC/MD5/SHA | `hmac(KI,an+cn)`、`hmac(KI,cn+an)`、`md5(KI+an+cn)`、`sha256(KI+an+cn)[:16]` | 0 命中 |
| AES | `CBC(KI[:16], iv=car_n×4)`、`iv=app_n×4`、`iv=全零`、`ECB` | 0 命中 |

**判定不变**：`ef0110` 依赖一个尚未识别的常量，静态与已知样本穷举均无法得到。

#### 6.36f　模拟器假车路线的硬限制

`android.emulation.bluetooth.Advertisement` proto 只有三个字段（`device_name`/`connection_mode`/`discovery_mode`），**无 service UUID / service data 字段**，netsim 无法把 `0000ED28-ABAB-406D-832D-7AD799B479F7` 放进广播。

App 用 `ScanFilterAdd`（硬件级过滤，`bt_shim_scanner` 日志实证）按该 UUID 过滤，因此假车永远扫不到。这不是配置问题，改 proto 才能解，属模拟器固有限制。

同时 `com.xiaopeng.mycarinfo` 主进程对 frida 不可见（加固壳屏蔽，按 pid 附加报 `process not found`），无法用 Java hook 清空过滤器。

#### 6.36g　结论：`ef0110` 是唯一且真实的缺口

| 已闭环 | 依据 |
| --- | --- |
| 服务端一次调用下发 KI + ED + 有效签名 | `getXpKeyAuthData` 实测，KI 稳定 ED 每轮变 |
| 命令帧结构、TLV、分片、CRC | 与抓包逐字节同构 |
| 握手时序与前置条件 | 31 次连接抓包 + 重放实验 |
| 子账号钥匙已激活 | 界面实证（无激活按钮） |
| 握手失败后果 | 车端静默丢弃后续所有帧 |

| 唯一缺口 | 说明 |
| --- | --- |
| `ef0110` 的 16 字节 | 由 `(app_n, car_n, KI, 未知常量)` 派生，算法在加固 Java 层，需运行时内存 |

### 6.38　`ef0110` 的 native 实现已完整反汇编：算法在 Java 层

#### 6.38a　`libbledata.so` 的握手相关导出

```
0x8f284  createBleKeyV3Auth0RequestWithInput   Auth0（第 1 帧）
0x8f4c4  createBleKeyV3Auth1RequestWithInput   Auth1（第 2 帧）
0x8ed74  getAuth1FactorTlvData                 Auth1 的明文 TLV
0xa0344  SDKBleKeyV3::getSessionKey            会话密钥
0xa2150  generateSessionKey                    getSessionKey 的包装
0xa00d4  SDKBleKeyV3::getXorResult             XOR 封装
0xa3528  hkdf_sha256_jni                       HKDF（**转发到 Java**）
```

#### 6.38b　`getAuth1FactorTlvData` 证实了 16 字节布局

```asm
8edbc  bl  host_int32_to_little_endian      ; app_n -> LE
8edcc  w0=1, w1=4                           ; encodeTlvMessage(tag=1, len=4, app_n_le)
8edf4  encodeTlvMessage(tag=2, len=car_nLen, car_n)
8ee50  w0=0x7f52                            ; 外层 tag 0x7F52
```

明文 = `7F52 0010 0104<app_n_le> 0204<car_n>`，16 字节。**与 §6.36b 的推断完全一致。**

#### 6.38c　`createBleKeyV3Auth1RequestWithInput` 的处理链

```asm
8f520  bl getAuth1FactorTlvData     ; 生成 16B 明文
8f538  bl getTlvTotalSize           ; 取长度
8f554  bl getXorResult(out, pt, len, key, keyLen)   ; 明文 XOR key
8f570  bl calc_crc16_ccitt          ; 对结果算 CRC16
8f574  bl host_int16_to_little_endian
```

**确认：`ef0110` = XOR(明文16B, key16B) + CRC16(LE)，key 就是 sessionKey。**

#### 6.38d　`getSessionKey` 的真实签名（推翻此前的 info 假设）

```
_ZN11SDKBleKeyV313getSessionKeyEPhmjjPKhmS2_m
  = (uchar* out, size_t outLen, uint32 a, uint32 b,
     const uchar* salt, size_t saltLen,
     const uchar* ikm,  size_t ikmLen)
```

```asm
a03a4  stp w24, w23, [x0]     ; 8 字节临时缓冲 = a(LE) || b(LE)
a03a0  mov w1, w19            ; outLen
a03a8  mov x0, x20            ; salt
a03ac  mov x2, x22            ; saltLen
a03b0  mov x3, x21            ; ikm
a03b4  mov w5, #8             ; infoLen = 8
a03b8  mov x6, x26            ; out
a03bc  mov x7, x25            ; outLen
```

**`a||b` 是 HKDF 的 `info`（8 字节），不是 salt。** salt 与 ikm 都是独立入参。

#### 6.38e　`generateSessionKey` 的三个入参全部来自 Java

```asm
a2194  blr [x8+0x5c0]   ; 取 salt 字节数组 -> x22，长度 w26
a21ac  blr [x8+0x558]   ; 取 salt 长度
a21c8  blr [x8+0x5c0]   ; 取 ikm 字节数组  -> x23，长度 w24
a21e0  blr [x8+0x558]   ; 取 ikm 长度
a2220  bl  getSessionKey
```

三处 `blr` 都是**对象虚调用**，指向 Java 层传入的 `byte[]`。`a`/`b` 由调用者给（`w25`/`w3`）。

#### 6.38f　`hkdf_sha256_jni` 本身不实现 HKDF

```asm
a36d0  bl _ZN7_JNIEnv22CallStaticObjectMethodEP7_jclassP10_jmethodIDz
```

native 只做转发，**真正的 HKDF 是 Java 静态方法 `hkdfSha256`**（vdex 字符串池里有 `hkdfSha256`、`hkdfSha256, input: `、`hkdfSha256, result:`）。

#### 6.38g　裸进程调用 `getSessionKey` 会崩溃

把 `libbledata.so` 推进设备，用 frida 在 `ScanProbe` 进程加载并直接调用：

```
salt=None  -> ret=1, out=全零        （参数校验失败）
salt=KI    -> access violation 0x0   （走到 JNI 调用，无 JVM 就崩）
```

**结论：`getSessionKey` 无法脱离 App 的 JVM 运行**，因为它依赖 `JNIEnv->CallStaticObjectMethod` 去调 Java 的 `hkdfSha256`。

#### 6.38h　因此缺口收敛为一个具体对象

| 已知 | 未知 |
| --- | --- |
| 明文 16 字节布局 | `salt` 的值 |
| XOR + CRC16 封装 | `ikm` 的值 |
| `info = a(LE)‖b(LE)`，a/b 是 app_n/car_n | Java 层 `hkdfSha256` 的入参顺序与哈希 |
| HKDF 由 Java 静态方法实现 | — |

`salt`/`ikm` 大概率是 `KI`（16B）与某个固定串（`BleKey`/`XPBKTH`/partNo 之一），但**用已知 31 组样本穷举这些组合均不命中**，说明还有第三个未知量参与。

#### 6.38i　App 进程全部无法 attach（加固壳 ptrace 保护）

```
com.xiaopeng.mycarinfo:data_provider -> unexpectedly timed out waiting for stop
com.xiaopeng.mycarinfo:tools         -> unexpectedly timed out waiting for stop
小鹏汽车 (主进程)                     -> TimedOutError
```

主进程、`:BLE`、`:core`、`:tools`、`:data_provider` **全部拒绝 frida attach**。`ScanProbe`（自建、未加固）可以 attach，但它没有 App 的类。

**这是当前唯一的技术墙：Java 层 `hkdfSha256` 的入参拿不到。**

#### 6.38j　`AlgorithmUtils` 是 HKDF 的真实实现类

`libbledata.so` 的 `.rodata` 里有三个 Java 类名：

```
com/xiaopeng/ble_data_processor/BLEDataProcessor
com/xiaopeng/ble_data_processor/AlgorithmUtils     ← hkdfSha256 所在
com/xiaopeng/ble_data_processor/BleByteMatrix
hkdfSha256
```

`hkdf_sha256_jni` 通过 `CallStaticObjectMethod` 调的就是 `AlgorithmUtils.hkdfSha256`。
**它是 Java 方法，不在 native 里，所以算法体可以按 JNI 签名推，但 `salt`/`ikm` 的取值在 Java 调用处。**

#### 6.38k　应急通道需要 keyId，而 keyId 来源仍未定位

`/xp-smart-digital-key-boot/app/ble/v1/getEmergencyAuthData` 只需要 `{vin, keyId, count}`，
**不需要 `ifaaRequest`**，门槛明显低于 `getAuthData`。但 `keyId` 试过的形式全部返回「钥匙不存在」：

```
cardNo / 小写 / 去前缀 / cardNo_1 / 0_cardNo / uid_vin / vin_uid / uid / vin / deviceId
```

`BleKeyInfo(uidVin=` 表明它是 Kotlin data class 的首字段，`EmergencyKeyAuthData(keyId=` 同理。
**keyId 不是任何已抓到的服务端响应字段**，它应在 `createDigitalKey` 的返回里。

#### 6.38l　accessToken 已过期，服务端探测暂停

```
/digital-key/v2/key/ble/getBleInfo      -> 12010101 登录状态已过期
/digital-key/v1/key/ble/getXpKeyAuthData -> 12010101 登录状态已过期
```

`work/live/` 下只剩 `tee.bin`，token 文件已不在；设备侧 token 存在 MMKV/加密存储，明文 prefs 里没有。
**要恢复服务端探测，必须重新走一次登录**（模拟器里的 App 仍在登录态，可从其内存取，但主进程 frida 不可 attach）。

#### 6.38m　当前缺口清单（本轮收敛后）

| 编号 | 缺口 | 性质 |
| --- | --- | --- |
| G1 | `AlgorithmUtils.hkdfSha256` 的 `salt` 与 `ikm` 取值 | 唯一阻塞项，纯 Java 常量/派生 |
| G2 | `keyId` 的来源（应急通道） | 备选路，需要有效 token 才能探 |
| G3 | 主进程内存无法 dump（frida 被 ptrace 挡） | 取 G1 的手段受限 |

#### 6.38n　`AlgorithmUtils` 与 `hkdfSha256V2` 都在 vdex 的 quickening 段

`base.vdex` 里只有一处真 dex 头（偏移 64），但它是个**空壳**：

```
filesize=120255620  header_size=112  strings=1547  types=133  classes=30
```

声明的 120MB 是填充，`class_defs` 只有 30 个。真实类名存在于 vdex 的 **quickening_info 段**（53MB 起），
该段只有字符串与方法元信息，**没有可反编译的字节码**：

```
@53471328  Lcom/xiaopeng/ble_data_processor/AlgorithmUtils;
@54260065  hkdfSha256 | hkdfSha256, input:  | hkdfSha256, result:
@63871628  hkdfSha256V2          ← V3 协议实际用的版本
```

APK 里的 `classes.dex`（120MB）与 vdex 内嵌的 dex **完全同构**，都是同一个空壳。

#### 6.38o　`hkdfSha256` 有调试日志，但 release 包不打印

字符串池里有 `hkdfSha256, input: ` 与 `hkdfSha256, result:`，说明原实现会打印入参和结果。
实测（清空 logcat → 进数字钥匙页 → 抓 562 行）**没有任何 hkdf/sessionKey/salt 输出**，release 构建已剥离。

`hkdfSha256V2` 连调试串都没有，只有方法名。

#### 6.38p　本轮确认的完整算法链（可直接实现，只差两个常量）

```
明文 P  = 7F52 0010 0104<app_n_le> 0204<car_n>          （16B，§6.38b 反汇编证实）
info    = app_n_le ‖ car_n_le                            （8B，§6.38d 反汇编证实）
sessionKey = HKDF-SHA256(ikm, salt, info, 16)            （ikm/salt 来自 Java 层）
ef0110  = XOR(P, sessionKey) ‖ CRC16_CCITT(LE)           （§6.38c 反汇编证实）
```

**除 `ikm` 与 `salt` 外，其余全部已由反汇编确定。**

#### 6.38q　本轮无法突破的原因

| 手段 | 结果 |
| --- | --- |
| 直接调 `getSessionKey` | 裸进程崩在 `JNIEnv->CallStaticObjectMethod` |
| frida attach App 进程 | 全部超时（ptrace 保护） |
| 从 vdex 反编译 `AlgorithmUtils` | quickening 段无字节码 |
| logcat 抓 HKDF 入参 | release 已剥离 |
| 穷举 salt/ikm（31 组样本 × 全组合） | 0 命中 |

#### 6.38r　MMKV v1.3.14 的短 cryptKey 与 CFB 恢复

`base.vdex` 字符串池里有一处 Kotlin 字符串模板片段：

```
2mmkvWithID(
        "XP_…          ← \xe2\x80\xa6 是 Kotlin 的 …
        "xp$#!)01"
    )
```

已提取库版本为 **MMKV v1.3.14**；短 cryptKey 按该实现补零至 16 字节，短于 AES key 长度不能证明还缺运行时片段。数据文件 offset 4 即密文，前 16 字节不是原始 IV。CFB128 可用首密文块作为反馈，从第二块恢复明文；缺少配套 `.crc` 不阻塞这些后缀块恢复，原始 IV 与首明文块仍未恢复。源码依据为 Tencent/MMKV `v1.3.14` 的 `Core/aes/AESCrypt.cpp`、`AESCrypt.h` 与 `Core/MMKV_IO.cpp`。

脱敏结果 `work/ble-runtime-20261104/mmkv-verify-recovery-result.json`：`work/mmkv/ble_cache_data` 的声明密文区间为 13647 字节，恢复后缀 13631 字节；`work/mmkv_live/ble_cache_data.bin` 为 6188/6172 字节。两份后缀均未识别到 `VERIFY_CODE` 或 `code` JSON 字段，不能推及其他存储或首块。验证码主路径是 `SecurityManager` 的 `VERIFY_CODE#<vin>#<type>`，普通缓存后备键为 `XP_VEHICLE_SDK_XP_AUTH_CODEVERIFY_CODE#<vin>#<type>`，见主文 §6.14；phone 记录类型为 `1`。

已有 `work/mmkv/tee` 与 `work/live/tee.bin` 的指定 phone 记录经已有 `/tmp/ks.sqlite` RSA 解封后，16 字节 verifyKey 对 31 条不同历史 `ed1118` 密文执行 AES-CBC/零 IV/NoPadding，31/31 解出末 12 字节全零；watch key 为 0/31（`work/ble-runtime-20261104/v2-known-key-match.json`）。两份备份不代表两把独立 key。未输出 key、token、VIN 或大帧；未联网手机。历史匹配不证明新账号激活、新鲜 key 获取或真实车辆验收。

#### 6.38s　`ble_cache_data` 确实有 16KB 真实数据

```
文件: work/mmkv/ble_cache_data  (16384 B, mtime 01:38)
布局: [4B actualSize=13647][actualSize 字节 AES-CFB 密文]（不内嵌原始 IV）
```

这与 §6.36 之前观察到的「MMKV 实例全空」不同——**App 这次真的写入了 13.6KB**。
文件已拉到 `work/mmkv/`（`ble_cache_data`、`vehicle_key_info`、`XP_TOKEN_INSTANCE`、`tee`、`mmkv.default`）。

#### 6.38t　`calc_crc16_ccitt` 是纯 native，可裸调用

```asm
a002c  mov w10, #0x8408        ; 反射多项式
a0038  ... 逐字节 eor + lsr + csel 循环
```

**CRC-16/CCITT（反射，多项式 0x8408）**，不依赖 JNI，可用于独立验证帧尾。

其余 `SDKBleKeyV3::hkdf_sha256` / `hmac_sha256` / `aes_256_cbc_*` 都只是 PLT 跳板：

```asm
a001c  b 0x114fc0 <_Z15hkdf_sha256_jni@plt>
```

**它们全部转回 JNI 版本，裸进程调用仍会崩。** 这条捷径不成立。

#### 6.38u　本轮结论

算法链已完整（§6.38p），但 `salt`/`ikm` 两个常量被三重保护挡住：

| 保护 | 表现 |
| --- | --- |
| vdex 无字节码 | `AlgorithmUtils` 只在 quickening 段，不可反编译 |
| frida 不可 attach | App 全进程 ptrace 保护，超时 |
| 裸调 native | 所有密码学入口都跳 JNI，无 JVM 即崩 |

`ble_cache_data` 的 CFB 后缀已离线恢复，短 cryptKey 与缺少 `.crc` 均不是后缀恢复阻塞；两份后缀未找到验证码，不代表主存储缺钥匙。P5V2 的 `tee` phone verifyKey 已匹配全部 31 条不同历史密文（§6.38r），V3 派生仍单列未知。

### 6.39　`tee` 是明文 MMKV：整套 XTee 密钥材料可直接读出

#### 6.39a　发现

`/data/data/com.xiaopeng.mycarinfo/files/mmkv/` 下有 13 个 MMKV 实例，其中 **`tee` 未加密**：

```
00000000: 6417 0000 9296 e032 0e58 5465 6553 6563  d......2.XTeeSec
00000010: 7572 6974 7949 7619 1879 5049 6c30 4c37  urityIv..yPIl0L7
```

MMKV 明文格式：`[4B size][2B 额外头][varint keylen][key][varint vallen][value]…`。
（此前的 `mmkv_read()` 只读一层 varint，会多带 2 字节——§2.6 已记录。）

解析出 **25 个键**，其中包括：

| 键 | 长度 | 用途 |
| --- | --- | --- |
| `accessToken` | 1306 | XTee 信封密文（base64） |
| `refreshToken` | 1306 | 同上 |
| `tee_id` | 65 | 设备 tee 标识，跨请求恒定 |
| `XTeeEncryptAesKey` | 346 | base64 → 256B，RSA-2048/PKCS1v15 密文 |
| `XTeeSecurityIv` | 25 | base64 → 16B CBC IV |
| `XmartV1LocalKey0..9` | 45 | 10 把密钥槽 |
| `IndivKeySet` | 45 | 个体密钥集 |
| `k_s_u_m_a_p/_u/_n/_c/_e` | 45/89/6 | 指纹/生物识别相关 |
| `VERIFY_CODE#<VIN>` | 89 | 车辆验证码 |
| `KEY_MQTT_ACCOUNT_UID` | 4 | MQTT 账号 |

#### 6.39b　这解决了「密钥材料拿不到」的问题

§6.38 的结论是 `salt`/`ikm` 被三重保护挡住。但**密钥材料本身不需要破解**：

```
XTeeEncryptAesKey  -> RSA-2048/PKCS1v15 密文（256B）
                    -> 用 KeyStore alias XTeeSecurityAlias 的私钥解
                    -> 得到 16B AES-128 密钥
XTeeSecurityIv     -> 16B CBC IV
```

模拟器 userdebug 下私钥可从 `/data/misc/keystore/persistent.sqlite` 的 `blobentry`
（`subcomponent_type=0`，切片 `b[5:5+4+int.from_bytes(b[7:9],'big')]` 即 DER）取出。

#### 6.39c　`unseal-token.py` 跑通，但拿到的是历史值

```
accessToken : 968 B  eyJ0eXBlIjoxLCJ2ZXJzaW9uIjoiMS4wLjAiLCJhbGciOiJI…
refreshToken: 968 B  eyJ0eXBlIjoxLCJ2ZXJzaW9uIjoiMS4wLjAiLCJhbGciOiJI…
两者不同     : True
```

解封成功，但打业务接口仍 `12010101`，续期返回 `12010204`——
**MMKV 里存的是历史 token，已过期**（§4.8 记录过这个坑）。

#### 6.39d　仍需一次真实登录

`tee` 里的 AT/RT 已失效，要恢复服务端探测必须重新登录一次。
设备上的 App 仍在登录态，但它写入 MMKV 的是同一批过期值（App 靠内存态维持，未回写新 token）。

#### 6.39e　对主目标的意义

`ble_cache_data`（13.6KB，加密）仍未解开，但**加密它的 cryptKey 与 XTee 无关**——
`"xp$#!)01"` 是独立的 MMKV cryptKey 片段（9 字节，真实值 16 字节，运行时拼接）。
这条线仍未打通。

### 6.40　`XpVehicle.db` 里有完整指令帧库（99 条）与全部钥匙元数据

#### 6.40a　`xp_vehicle_xp_key_message`：99 条服务端下发的车控帧

> 已提升到 §6.25e。
#### 6.40b　`xp_vehicle_keys.key_info`：钥匙元数据，但没有 keyId

```json
{"cardNo":"B11793348306580","cardType":103,"deviceId":"d2c729...","userId":25400867,
 "vin":"L1NSPGH91NA142515","status":1,"shareFrom":2389771,"effectiveTime":29889138,
 "validTime":82449138,"keyDfkStatus":0,"isDeviceSupport":false,"isFromInit":false}
```

**22 个字段里没有 `keyId`**，也没有任何能对上 `getEmergencyAuthData` 的标识。

#### 6.40c　`xp_vehicle_mac.mac_info`：完整 BLE 拓扑

```json
{"hv":"H.2","macAddress":"00:60:37:85:b9:d0","partNo":"8810005DF10000",
 "slaveMacList":[
   {"name":"BLEFR","mac":"dc:0d:30:b0:94:c4","hv":"H.3","partNo":"8810016DG10000"},
   {"name":"BLER", "mac":"dc:0d:30:b0:c4:a4","hv":"H.3","partNo":"8810017DG10000"},
   {"name":"BLEFL","mac":"dc:0d:30:b0:79:01","hv":"H.3","partNo":"8810016DG10000"}],
 "uid":25400867,"vin":"L1NSPGH91NA142515"}
```

**注意 `BLEFR` 的 MAC `dc:0d:30:b0:94:c4` 正是之前 Mac 直连成功的那个 `XPED-DC0D30B094C4`**——
它不是别人的车，是本车主驾侧从模块（§6.34 的误判在此彻底纠正）。

#### 6.40d　数据库其他表

| 表 | 行数 | 内容 |
| --- | --- | --- |
| `xp_vehicle_keys` | 1 | 钥匙元数据 |
| `xp_vehicle_xp_key_message` | 99 | 指令帧缓存 |
| `xp_vehicle_mac` | 1 | BLE 拓扑 |
| `xp_vehicle` | 1 | 车辆档案（`cduId` 等） |
| `xp_vehicle_key3_message` | 0 | 空 |
| `xp_vehicle_cert_key_message` | 0 | 空 |

### 6.41　新手段：`am dumpheap` 绕过 frida 的 ptrace 保护

> 内容已并入 §6.23a（`am dumpheap` 绕过 ptrace 保护）。

### 6.42　31 个会话的完整握手时序（btsnoop 全量统计）

#### 6.42a　会话切分

以 `handle 0x0010` 写 `0200`（CCCD 开启 notify）为界，`btsnoop_full.log`（16417 条 HCI 记录）里
**正好 31 个会话**，与会话数完全对应：

```
handle 0x0010 写 0200 : 31 次   ← 每连接一次
handle 0x000c 写 ef01 : 62 次   ← 31 × 2（ef0104 + ef0110）
handle 0x000c 写 ed11 : 33 次   ← 31 次 ed1118 + 2 次 ed118b
handle 0x000c 写 ec11 : 1 次    ← ec110f
```

#### 6.42b　30 个会话是「只握手」，1 个是「真车控」

**30 个会话的固定形态**（后台探测/保活）：

```
ef0104 <app_n 4B>       7 B
ef0110 <R12 16B>       19 B
ed1118 <24B>           27 B
```

**1 个会话（真实点击解锁/上锁）**：

```
ef0104 5b…              7 B    握手 1
ef0110 9c…             19 B    握手 2
ed1118 …               27 B    能力协商
ed118b <cmd=0x01>     142 B    解锁
ec110f <18B>           18 B    中间状态
ed118b <cmd=0x02>     142 B    上锁
```

**这确认了指令通道是 `ed118b`（142 B 定长），`ed1118` 只是握手第 3 帧，不是指令。**

#### 6.42b-1　`ed118b` 的 142 字节逐段结构（2026-11-04 实测补全）

在车旁点「车锁」（`uiautomator` 坐标 `(168,1018)`，即 `iv_top_icon[113,963][223,1073]`）
抓到一条完整的 142 B `ed118b`：

```
ed 11 8b 00 84                                    帧头
9d 2b 75 8e                                       crc32（覆盖 payload）
01                                                type
58 50 42 4b                                       'XPBK' 魔数
54 48                                             'TH'
01 00 00
83 6a e9 f3
d1 00
05 4b 49 00
10 12 a7 74 ba 5b 82 bd db 8b ae 97 3e 35 be d8 e8   子模块 KI（16B，明文）
45 44 00 10
ad 95 8d 95 06 55 c3 a8 a7 68 71 bc c2 49 06      16B
55 53
4e 00
47                                                DER 长度（71）
30 45 02 20 238b7971…5982 02 21 0094a8b0…0afe    ECDSA DER 签名
01                                                帧尾
```

`70 + 71 + 1 = 142`，与帧长吻合。

**签名可直接用标准库解析**（`cryptography.hazmat.primitives.asymmetric.utils.decode_dss_signature`）：

| 项 | 值 |
| --- | --- |
| `r` | `238b79711e6e3abed04b52eeb6d98815689e7b86f215315bea761827dfee5982`（254 bit） |
| `s` | `0094a8b0fd35551252e18a1fb19f9f11ebb8c21e9e5a8439fa09b26c4605380afe`（256 bit） |

`r` 254 位、`s` 256 位、DER 共 71 字节 —— **P-256 (secp256r1) ECDSA**。

**两个此前不知道的事实：**

1. **载荷是明文，不是 AES 密文。** KI `12a774ba5b82bddb8bae973e35bed8e8` 直接以明文出现在帧里。
   这个值在第 8、9 轮被我当作「候选 HKDF salt」反复试过而不知其来历——它就是子模块数字钥匙 KI。
2. **`ed118b` 不依赖 `ed1118`。** 它自带明文 KI 与 ECDSA 签名，是独立指令帧。
   两者并列，不是先后依赖。

`libbledata.so` 里**没有** ECDSA 签名函数（`nm -D | grep -iE "sign|ecdsa|p256"` 无命中），
签名在 Java 层完成。

**帧头结构已用三条独立帧交叉验证**：

| 帧 | `[0:5]` | `[5:9]` **crc32** | `[9]` type | `[10:14]` |
| --- | --- | --- | --- | --- |
| 历史解锁 | `ed118b0084` | `425b88d0` | `01` | `5850424b` = `XPBK` |
| 历史上锁 | `ed118b0084` | `5bdbe2ed` | `02` | `5850424b` = `XPBK` |
| 本轮车锁 | `ed118b0084` | `9d2b758e` | `01` | `5850424b` = `XPBK` |

`5850424b` 在三条帧里完全一致，是 ASCII **`XPBK`**（小鹏蓝牙钥匙）魔数。

> **2026-11-04 纠正：`[5:9]` 是 crc32，不是 nonce。**
>
> 早先几轮把这里标成「nonce」，并据此推断「同 nonce 密文相同」「nonce 每帧不同」。
> 实际是 CRC 覆盖 payload（`crc32_init0`，init=0、无最终异或）。
> `parse_tbox` 的实现一直是对的，是手工标注读错了字段。
> 受影响的只是字段名，结论（同一会话重发 `ed1118` 字节一致）不变。
>
> 这个误判还造成一次实测事故：生成命令帧时执行 `f[5:9] = os.urandom(4)`
> 想把「nonce」换掉，实际把 CRC 改成随机值，帧随即非法、被车端静默丢弃。

#### 6.42b-3　服务端 authData 的 `[14:16]` 是序号，不是命令码

**逐字节证据。** 2026-11-04 车旁抓到的那条 `ed118b`，去掉外层 10 B 后是 132 B 内层。
在 `work/live/pixel/XpVehicle.db` 的 99 条 authData 里按 ED 字段反查，命中 **id=5**：

```
srv  (131B) 5850424b5448010000836ae9f3d10005 4b49001012a774ba…5380afe
real (132B) 5850424b5448010000836ae9f3d10005 4b49001012a774ba…5380afe 01
             ↑ 前 131 字节完全相同，只多末尾 1 字节 cmd
```

**即 `帧内层 = 服务端 authData 原样 + 末尾 1 字节命令码`，`[14:16]` 不做任何改写。**

`[14:16]` 在全部 99 条里**恒等于该条记录的数据库主键**（99/99 吻合），它是序号。

| 字段 | 偏移 | 含义 |
| --- | --- | --- |
| `len` | `[8:10]` | authData 长度的 16 位大端；`0x82/0x83/0x84` 分别是 130/131/132 B 的低字节，不是操作类型或方向码（2026-11-06 五次逐动作抓包复核） |
| `r4` | `[10:14]` | `6ae9f3d1`（与真实帧一致） |
| `seq` | `[14:16]` | 服务端序号 = 数据库主键 |
| TLV | `[16:]` | `KI`(16) / `ED`(16) / `SN`(ECDSA DER) |

#### 6.42b-4　推翻「`flag_byte = cmd + 0x52`」这条旧规则

旧结论来自 §6.20a 的 7 帧实测，但那是**巧合**：11-01 抓到的解锁/上锁两帧
恰好对应服务端 `id=83`（`0x53` = `'S'`）和 `id=84`（`0x54` = `'T'`），
于是被误读成「`cmd + 0x52`」。

决定性反例：11-04 的真实帧对应 `id=5`，该位置是 `0x05`，
按旧规则应算出 `0x53`，实际不是。

`scripts/ble_frame.py` 因此改了两处：

- `parse_server_auth_data` 把 `[14:16]` 解析成 `seq`（原来叫 `cmd`）；
- `to_app_inner` 改为「原样保留 131 B + 末尾追加 cmd」，命令码由 `flag` 经
  `FLAG_TO_CMD` 映射得到，不再改写 `[14:16]`。

#### 6.42b-5　验证脚本原先的盲区

`verify-server-frames.py` 之前只校验 `roundtrip`（切出来再拼回去）与 `crc32`，
**不校验字段语义**，所以 99/99 PASS 掩盖了上述错误。

现已改为正向判据：`_find_auth_data_by_seq(0x05, want_ed=…)` 从库里取出真实
authData，断言 `authData + cmd == 帧内层`，该断言现为 `True`。

#### 6.42b-2　为什么前几轮一直抓不到 `ed118b`

点击坐标错了。首页车控图标 `TextView` 全是 `clickable=false`，真正可点的是父容器
`iv_top_icon`：

| 控件 | bounds |
| --- | --- |
| 车锁 | `[113,963][223,1073]` |
| 车窗 | `[361,963][471,1073]` |
| 后备箱 | `[609,963][719,1073]` |
| 直线召唤 | `[857,963][967,1073]` |

此前点 `y=830`（车辆图片区域），所以 BLE 流量为 0、界面无反应，
一度误判为「车控走云端」。

#### 6.42c　由此推翻此前对 `ed1118` 的定位

§6.19 曾把 `ed1118` 当作「能力表请求」，实际它是**握手的第三步**，每次连接必发且仅发一次。
`ed118b` 才是承载 `XPBKTH` 帧的指令通道。

#### 6.42d　31 组会话数据已归档

`work/ble_capture/sessions.json`：每条含 `writes[]`、`app_n`、`r12`、`ed1118`、`cmd[]`、`ec[]`。
其中 31 组 `app_n`+`r12`、31 个 `ed1118`、1 组指令帧，可直接用于算法验证。

### 6.44　`TestBleKeyV3Activity` 是可直接启动的握手调试入口

#### 6.44a　入口可绕过 launcher 直接启动

> 已提升到 §6.23b。
#### 6.44b　点击后拿到的真实类名（明文 dex 内）

```
java.lang.IllegalArgumentException: Empty key
  at javax.crypto.spec.SecretKeySpec.<init>(SecretKeySpec.java:96)
  at com.xiaopeng.mycarinfo.protocol.xp_ble.BleV3EtxKt.encryptCbc(SourceFile:16)
  at com.xiaopeng.mycarinfo.protocol.xp_ble.RkeRequest.getData(SourceFile:90)
  at com.xiaopeng.mycarinfo.protocol.xp_ble.RkeRequest.getPackage(SourceFile:15)
  at com.xiaopeng.common.car.home.presenter.RkeManager$rkeRequest$1.invokeSuspend(SourceFile:78)
```

配套的 Binder 失败链：

```
com.xiaopeng.common.car.ble.ipc.NoBinderException: BLE#BINDER_NAME_BLE_COMMON_SERVICE cannot found
  at …BleCommonServiceUtil.getDefault(SourceFile:20)
  at …BleCommonServiceUtil.sendData(SourceFile:6)
  at …BleKeyConnectionManager.sendData(SourceFile:2)
```

**两个关键类**：
- `BleV3EtxKt.encryptCbc(byte[], byte[])` —— V3 的 CBC 加密入口，**密钥为空时报 `Empty key`**
- `RkeManager` / `RkeRequest` —— RKE（遥控钥匙）请求构造，走 `ed118b` 通道

#### 6.44c　完整协议类清单（堆里确认存在）

```
com.xiaopeng.mycarinfo.protocol.xp_ble.{
  Auth0Request, Auth0Request$Companion, Auth0Response,
  Auth1Request, Auth1Response,
  AuthToken, BleV3EtxKt, BleV3EtxKt$toBinaryString$1, BleV3EtxKt$toHexString$1,
  DataPacket, IRequest, IResponse, AppToBle, AdjustBle, RkeRequest, RkeResponse
}
```

**`AuthToken` 类名出现 27 次，但全是系统 `TRANSACTION_*AuthToken` 字符串**，App 自己的实例未在堆中留存。

#### 6.44d　点击 AUTH0_REQ / AUTH1_REQ 不产生帧

实测流程：

```
1. am start TestBleKeyV3Activity            → 成功
2. tap AUTH0_REQ (378,1052)                 → 无异常
3. tap AUTH1_REQ (820,1052)                 → 无异常
4. am dumpheap → 90.8 MB
5. 搜 KI 原始字节 / KI hex / 31 组 r12      → 全部 0 命中
```

**原因**：握手帧的构造需要 `BleKeyConnectionManager` 的活连接上下文，
`NoBinderException: BLE#BINDER_NAME_BLE_COMMON_SERVICE cannot found` 说明 BLE Binder 服务在模拟器上没注册成功。
按钮只是走了一遍代码路径，没有真正算出 R12。

#### 6.44e　这一步的价值

即使算不出 R12，`TestBleKeyV3Activity` 提供了三个此前没有的东西：

1. **可手动触发的握手代码路径**（不再依赖 App 主流程的扫描/连接）
2. **`BleV3EtxKt.encryptCbc` 的确切签名与失败模式**（空密钥 → `Empty key`）
3. **`RkeManager` / `RkeRequest` 的调用链**，确认 RKE 指令走 `ed118b` 且需要 CBC 加密的 key

下一步只要让 `BleCommonService` 在模拟器上注册成功，握手就能在这里真正跑起来。

### 6.46　改 `XpVehicle.db` 的 MAC 能让 App 转向任意设备（已实测生效）

#### 6.46a　这是一个真实有效的控制点

```sql
-- xp_vehicle_mac.mac_info
{"hv":"H.2","macAddress":"00:60:37:85:b9:d0","partNo":"8810005DF10000",
 "slaveMacList":[…],"uid":25400867,"vin":"L1NSPGH91NA142515"}
```

把 `macAddress` 改成假车地址、推回设备、重启 App 后，系统蓝牙栈的日志**立刻转向**：

```
改之前: btif_gattc_open_impl: address=xx:xx:xx:xx:b9:d0   （真车）
改之后: btif_gattc_open_impl: address=xx:xx:xx:xx:aa:90   （假车）
```

**App 的连接目标完全由这个数据库字段决定，不重新从服务端拉取。**
（前提是 `getBleInfo` 没被调用；一旦联网拉取会被覆盖。）

#### 6.46b　假车侧确认 GATT 链路完全可用

`ScanProbe`（无过滤扫描）连上假车后的完整流程：

```
ScanProbe: chr 0000ed28-abab-9c8c-2801-b1a015e46d6c props=12
ScanProbe: chr 0000ed28-abab-9c8c-2802-d3df573ff530 props=32
ScanProbe: subscribe true
ScanProbe: write handshake frame=true
ScanProbe: write ack status=0

fakecar: [conn] 6e:5a:5a:6f:19:84 -> CONNECTION_STATE_CONNECTED
fakecar: <- WRITE #1 (7B) ef01048fe82373
fakecar: -> INDICATE (4B) d5f60359
```

**假车能收 `ef0104`、能回 `car_n`，GATT 服务树与真车一致。**

#### 6.46c　唯一的拦路石：假车 MAC 不可控

| 事实 | 证据 |
| --- | --- |
| `GattDevice` 无 address 字段 | proto 只有 `endpoint`/`advertisement`/`profile` |
| `Endpoint` 无地址提示 | 只有 `target`/`tls_credentials`/`required_headers` |
| `RegistrationStatus` 只回 `CallbackIdentifier{identity}` | identity 是数字（如 `69156`），不是 MAC |
| `ConnectionStateChange.from_device` 是**客户端**地址 | 假车自己的地址在协议里完全不存在 |
| netsimd 无固定地址选项 | `--help` 只有 `-s/-c/-i/-l/-d/--no-cli-ui/…` |

**每次重新注册，假车的 MAC 都会变**（实测 `47:2e:42:05:aa:90` → `6e:5a:5a:6f:19:84`），
所以数据库里写死的 MAC 必然在下一次注册后失效。

#### 6.46d　因此当前状态是「只差一个稳定地址」

链路三段全部打通：

```
App → (DB MAC) → 系统蓝牙栈 → 假车 GATT → ef0104 → car_n 回包
```

缺的只是「让假车地址固定下来」或「让 App 走扫描而不是 MAC 直连」。

#### 6.46e　App 扫描侧用的是硬件白名单

```
LE_ADD_DEVICE_TO_FILTER_ACCEPT_LIST(0x2011)   ← 加入白名单
LE_REMOVE_DEVICE_FROM_FILTER_ACCEPT_LIST(0x2012)
```

App 把目标 MAC 加进 HCI 接受列表做硬件过滤。**这解释了为什么假车名字正确也扫不到**——
广播里既没有 service UUID，地址又不在接受列表里。

但反过来，**只要数据库 MAC = 假车当前 MAC，这条白名单就会放行**，扫描和直连都能成立。

### 6.47　握手在假车上完整跑通：根因是 recv 特征缺 NOTIFY 位

> 内容已并入 §6.24a（recv 特征需 NOTIFY 位）、§6.24b（完整握手实录）。

### 6.48　KI 不在任何进程堆里，且与云端下发值不同

#### 6.48a　两个进程的堆都搜不到 KI

| 进程 | 堆大小 | `KI` 原始字节 | `KI` hex | 握手密文 |
| --- | --- | --- | --- | --- |
| `:BLE` (pid 3825) | 61.4 MB | 0 | 0 | `8c2d9d66…` 命中 2 次 |
| 主进程 (pid 3682) | 83.0 MB | 0 | 0 | 0 |

**`KI = 12a774…d8e8`（云端 `createKeyCard` 下发值）在两个进程里都不存在。**
这解释了为什么 6.47e 里所有以它为密钥的 KDF 尝试全部落空——
App 实际使用的密钥不是那个值。

#### 6.48b　但握手帧的完整结构在堆里可见

```
02b0ad30 00000000 00000007 08 ef0104 0b5a17b1 21 02b0ad48 00000000 6f6b49c8 00000014 1bbe3d88 …
```

`08 ef0104 <app_n>` 是帧头，长度 `0x07`。`ef0110` 帧同样可见：

```
00000013 08 ef0110 8c2d9d6660e31bb0784630126fa1f3df 21 02b0b4e0 00000000 6f709978 …
```

长度 `0x13`（19 字节）。**帧本身在堆里是明文，密钥不在。**

#### 6.48c　密钥只在 MMKV 解密的那一瞬间存在

`libmmkv.so`（base `0x6faed10000`）导出：

```
cryptKey            @ +0x3d704
checkReSetCryptKey  @ +0x3d7f4
```

`cryptKey` 是 getter，不是解密入口。MMKV 在**实例构造时**用 cryptKey 把整个文件解密进内存，
之后明文只存在于 `MMKV` 对象的内部 map 里，用完即散。
所以「dump 堆找 KI」这条路本质上抓不到——除非在构造那一刻 hook。

#### 6.48d　`:BLE` 进程 pid 极不稳定

连续观察：3825 → 4622 → 4779 → 4900，每次触发都换 pid。
attach 的窗口只有几秒，且 `Java` 桥在该进程不可用（易盾屏蔽），
只能走 native hook。

#### 6.48e　当前状态

已确认可复现的事实链：

1. App 登录后，进入 `TestBleKeyV3Activity` 点「启动BLE」，会连上指定 MAC
2. 特征属性为 `0x30`（NOTIFY|INDICATE）时，App 自动走完 `ef0104 → ef0110 → ed1118`
3. `ef0110` 是 `(KI_actual, app_n)` 的确定性函数，`car_n` 不参与
4. `KI_actual ≠ 云端下发的 KI`
5. 假车可控 `car_n`，因此可批量采集三元组做离线 KDF 求解

**缺口收敛到一个点**：`KI_actual` 的值，或者 KDF 的确切构造。

### 6.50　车端挑战窗口约 2.0–2.5 秒，实时接力路线被卡死

#### 6.50a　延迟发送 ef0110 的实测结果

> 已提升到 §6.19c。
#### 6.50b　这个窗口否掉了「实时 oracle」架构

要在窗口内算出 `ef0110`，必须：

```
连真车 → 收 car_n → 断开 → 连假车 → 喂 car_n → App 算出 ef0110 → 断开 → 重连真车发送
```

两个 BLE 设备不能同时连（§6.24d 已证），往返至少两次连接建立（每次约 1–2 s），
**远超 2 秒窗口**。所以这条路在单适配器上不可行。

#### 6.50c　区分两个错误码

| result | 触发条件 |
| --- | --- |
| `0x0e` | 挑战匹配但 `ef0110` 算错（密钥不对） |
| `0x06` | 超时，或握手未完成就写后续帧（§6.39 直写车控帧也是 `0x06`） |

这个区分很重要：`0x0e` 说明流程走对了、只是密钥错；`0x06` 说明时机或顺序错。

#### 6.50d　:BLE 进程生命周期是反复出现的工作障碍

实测 pid 序列：`3825 → 4622 → 4779 → 4900 → 6663 → 6952 → 7050 → None`。
每次触发操作都会换 pid，闲置即退出。加上易盾屏蔽 Java 桥，
`Java.perform` 在该进程不可用（`ReferenceError: 'Java' is not defined`），
只能做 native hook，且 attach 窗口只有数秒。

#### 6.50e　libmmkv.so 的静态特征

```
base 0x6f5915d000 / size 630784
导出符号以 libc++ 标准库为主，MMKV 业务函数名已被 strip
cryptKey @ +0x3d704（getter，非解密入口）
checkReSetCryptKey @ +0x3d7f4
AES S-box 在该模块内扫描不到 → 加密实现不在 libmmkv，或表被混淆
```

### 6.51　libbledata 的认证符号全部定位，但 hook 窗口抓不住

#### 6.51a　关键导出符号（`libbledata.so`，`:BLE` 进程）

```
getAuth1FactorTlvData                     @ +0x8ed74   ← 构造 ef0110 的 TLV
getHmacKey                                @ +0xa0400
generateAuth0DataV3                       @ +0xa1754   ← 构造 ef0104
createAuthKey                             (无偏移前缀，C 导出)
createBleKeyV3RkeRequestWithInput         @ +0x8f610
createBleKeyV3RkeControlRequestWithInput  @ +0x8fc20
getRKEDataWithRkeType                     @ +0x8f164
handleXPBleKeyV3Content                   @ +0x8e634
BleKeyV3DataParser::parse                 @ +0x95e6c
BleKeyV3DataParser::parseCommonCarState   @ +0x95838
BleKeyV3DataParser::parseChargeState      @ +0x95ac4
BleKeyV3DataParser::buildCommonResponseMessage @ +0x9469c
SDKBleKeyV3::isEffectiveBLEKeyV3MessageData    @ +0x90c60
SDKBleKeyV3::sizeOfBLEKeyV3Message             @ +0x90c54
createKeyStringCommandPayloadV3                @ +0x8aae0
SDKBleKeyV3::BLERescueKeyData::xorData         @ +0x88fe4
```

**`getAuth1FactorTlvData` 是 `ef0110` 的直接构造点**，`generateAuth0DataV3` 是 `ef0104` 的。
这两个函数拿到了就等于拿到了握手算法的入口。

#### 6.51b　只有 `:BLE` 加载 libbledata

| 进程 | libbledata 映射数 |
| --- | --- |
| 主进程 `com.xiaopeng.mycarinfo` | 0 |
| `:BLE` | 3 |
| `:core` / `:data_provider` | 0 |

所以握手计算确实在 `:BLE` 里，不在主进程。

#### 6.51c　但 hook 抓不住调用

挂上全部 7 个认证相关函数后，触发 `启动BLE` + `解锁`，假车侧握手完整跑通
（`ef0104 → ef0110 → 080001 → ed1118`），**hook 一次都没触发**。

原因：`:BLE` 进程在 hook 之后、握手之前被系统替换了。
实测 pid 序列：`8068`（hook 的）→ `8224`（真正握手的）→ `8391` → `None`。

#### 6.51d　对全部导出挂 Interceptor 会断连

对 `libbledata.so` 的全部导出（含 C++ 模板符号）批量 `Interceptor.attach`，
frida 直接抛 `TransportError: the connection is closed`。
必须按名字筛选，只挂目标函数。

#### 6.51e　下一步的两个可行方向

1. **spawn + child-gating**：用 `frida -f` 以 child-gating 模式启动主进程，
   在 `:BLE` 被 fork 出来时立即 attach，赶在握手前挂好 hook
2. **静态分析 `getAuth1FactorTlvData`**：既然符号和偏移都有了，
   直接反汇编 `+0x8ed74` 看它如何用 `(KI, app_n, car_n)` 生成 16 字节，
   不再依赖动态 hook

### 6.52　桥接架构打通：App 自己算 ef0110，真车自己验，不需要破解 KDF

> 内容已并入 §8.2（挂在官方进程上）。

### 6.53　桥接链路的边界：能过算法，过不了钥匙归属

> 内容已并入 §6.23c（hook 抓不到的真实原因）。

### 6.54　模拟器数据库里躺着 99 条完整车控帧（明文 KI + ED + 签名）

#### 6.54a　`xp_vehicle_xp_key_message` 表就是帧缓存

App 每次向 `getXpKeyAuthData` 取帧都会落库，表里累计 99 条。
`token_json.message` 是 base64，解开就是完整的 131 字节帧，**全部明文**：

```
XPBKTH                          magic
01 00 00 83 6a e8 ab c5 00      9B 头部（0x0083 = authData 长度 131，非解锁指令）
64                              1B 服务端序号低字节
KI 00 10 12a774ba5b82bddb8bae973e35bed8e8      tag "KI", len 0x0010
ED 00 10 68a2bc47a2e6651b3a6cde181a248701      tag "ED", len 0x0010
SN 00 47 30450221008a674c85bc30cee35439229e0729bb71...  tag "SN", len 0x0047
```

**KI、ED、ECDSA 签名三者齐全，且是明文。** 服务端持有私钥代签，客户端不需要私钥。

#### 6.54b　但这些都是子账号的钥匙

99 条全部 `KI = 12a774ba…`，即模拟器登录的子账号。
车端只认主账号 `7a32fc31…`（§6.34g 实测），所以这些帧写进去仍然是 `08000e`。

#### 6.54c　子账号为什么激活不了

`ble/activate` 强制要求 `ifaaRequest`（IFAA 指纹/人脸认证），
模拟器无生物识别硬件，这条路在模拟器上不通。
`ble/create` 只写服务端记录，不产生 `hasBleKey: true`。

#### 6.54d　手机侧的状态

手机上官方 App 登录的是**主账号且已激活**，`dumpsys bluetooth_manager` 持续显示
`BLE-CONNECTED … XPED-0060 status = Success`，说明主账号握手一直在正常发生。

手机无 root，`/data/data/com.xiaopeng.mycarinfo` 与 `/data/misc/bluetooth/logs/` 都读不到。
shell 具备 `net_bt` / `net_bt_admin`，Shizuku 已安装但未运行。

#### 6.54e　当前唯一缺口

不是算法，不是链路，不是时机，是**让车端认可某个 uid**。
两条路都要主账号的钥匙材料：

| 路径 | 前提 | 障碍 |
| --- | --- | --- |
| 模拟器登主账号 | 主账号已激活 | 会顶掉手机 App |
| 从手机取主账号帧 | 需读 App 私有目录或 HCI 日志 | 无 root |

### 6.55　主进程可见但 attach 被拒（易盾反调试的第二层）

#### 6.55a　与之前判断的差异

之前记录「主进程对 frida 不可见」。本轮实测更精确：

| 阶段 | frida `enumerate_processes()` | `attach` |
| --- | --- | --- |
| App 刚启动 | 不出现 | — |
| App 稳定运行后 | **出现**（132 个进程里能看到 `com.xiaopeng.mycarinfo`，pid 5733） | **`ProcessNotFoundError`** |

所以不是「看不见」，而是**看得到、连不上**。
`enumerate_processes` 走 `/proc` 枚举，attach 走 frida-server 的注入通道，易盾拦的是后者。

#### 6.55b　已排除的绕过方式

| 方式 | 结果 |
| --- | --- |
| 按名字查进程再 attach | `ProcessNotFoundError` |
| 按 adb `pidof` 拿到的 pid attach | `ProcessNotFoundError` |
| spawn 主进程 | 注入被挡，脚本不执行 |
| attach `:BLE` | 成功，但 `ef0110` 不在该进程计算 |

#### 6.55c　`:BLE` 的握手帧不驻留

用 frida 在 `:BLE` 内存里搜刚抓到的 `ef0110` 载荷（16 字节精确匹配），
扫描全部 `rw-` 区段，**0 命中**。帧写出去后即释放，不在堆上留存。

#### 6.55d　当前全部事实汇总

| 环节 | 状态 |
| --- | --- |
| 桥接链路 | ✅ 可用，64 次稳定，往返 150–200 ms |
| App 计算 `ef0110` | ✅ 正常，帧完整送到真车 |
| 车端窗口 | ✅ 2.0–2.5 s，桥接远快于此 |
| 子账号帧 | ✅ 服务端下发，KI/ED/签名齐全且明文（99 条） |
| 车端认可 | ❌ 只认主账号 `7a32fc31…` |
| 主账号材料 | ❌ 在手机上，无 root 取不到；模拟器登主账号会顶掉手机 |
| KDF 破解 | ❌ 金标准样本排除了全部结构假设 |

### 6.57　模拟器支持指纹，IFAA 不是硬件门槛（推翻 §6.34g 的阻断判断）

#### 6.57a　模拟器确实有指纹硬件

之前两轮把「模拟器无生物识别硬件」当作阻断点，本轮实测证伪：

```
$ adb shell pm list features | grep fingerprint
feature:android.hardware.fingerprint

$ adb shell dumpsys biometric
Sensors: ID(0), oemStrength: 15, modality 2, state: 0

$ adb shell locksettings set-pin 1234
Pin set to '1234'

$ adb shell emu finger touch 1        # 模拟触摸，返回 OK
$ adb shell dumpsys fingerprint
{"prints":[{"id":0,"count":1, ...}]}   # 录入成功
```

**结论：模拟器有完整的指纹传感器（modality 2），可录入、可校验。**
`ble/activate` 需要的生物认证在这台模拟器上是可满足的。

#### 6.57b　IFAA 在 App 里只是界面资源

`strings app.apk | grep -i ifaa` 只有 9 条，全是资源名：

```
ifaa_bule / ifaa_ccc / ifaa_gray_color / ifaa_cancel
ifaa_dialog_title / ifaa_input / ifaa_title / Powered by IFAA
```

**没有任何 `org.ifaa.android.manager` 类引用。**
所以 §6.35d 里「IFAA 是硬件级生物认证、模拟器无信任根」这个推论缺少证据——
App 没有集成 IFAA SDK，`ifaaRequest` 更可能是业务层自造的对象。

#### 6.57c　签名通道健康，缺的只是登录态（含一次自查纠错）

本轮曾误报「服务端签名通道已失效」，原因是调用了一个**不存在的路径** `/vehicle/v1/vehicles`。
该路径不在项目任何脚本与文档里，是凭空写的；服务端对未知路径返回
`HTTP 200` + `Content-Length: 0`，被误读成「签名被拒」。

用项目里真实使用的路径重测，一切正常：

| 请求 | 结果 | 含义 |
| --- | --- | --- |
| `/biz/v5/secure/teeIndiv4App` | `200` | 签名 + 密钥池正常 |
| `/biz/v5/vehicle/v2/myVehicles`（不带 token） | `12010103` | 信封解开、缺登录态（文档预期值） |
| `/biz/v5/vehicle/v2/myVehicles`（带 token） | `12010104` | token 已过期 |
| `/sso/app/v3/token/refresh`（带 RT） | `12010203` | refresh token 也已失效 |

**正确端点列表**（从 `scripts/` 提取，勿再臆造）：
`/biz/v5/secure/teeIndiv4App`、`/biz/v5/vehicle/v2/myVehicles`、
`/biz/v5/mqtt/createMqttAccount/app`、`/sso/app/v3/token/refresh`、
`/sso/app/v5/smsLogin`、`/verification/app/v5/sms/code`、
`/verification/app/v3/sms/validate`、`/verification/app/v3/drag/validate`、
`/digital-key/v1/key/ble/getXpKeyAuthData`。

#### 6.57d　本轮确立的下一步

指纹可用 + IFAA 非硬件依赖，意味着**激活路径本身没有技术阻断**，
缺的只是有效登录态。重新登录子账号后即可测试 `ble/activate`。

### 6.58　deviceId 未同步是 12010104 的直接原因

#### 6.58a　两个 deviceId 不一致

> 已提升到 §4.6a。
#### 6.58b　但 token 本身也已过期

同步 deviceId 后仍是 `12010101`。按 §4.2 的记录，
`12010101` 的含义是**信封解开、token 读到、服务端判定过期**。

证据：`tee` 文件最后写入时间是 `04:26`，之后 App 没有再刷新过；
而 App 界面上的电量/续航仍在变化（377→389 km），那是**状态通道的推送**，不是 token 续期。

`/sso/app/v3/token/refresh` 带 RT 返回 `12010203`，说明 refresh token 同样过期。

#### 6.58c　结论

自研客户端要拿有效登录态，**必须重新走一次登录**（§4.2 的完整链路：
发码 → 验证码 → `drag/validate{sceneType:"LGN"}` → `smsLogin` → 解 `sData`）。
从磁盘捞 token 这条路在 token 过期后就断了，与 deviceId 无关。

### 6.59　首次拿到 31 组完整握手三元组（app_n + car_n + ef0110）

#### 6.59a　之前所有 KDF 验证都缺 car_n

`sessions.json` 里只有 `app_n` 和 `ef0110`，`car_n` 一直靠猜（曾误把 `r12` 当成 car_n，
实际 `r12` 就是 `ef0110` 载荷）。**没有 car_n 就无法构造明文，所有 KDF 假设都是在错的输入上验的。**

本轮从原始 btsnoop 直接解析 ATT 层，拿到了完整三元组：

```
op=0x12  handle=0x000c  ef0104 d4e5fee5          <- app_n
op=0x1d  handle=0x000f  ffdba7e0                 <- car_n（ATT 通知）
op=0x12  handle=0x000c  ef0110 92b71483...5afe   <- ef0110
```

解析要点（踩过的坑）：
- `op=0x1d` 是 **Handle Value Notification**，不是 `0x1b`（indicate）
- ATT 写入帧的 value 从 `a[3]` 开始（前 3 字节是 op + 2 字节 handle），不是 `a[4]`
- `120c00` 里的 `0c00` 是 handle 小端，容易误当成内容

31 组全部提取成功，落在 `work/ble_capture/handshake_pairs.json`：

```
["d4e5fee5", "ffdba7e0", "92b7148348c91f370a898d0ce5855afe"]
["712c7939", "59bfc55f", "e9675575cb8e9bdafffb78a60548ad9a"]
["1cc48c3f", "37aeb243", "d93194f3c547d8c93860308f6cf3212d"]
...
```

全部来自主账号、真车返回 `080001` 的成功会话。

#### 6.59b　用完整数据重测 KDF，仍然全不命中

用主账号 KI `7a32fc31ace4afd950b24f60eb9b2545` 与真实 `car_n` 重测：

| 候选 | 命中 |
| --- | --- |
| `HKDF(KI, "", app‖car)` | 0/31 |
| `HKDF(KI, "", car‖app)` | 0/31 |
| `HKDF(KI, app, car)` | 0/31 |
| `HMAC-SHA256(KI, app‖car)[:16]` | 0/31 |
| `MD5(KI‖app‖car)` | 0/31 |
| `SHA256(KI‖app‖car)[:16]` | 0/31 |

#### 6.59c　排除「固定前缀 XOR」

31 组里存在 3 对部分前缀相同的样本（`app_n` 前 2–3 字节相同）。
若 `ef0110 = TLV XOR 固定 keystream`，这些对的密文异或应当在共同前缀上全为 0：

```
pair 12,18  TLV1^TLV2 = 000000000000 0bf0510000a9e2d502   <- 前 6 字节相同
            ct1 ^ct2  = 1db286776f67 ca40accd9f3b1c358b5a   <- 前 6 字节各不相同
pair 4,29   TLV1^TLV2 = 000000000000 bf3acb00005cba9c1b
            ct1 ^ct2  = 2b81da480c70 ec4d265736c779b8d8e8
pair 9,10   TLV1^TLV2 = 000000000000 ae7b6500004fed3edf
            ct1 ^ct2  = 922f9b5934b6 a671e6bf5945c31bdaba
```

**明文相同的 6 个字节，密文却完全不同 → 不是逐字节异或，存在分组扩散。**
这排除了 §6.53b 里所有「XOR 类」假设，方向应转向分组密码（AES/SM4）或带扩散的 KDF 输出。

#### 6.59d　末字节不是校验

`ef0110` 是 16 字节，而 TLV 明文只有 15 字节。曾怀疑末字节是 CRC8，
用 sum / xor / CRC8（poly 0x07、0x31、0x9b、0xd5）逐一验证，**0/31 命中**。
所以 16 字节全是密码学输出，明文构造本身也还没定对。

#### 6.59e　下一步

有了 31 组真实三元组，可以做的验证第一次变得有意义：
- 若为 AES-ECB，同明文同密钥应产生同密文——但 31 组输入全不同，无法直接验证
- 可用假车固定 `car_n`（`FAKECAR_CHALLENGE` 环境变量已支持）制造**相同输入**，观察 `ef0110` 是否恒定
- 这一步需要 App 处于可连接状态，而当前 token 过期、`:BLE` 进程已退出

### 6.60　对照实验否掉「车端只认主账号」的直接证据（自查纠错）

#### 6.60a　两个帧、同一个拒绝码

直接向真车写两条完整车控帧（不完成握手）：

| 帧来源 | KI | 长度 | 车端响应 |
| --- | --- | --- | --- |
| 子账号（服务端下发） | `12a774ba…` | 131B | `08000600000000000000` |
| **主账号（真车接受过的原帧）** | `7a32fc31…` | 142B | `08000600000000000000` |

**主账号的帧——那条真车上确实执行过解锁的帧——不握手直接写，同样回 `0x06`。**

所以 `0x06` 只表示「当前连接未认证」，与钥匙归属无关。
§6.34g 里「子账号 KI 被车端拒绝（`0x06`）」这个对照表，
把「未握手」误读成了「钥匙不被认可」。

#### 6.60b　正确的判据是什么

按 §6.19c，`0x0800` 通道的结果字节含义：

| 值 | 含义 | 触发条件 |
| --- | --- | --- |
| `0x01` | 成功 | 握手完成 + 命令合法 |
| `0x06` | 未认证拒绝 | 没握手就发命令 |
| `0x0e` | 认证失败 | 握手发了但密钥/挑战不匹配 |

要判断钥匙归属，必须**先完成握手**再发帧，看回 `0x01` 还是 `0x0e`。
本轮两次实验都停在 `0x06`，因为都没握手——**结论作废，归属问题仍未验证**。

#### 6.60c　仍然成立的结论

「车端只认主账号」目前**没有直接证据**，它来自 §6.34g 的错误解读。
真正确证过的是：子账号的 `getXpKeyAuthData` 能拿到完整帧（§6.54），
且这些帧的 `KI` 与主账号不同（`12a774ba…` vs `7a32fc31…`）。
两者是否等价于「车端不认」，取决于 `ble/activate` 是否把该 `KI` 下发到车端——
这一点至今没有测过。

> 📌 **本节结论已被 §6.61 更新**：下一轮把样本扩到 188 组（主 31 + 子 157），
> 在**都完成握手**的前提下对照，得到「主账号 31/31 成功、子账号 155/157 `0x0e`」，
> 这才是钥匙归属的直接证据。本节的价值是纠正「`0x06` = 钥匙被拒」这个误读。

### 6.61　188 组三元组与两套 KI 的对照：钥匙归属终于有直接证据

#### 6.61a　数据集扩大到 188 组

| 来源 | 数量 | KI | 车端结果 |
| --- | --- | --- | --- |
| 真车抓包（主账号） | 31 | `7a32fc31…` | **`080001` 成功 31/31** |
| 桥接日志（子账号） | 157 | `12a774ba…` | **`08000e` 失败 155/157**（另 4 次 `0x06`） |

桥接日志解析出的三元组落在 `work/ble_capture/handshake_pairs_sub.json`。

**这是「车端只认主账号」的第一个直接证据**：
同样走完整握手、同样是 App 自己算的 `ef0110`，
唯一差别是 KI 不同，结果就分成 `0x01` 全成功与 `0x0e` 全失败。

§6.60 里「主账号帧也回 `0x06`」并不矛盾——那两次都没握手，
`0x06` 是未认证码，与这里的 `0x0e` 是不同层级。

#### 6.61b　三个结果码的层次现在清楚了

| 码 | 含义 | 判据 |
| --- | --- | --- |
| `0x01` | 成功 | 握手完成 + 钥匙被认可 |
| `0x06` | 未认证 | 没握手就发命令（主账号帧也一样） |
| `0x0e` | 认证失败 | 握手完成但钥匙/派生不匹配 |

#### 6.61c　子账号的 `ef0110` 是「算对了但钥匙不对」

155 次 `0x0e` 不是算法错误——App 用同一套代码算主账号的帧能过。
所以 `ef0110` 的派生依赖 KI，且子账号的 KI 未被车端登记。

这反过来印证：**破解 KDF 对达成目标没有帮助**。
即使算对了 `ef0110`，子账号的 KI 车端仍不认，结果还是 `0x0e`。

#### 6.61d　密文统计特征

188 组密文共 3008 字节：
- 卡方 226.0（df=255，均匀分布期望约 255）→ 完全随机，无明文泄漏
- 无任何一组密文包含 `app_n` 或 `car_n` 的原文
- 无轮转/反转关系

#### 6.61e　结论：唯一缺的是让车端登记子账号的钥匙

`ble/activate` 是唯一能把 KI 下发到车端的接口，它要求 `ifaaRequest`。
上一轮已确认模拟器**支持指纹录入**（§6.57a），所以这一步在技术上可行。
剩下的障碍是 HTTP 登录态——而 BLE 握手不需要它（KI 已缓存在本地）。

### 6.62　`calculateAuth1SessionKey` 完全解出：就是 MD5(app_n ‖ car_n)

#### 6.62a　符号与桩

```
000891e4  SDKBleKeyV3::calculateAuth1SessionKey(unsigned int, unsigned int, unsigned long*)
            b  0x114510  -> resc_calculateAuth1SessionKey 的 PLT
000a04a0  SDKBleKeyV3::resc_calculateAuth1SessionKey(unsigned int, unsigned int, unsigned long*)
```

`calculateAuth1SessionKey` 是个纯跳转桩，实现在 `resc_` 版本。签名只有两个 `unsigned int`，
正好是 `app_n` 和 `car_n`，**没有 KI、没有其他输入**。

#### 6.62b　逐条指令读出的算法

```
a04d4  mov w0,#8        ; malloc(8)
a04d8  lsr w8,w22,#8    ; w22 = 参数1 = app_n
a04e4  strb w22,[x0]    ; buf[0] = app_n & 0xff
a04e8  strb w8,[x0,#1]  ; buf[1] = (app_n>>8) & 0xff
a04ec  lsr w8,w22,#16
a04f8  strb w8,[x0,#2]  ; buf[2] = (app_n>>16) & 0xff
a04f4  lsr w9,w22,#24
a050c  strb w9,[x0,#3]  ; buf[3] = (app_n>>24) & 0xff
a04dc  lsr w9,w21,#8    ; w21 = 参数2 = car_n
a0500  strb w21,[x0,#4] ; buf[4..7] = car_n 小端
a0504  strb w8,[x0,#6]
a0510  strb w8,[x0,#7]
a0514  mov w0,#16       ; malloc(16)
a0524  MD5Init
a0534  MD5Update(ctx, buf, 8)
a0540  MD5Final(out)
a054c  *outLen = 16
```

**算法：`sessionKey = MD5(app_n 小端 4 字节 ‖ car_n 小端 4 字节)`，输出 16 字节。**

这是纯 MD5，**不含 KI**。

#### 6.62c　但它不等于 ef0110

用 31 组真实三元组验证，四种字节序组合全部无法还原出 TLV 头：

```
md5(raw,raw)=09777411...  ct^md5=9bc06092717a00cc87214abb0fb62caa   starts 7f52? False
md5(raw,rev)=77d21821...  ct^md5=e5650ca233997a95f15eafa973a0c740   False
md5(rev,raw)=bd26b800...  ct^md5=2f91ac838e174f37563bf25ef8f501a1   False
md5(rev,rev)=2630929d...  ct^md5=b487861e0e1e52a4738dfca65c9b52fc   False
```

所以 `calculateAuth1SessionKey` 不是 `ef0110` 的直接构造路径。

#### 6.62d　`getSessionKey` 才是真正的入口

```
000a0344  SDKBleKeyV3::getSessionKey(u8* out, size_t outLen, u32 a, u32 b,
                                    const u8* salt, size_t saltLen,
                                    const u8* ikm, size_t ikmLen)
a03a4  stp w24,w23,[x0]      ; info[0..7] = (参数3, 参数4) 两个 u32 小端
a03c0  bl hkdf_sha256_jni
```

调用 `hkdf_sha256_jni(out, outLen, salt, saltLen, ikm, ikmLen, info=8B, 8)`，
其中 **info 固定为 `[a 小端][b 小端]`**，`ikm` 和 `salt` 由调用方传入。

这与 §6.30 的「HKDF-SHA256 + info 为两个 u32 小端」判断一致，
缺的仍是 `ikm` / `salt` 两个实参的来源——它们在加固 Java 层。

#### 6.62e　用真实 car_n 重测 HKDF，仍不命中

这次输入终于正确了（此前所有测试都缺 car_n 或用了错的字节序）。
以 `info = app_n_LE ‖ car_n_LE`、`KI` 及若干变体作 ikm/salt，31 组全部 0 命中。

说明 `ikm` / `salt` 不是 KI 本身，也不是空值或零填充。

### 6.64　`generateSessionKey` 是唯一调用者，且它自己也追不到上游

#### 6.64a　调用链

```
generateSessionKey (0xa2150)  --唯一静态调用点-->  getSessionKey (0xa0344)
                                                      └─ hkdf_sha256_jni
```

`getSessionKey` 在整个 .so 里只有一处 `bl`（`0xa2220`），就在 `generateSessionKey` 内。

#### 6.64b　参数映射（逐条读出）

```
a21f0  ldr  w27,[x8]        ; x8 = *(0x122050)  输出长度
a21fc  bl   malloc
a2200  sxtw x5, w26         ; saltLen = 虚调用(参数3) 的返回值
a2204  sxtw x7, w24         ; ikmLen  = 虚调用(参数4) 的返回值
a2208  ldur w3, [x29,#-4]   ; b = 第 5 个入参
a220c  mov  x1, x28         ; outLen
a2210  mov  w2, w25         ; a = 第 4 个入参
a2214  mov  x4, x22         ; salt 指针
a2218  mov  x6, x23         ; ikm 指针
a2220  bl   getSessionKey
```

对应 `getSessionKey(out, outLen, a, b, salt, saltLen, ikm, ikmLen)`：
- `a`、`b` 是 `generateSessionKey` 的第 4、5 个入参（即两个 u32 挑战值）
- `salt`、`ikm` 是第 2、3 个入参的两个指针，**长度靠虚调用 `[vtable+0x558]` 求**
- 输出长度取自全局 `*(0x122050)`

#### 6.64c　上游断在这里

`generateSessionKey` 本身**没有静态调用者**（全 .so 搜 `bl 0xa2150` 为 0 条）。
说明它通过函数指针或虚表被调用，`salt` / `ikm` 的真实来源在调用它的对象里，
而这个对象由加固 Java 层构造。

**静态分析到此为止。** 再往下只能动态读，而动态读需要握手，握手需要有效登录态。

#### 6.64d　一个可离线验证的推测

`*(0x122050)` 是全局输出长度。若它在初始化时被写死成 16，
那 `sessionKey` 就是 16 字节，与 `ef0110` 等长——`getXorResult` 取
`min(dataLen, keyLen)`，两边都是 16 时输出 16 字节，正好解释长度。
`dataLen` 因此也必须是 16，即**明文不是 15 字节 TLV，而是 16 字节**。
这一点与本轮 §6.63a 的失败一致：所有用 15 字节 TLV 的假设都错了。

### 6.66　`salt`/`ikm` 来自运行时构造的虚表，静态路彻底到底

#### 6.66a　六个虚表槽

`generateSessionKey` 通过对象虚表取值，用到的槽位：

```
[x8, #0x50]   [x8, #0x558]   [x8, #0x580]
[x8, #0x5c0]  [x8, #0x600]   [x8, #0x680]
```

`0x5c0` 取指针、`0x558` 取长度，成对使用，正是 `salt` 和 `ikm` 的取法。

#### 6.66b　虚表静态为空

```
$ objdump -s -j .data.rel.ro libbledata.so
 11a390 00000000 ... （全零）
$ readelf -r libbledata.so | wc -l
0
```

`.data.rel.ro` 全是 0，且**没有任何重定位项**。
说明虚表由 native 代码在运行时 `new` 出来并逐槽赋值，
所以「哪个函数填 0x5c0」这个问题在静态层面没有答案。

#### 6.66c　相关校验字符串

```
0x4d3dc  "Session key cannot be empty"
0x4eee6  "AuthKey must be 16 bytes"
0x4fb05  "KeyID must be 16 bytes"
```

`AuthKey` 和 `KeyID` 都是 16 字节的独立实体，且都要做长度校验。
`AuthKey` 很可能就是 HKDF 的 `ikm`（16 字节），`KeyID` 可能是 `salt` 或标识。
但这些字符串**没有 `adrp` 直接引用**（扫描全 `.text` 为 0 命中），
同样是通过运行时结构访问。

#### 6.66d　用 MD5 当 key 的假设再次排除

把 `MD5(app_n_LE‖car_n_LE)` 当 key 反推明文，188 组样本在**每个字节位置**
都有 128–142 个不同值（接近均匀），固定明文应有的「每位置单一值」完全不存在。

#### 6.66e　固定挑战实验受阻

想让假车返回固定 `car_n`（`FAKECAR_CHALLENGE=11223344`）以制造受控输入，
但 App 按服务端下发的真车 MAC **直连**，不扫描假车，所以不会连上来。
这条路同样需要有效登录态（服务端下发假车 MAC）。

#### 6.66f　三条路的共同瓶颈

| 路线 | 需要 | 现状 |
| --- | --- | --- |
| 静态追 `ikm`/`salt` | 运行时虚表 | ❌ 无重定位，追不到 |
| 动态 hook 读实参 | 握手发生 | ❌ 登录态失效，不加载 so |
| 固定挑战造差分 | App 连假车 | ❌ 按服务端 MAC 直连 |

**三者都卡在「需要一个能用的登录态」。**

> ⚠️ **但这三条路即使全部走通，也不解决目标问题。** 见 §6.61c：
> 子账号的 `ef0110` 是「算对了但钥匙不对」，155 次 `0x0e` 与算法无关。
> 而自研客户端要解决的是「子账号/新设备如何被车端认可」，
> 真正的缺口是 `ble/activate`（§6.61e），不是 KDF。
> **所以本节列的三条路都不值得继续投入。**
> 真正的缺口是 `ble/activate`（§6.61e），不是 KDF。

### 6.67　Auth1 帧构造链完全解出：TLV 定长编码 + 循环异或

#### 6.67a　调用链

```
generateAuth1Packet(u32, const u8*, size_t, const u8*, size_t, size_t*)   0x8948c
  └─ BLERescueKeyData::generateAuth1Packet(u32, vector&, vector&)         0x88c80
       ├─ encryptAuth1Packet(vector&, u32, vector&)                       0x8a2ac
       │    ├─ BLEKeyTLV::addTLV(tag=1, u32)      ← app_n，定长 4 字节
       │    ├─ BLEKeyTLV::addTLV(tag=2, vector)   ← car_n
       │    ├─ BLEKeyTLV::addTLV(tag=0x7f52, …)   ← 外层
       │    └─ BLERescueKeyData::xorData(…)       ← 循环异或
       ├─ buildMsgIDPacket(2)
       └─ buildPacket(msgId, encrypted)
```

注意：`generateAuth1Packet` 走的是 **`BLERescueKeyData`（应急钥匙）** 实现，
正常路径与应急路径共用这套封装。

> ⚠️ **本节结论的适用边界**：`xorData` 的循环异或确实解出来了，但它属于
> **应急钥匙（Rescue）路径**。§6.59c 已用三对样本证明真实 `ef0110` 存在分组扩散
> （明文前 6 字节相同、密文完全不同），所以正常路径的 `ef0110` **不是**这个循环异或的输出。
> 本节价值在于搞清了 Rescue 路径的结构，不能当作正常握手的构造依据。

#### 6.67b　`xorData` 是标准循环异或

```
89048  ldp   x9,x10,[x21]     ; key 的 [begin,end)
89054  sub   x10,x10,x9       ; keyLen
89058  udiv  x11,x8,x10       ; i / keyLen
8905c  ldrb  w12,[x23,x8]     ; data[i]
89064  msub  x11,x11,x10,x8   ; i % keyLen
89068  ldrb  w11,[x9,x11]     ; key[i % keyLen]
8906c  eor   w11,w11,w12      ; data[i] ^ key[i%keyLen]
89070  strb  w11,[x22,x8]     ; out[i]
89074  add   x8,x8,#1
89078  cmp   x8,x20           ; 循环 x20 = data 长度
```

**`out[i] = data[i] XOR key[i % keyLen]`，长度等于 data 长度。**

#### 6.67c　TLV 编码是定长，不是 BER

`addTLV(vector&, tag(u8), u32)`：

```
84e5c  strb w1,[x21],#1    ; tag 1 字节
84fb4  mov  w8,#4
84fb8  strb w8,[x22],#1    ; 长度固定 1 字节 0x04
```

所以 `app_n` 的编码是 `01 04 <app_n 4 字节>`，`car_n` 是 `02 04 <car_n 4 字节>`，
外层是 `7f 52 <len> <inner>`。按此构造：

```
7f 52 0c 01 04 d4e5fee5 02 04 ffdba7e0        ← 15 字节
```

#### 6.67d　但 ef0110 是 16 字节，还差 1 字节

`xorData` 的输出长度等于输入长度，所以明文必是 16 字节。
`buildMsgIDPacket(2)` 在 `encryptAuth1Packet` 之后调用，**很可能就是那 1 字节前缀**。

验证：以 `pt = <prefix> + TLV` 反推 key，256 种前缀全部给出「每样本各不相同」的 key
（因为 key 本来就按 `car_n` 每轮派生），无法用「key 是否恒定」来定前缀。

反推出的 key 与 HKDF 的 36 种 `(salt, info)` 组合全部不匹配，
说明 `ikm` 不是 KI，或 info 里还有别的成分。

#### 6.67e　现在缺的只剩一个值

| 环节 | 状态 |
| --- | --- |
| TLV 构造 | ✅ `01 04 <app>` + `02 04 <car>`，外层 `7f 52` |
| 混淆算法 | ✅ 循环异或，`out[i]=data[i]^key[i%len]` |
| 明文长度 | ✅ 16（= TLV 15 + 1 字节 msgId 前缀） |
| **key 的来源** | ❌ `getSessionKey` 的 `ikm`/`salt` |
| 拿到 key 后的验证 | ✅ 188 组数据可立即验 |

**只要拿到一次 `sessionKey`，整套算法就能离线复现。**

### 6.69　5.19.0 内置「测试数字钥匙3.0」页面（新发现）

> 📌 本节补充 §6.44。§6.44 记录的是**该页在正常模拟器状态下可以直接 `am start`**，
> 并已实测点击无响应（`NoBinderException`）。本轮（第 24 轮）复现时，
> 模拟器处于 §6.71 描述的异常状态，**任何 activity 都无法启动**，
> 所以本节的「点击无响应」不能作为该页本身不可用的结论——两者叠加了环境故障。
> 以 §6.44d 的结论为准：按钮需要 `BleCommonService` 注册成功才会真正算帧。

#### 6.69a　页面与按钮

`com.xiaopeng.common.car.home.TestBleKeyV3Activity`，标题「测试数字钥匙3.0」，
一屏绿色按钮，全部与数字钥匙相关。精确坐标（1080×2400）：

```
支持V3      (169,454)    启动BLE     (416,454)
创建钥匙    (672,454)    分享钥匙    (925,454)
删除钥匙    (169,612)    拉取报文    (416,612)
连接蓝牙    (664,612)    解锁        (925,612)
闭锁        (169,769)    闪灯        (416,769)
开窗        (672,769)    关窗        (925,769)
清空报文    (169,1086)   AUTH0_REQ   (416,1086)
AUTH0_RSP   (664,1086)   AUTH1_REQ   (911,1086)
AUTH1_RSP   (169,1244)   RKE_REQ     (416,1244)
RKE_RSP     (664,1244)   ICCE        (169,1401)
```

页面下方还有两个输入框（通用状态 / 充电信息）与报文十六进制显示区。

#### 6.69b　但按钮点击无响应

在**未登录 / 钥匙未激活**状态下，点 `启动BLE`、`AUTH0_REQ` 均无任何效果：

```
after 启动BLE:   6735:0  18067:0     ← libbledata 未加载
after AUTH0_REQ: 6735:0  7478:0  18067:0
```

`logcat` 无相关输出、无 Toast、页面无变化。
说明这些按钮依赖登录态与已激活的数字钥匙，不是无条件可用的调试入口。

#### 6.69c　frida hook 会让 `:BLE` 崩溃

挂 `Interceptor` 后 `:BLE` 反复 SIGSEGV：

```
Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x12b1a4
  in tid ... (DataThread), pid ... (g.mycarinfo:BLE)
```

崩溃地址 `0x12b1a4` 每次相同，是确定性崩溃。
**停掉 hook 后不再崩溃**（`:BLE` 稳定在 18067），所以与假车无关，是 hook 自身导致。
此前把崩溃归因于假车数据包，判断有误。

#### 6.69d　5.19.0 确实带 libbledata.so

```
versionName=5.19.0  versionCode=10639
lib/arm64-v8a/libbledata.so   1181208 字节
lib/arm64-v8a/libbulk.so       158472 字节
```

库在包里，只是没被加载。

### 6.70　key 的确定性结论：每轮独立派生，非「基础值 + 扰动」

> ⚠️ **本节的前提已被 §6.59c 否定**：下面所有计算都假设「`ef0110 = 明文 XOR key`」，
> 而 §6.59c 已证明存在分组扩散。因此本节结论只在**该假设成立时**有意义，
> 不能作为「key 是这样派生的」的证据。保留本节是为了记录「XOR 模型下也找不到规律」，
> 进一步说明 XOR 模型本身是错的。

#### 6.70a　恒定 key 假设被排除

若 key 恒定，则 `ct1 XOR ct2 == pt1 XOR pt2`（key 抵消）。用 16 字节布局对 31 组相邻样本检验：

```
constant-key (16B layout): 0/30
```

#### 6.70b　key 不是「MD5 + 固定增量」

```
distinct recovered keys: 31 of 31
distinct (key XOR md5):  31 of 31
sample delta: cbd586120f1a86418d68fea2a340f51c
```

若 `key = MD5(app‖car) XOR 常量`，第二行应为 1。实际 31 个不同，
**排除「MD5 加固定扰动」这类构造**。

#### 6.70c　由此确定的性质

| 性质 | 结论 |
| --- | --- |
| key 是否恒定 | ❌ 每轮不同 |
| 是否 MD5 加常量 | ❌ 差值每轮不同 |
| 是否与 app_n/car_n 无关 | ❌ 必然相关（否则无法产生 31 个不同值） |
| 依赖方式 | 非线性（HKDF 这类），静态推不出 |

**这把「靠已知值猜 key」的路彻底关死。**
唯一可行的是取一次真实的 `getSessionKey` 输出。

#### 6.70d　环境恢复记录

登录 ANR 的根因不是 App 本身：

```
host load average: 10.11      ← 我反复跑 hook 轮询 + 假车 + 模拟器渲染
device free:       334 MB
frida-server RSS:  225 MB
AVD hw.ramSize:    2G（不是此前记录的 6G）
```

清理 frida-server（225MB）+ 停掉 runhk2/fake_car + force-stop GMS 后，
负载降到 5.85，设备 free 回到 587MB。

**教训**：不要在登录期间挂着 hook 轮询；`setInterval(install,100)` 这种 100ms 轮询
会持续占用宿主机 CPU，是负载飙升的直接原因。

### 6.71　模拟器环境问题：调整内存后 App 无法启动

#### 6.71a　起因

登录 ANR 排查发现 AVD 配置为 `hw.ramSize=2G`（不是记忆中有效的 6G），
`free -m` 显示 total 仅 3914MB、free 334MB。ANR trace 显示主线程卡在
`LeakUtils.initFixLeak`，`suspend all histogram` 的 GC 暂停最长 499ms。

据此把 `hw.ramSize` 改成 6G 并重启模拟器。

#### 6.71b　结果：内存修好了，但 App 起不来

```
free -m: total 5920, free 3948     ← 内存生效
am start -n .../.core.splashscreen.SplashEmptyActivity
  Error: Activity class {...SplashEmptyActivity} does not exist.
```

`dumpsys package` 能看到全部 124 个组件，包含：
- `.core.splashscreen.SplashEmptyActivity`（带 MAIN/LAUNCHER filter）
- `.core.open.GateActivity`
- 若干 deep-link activity

但 `cmd package resolve-activity` 对**任何**组件都返回 `No activity found`，
`monkey` 报 `No activities found to run`，deep link 也 `unable to resolve`。

#### 6.71c　已排除

| 假设 | 验证 | 结果 |
| --- | --- | --- |
| 包被禁用 | `pm list packages -d` | 无，`-e` 有 |
| 包状态损坏 | 卸载后全新安装 | 仍失败 |
| 屏幕关闭导致 `-92` | `KEYCODE_WAKEUP` 后 `mWakefulness=Awake` | 仍失败 |
| odex 未优化 | `cmd package compile -m speed -f` | Success，仍失败 |
| APK 不在磁盘 | `pm path` + `ls` | 278MB 存在 |
| manifest 无 launcher | `dumpsys` grep LAUNCHER | 有 1 处 |
| GPU 模式 | `-gpu guest` | 报 `Failed to find ColorBuffer`，渲染失败 |
| system_server 异常 | `ps` + crash buffer | 正常，无崩溃 |

#### 6.71d　已回滚，最终状态待确认

已把 `hw.ramSize` 改回 `2G` 并重启，内存回到 3914MB（原值）。
重启后**未再验证 App 能否启动**——收尾时停在这一步。

另发现一个此前没注意的配置：

```
disk.dataPartition.path=<temp>
```

数据分区路径是 `<temp>`，意味着 `/data` 可能是临时的。
这能解释「重启后组件在 dumpsys 里可见却解析不到」，但**未实测确认**。

#### 6.71e　结论

模拟器改动（2G → 6G → 回 2G）**没有产出任何与目标相关的结论**，
只是消耗了约 40 次工具调用。下次动模拟器配置前，应先确认改动前的状态是好的。

**在这一状态修好之前，任何依赖启动 App 的验证都无法进行。**

> **本节已被 §6.73 订正**：`No activity found` 的真实原因是用户 0 处于 `RUNNING_LOCKED`（CE 存储未解锁），
> 与 `hw.ramSize`、`disk.dataPartition.path=<temp>` 都无关。§6.26 那张排除表查的全是 DE 侧，
> 所以七项全部无效。以后遇到同样症状，先查 `adb shell dumpsys user | grep 'State:'`。

### 6.72　第 22–26 轮复盘：三处方向性错误与纠正

这五轮围绕「破解 `ef0110` 的 KDF」推进，产出有限且走了弯路。如实记录，避免重走。

#### 6.72a　错误一：把 `xorData` 当成正常握手的构造

`BLERescueKeyData::xorData` 确实是标准循环异或（§6.67b 逐条指令可查），
但它是**应急钥匙路径**。§6.59c 早在第 20 轮就用三对样本证明：

```
pair 12,18  TLV1^TLV2 = 000000000000 0bf0510000a9e2d502
            ct1 ^ct2  = 1db286776f67 ca40accd9f3b1c358b5a
```

明文前 6 字节完全相同，密文 6 字节各不相同 → **存在分组扩散**。
因此正常路径的 `ef0110` 不是循环异或输出。

本轮却在这个方向上做了大量参数搜索（TLV 布局 × HKDF 参数 × 字节序），
全部 0 命中。**方向从一开始就是错的。**

#### 6.72b　错误二：反复用已失效的 token 试参数

第 22–23 轮多次调用 `refresh`，返回 `12010203`（放错位置）与 `12010201`（已失效）。
文档 §4.4 早有警告「高频调用会废链，十几次后 `12010202` 永久失效」。
虽然最终确认链路未废（错误码是 `12010201` 不是 `12010202`），但这类调用没有产出。

#### 6.72c　错误三：在模拟器环境上反复试错

第 24–26 轮为了「让 App 能登录」，做了：

| 尝试 | 结果 |
| --- | --- |
| 改 `hw.ramSize` 2G → 6G | 内存生效（3914→5920MB），但 App 所有 activity 变为不可解析 |
| `-gpu guest` | `Failed to find ColorBuffer`，渲染失败 |
| 卸载重装 | 仍不可解析 |
| 强制 `compile -m speed` | Success，仍不可解析 |
| 唤醒屏幕（`mWakefulness=Asleep` → `Awake`） | 仍不可解析 |

耗时约 40 次工具调用，最终回滚到 2G。
**教训**：模拟器状态异常时应先确认「改动前是否正常」，而不是逐个排除。

#### 6.72d　唯一新增的确定结论

| 结论 | 证据 |
| --- | --- |
| `calculateAuth1SessionKey = MD5(app_n_LE ‖ car_n_LE)` | §6.62b 逐条指令 |
| 该 MD5 **不是** `ef0110` 的 key | §6.62c、§6.70 |
| key 每轮独立派生，非「基础值 + 扰动」 | §6.70a/b，31 组互不相同 |
| `salt`/`ikm` 来自运行时构造的虚表，无重定位 | §6.66b |
| `ef0110` 被车端真正校验且绑定 `car_n` | §6.65 三组对照实验 |
| `ed1118` 与 `ef0110` 无关 | 31 组 0 命中 |
| 5.19.0 内置 `TestBleKeyV3Activity` 调试页 | §6.69a，坐标已记录 |

#### 6.72e　这些结论对目标的价值

**接近于零。** 按 §6.61c：

> 子账号的 `ef0110` 是「算对了但钥匙不对」，155 次 `0x0e` 与算法无关。

即使完全解出 KDF，子账号的 KI 车端仍不认。真正的缺口是 `ble/activate`（§6.61e）。

**下一步应转向 `ble/activate`，而不是继续解 KDF。**

### 6.73　环境根因订正：`No activity found` 是用户未解锁，不是内存或数据分区

2026-11-03 重新拉起 `xp19` 模拟器，复现了 §6.71 那个「所有组件都解析不到」的状态，并**定位到真正的根因**。

#### 6.73a　现象与判据

```
$ adb shell dumpsys user | grep 'State: '
    State: RUNNING_LOCKED          ← 关键
$ adb shell ls -d /data/user/0/com.xiaopeng.mycarinfo
ls: ... No such file or directory   ← CE 存储没挂上
$ adb shell cmd package resolve-activity --brief com.xiaopeng.mycarinfo
No activity found
```

**不是只有小鹏 App 受影响**，同一时刻所有第三方包都解析不到：

```
com.xpeng.scanprobe                  -> No activity found
com.xiaopeng.mycarinfo               -> No activity found
com.logiconsole.bookreader.debug     -> No activity found
com.logiconsole.xpcarinfo            -> No activity found
com.xpengmobile                      -> No activity found
```

而 `dumpsys package` 里 `com.xiaopeng.mycarinfo` 的 `versionName=5.19.0 / versionCode=10639`、`installed=true`、28 个 Activity 全在，`pm path` 也能给出 `base.apk`（278 MB，`/data/app/~~Pn3tmzvZt-...`）。

**结论**：Activity 解析失败与包本身无关，与 `hw.ramSize` 无关，与 `disk.dataPartition.path=<temp>` 无关。**用户 0 处于 `RUNNING_LOCKED`（CE 存储未解锁），依赖 CE 的组件信息取不到，于是全系统第三方组件都「不存在」。** §6.26 那张「已排除」表里列的 7 项之所以全部无效，是因为它们都在查 DE 侧或包管理器的静态记录，而故障在 CE。

#### 6.73b　为什么这次也解不开

`locksettings.db` 显示用户 0 设有凭据（`sp-handle` / `prev-sp-handle` / `sp-handle-ts` 齐全，`lockscreen.passwordhistory` 为空），`gatekeeper/0` 有 8 字节校验数据。已试过、**全部无效**：

| 手段 | 结果 |
| --- | --- |
| `input keyevent 224` / `26` 唤醒 + `swipe` 上滑 | 屏幕亮（`mScreenState=ON`），`State` 仍 `RUNNING_LOCKED` |
| `wm dismiss-keyguard` | 无变化 |
| `am unlock-user 0` | `Error: could not unlock user` |
| `locksettings clear --user 0` | `User has a lock credential, but old credential was not provided` |
| `adb emu finger touch 1`（指纹 `Finger 1` 已录入） | `OK`，但 `State` 不变——锁屏未呈现指纹入口 |
| `am broadcast -a android.intent.action.USER_UNLOCKED` | 广播完成，`State` 不变 |

另有一条旁证说明屏幕确实亮过：`adb exec-out screencap` 在 `mScreenState=ON` 时抓到 1.36 MB 的完整锁屏（时间 `09:52`、`Unlock for all features and data`），`mScreenState=OFF` 时抓到的是 15,580 B 纯黑 PNG。所以「黑图」是屏幕关着，不是截图失败。

**这一状态需要人工在模拟器窗口里输入锁屏密码才能解除。** 本轮到此为止，没有继续试。

#### 6.73c　对 §6.71 的订正

| §6.71 的原判断 | 订正 |
| --- | --- |
| 「`hw.ramSize` 2G→6G 导致 App 起不来」 | ❌ 因果不成立。改内存那次和这次是两个独立事件；这次 `hw.ramSize=2G` 原值未动，症状完全一样 |
| 「`disk.dataPartition.path=<temp>` 可能让 `/data` 变临时」 | ❌ 未成立。`/data` 是 `dm-6` 10 G 持久分区，已用 3.5 G；`persistent.sqlite` 等文件跨重启仍在 |
| 「组件在 dumpsys 里可见却解析不到，原因待查」 | ✅ 已查明：**用户 0 `RUNNING_LOCKED`** |

**教训补充**：以后遇到「组件全都不存在」，第一步查 `dumpsys user` 的 `State:`，不要先去动 AVD 配置。

#### 6.73d　本轮其余状态

```
$ .pixi/envs/rev/bin/python scripts/renew.py status
accessToken 尾=jAMzOb_27Wwn4JJE  状态=失效  code=12010101 登录状态已过期
$ .pixi/envs/rev/bin/python scripts/renew.py renew
RuntimeError: 续期失败: 12010206 登录状态已过期，请重新登录
```

`12010206` 是比 `12010101` 更硬的失效（RT 本身也过期）。**服务端探测、`ble/activate`、`getXpKeyAuthData` 全部被这一条挡住**，与 §6.68e 记录的状态一致，没有变化。恢复只能重走 §4.2 的完整登录（发码 → 验证码 → `LGN` 滑块 → `smsLogin`）。

模拟器侧另有一处退化：`/data/data/com.xiaopeng.mycarinfo/files/mmkv/` 因 CE 未解锁而不可读，`work/mmkv/` 下的 `tee` / `mmkv.default` / `ble_cache_data` 仍是 11-03 01:38 的旧副本。**在用户解锁前，模拟器不能提供任何新的本地物料。**

### 6.74　§6.38g「裸进程调 getSessionKey 会崩」的归因订正：不是缺机制，是缺类

2026-11-03 对 `libbledata.so` 做了一轮符号与结构复核，**把 §6.38g 的崩溃重新归因**，并顺带确认 V2 握手根本不在这个库里。

#### 6.74a　`JNI_OnLoad` 的真实要求（复核 §6.2）

```
$ nm -D --defined-only work/apk/full_extract/lib/arm64-v8a/libbledata.so | grep -i jni
00000000000a31f0 T JNI_OnLoad
00000000000a33f0 T JNI_OnUnload
00000000000a3528 T _Z15hkdf_sha256_jniPKciPKhmS2_mS2_m
00000000000a38a8 T _Z15hmac_sha256_jniPKhiS0_mPj
00000000000a05ac T _Z20coverToBleByteMatrixP7_JNIEnvP13BleByteMatrix
...
$ strings -a .../libbledata.so | grep '^com/xiaopeng'
com/xiaopeng/ble_data_processor/BLEDataProcessor
com/xiaopeng/ble_data_processor/AlgorithmUtils
com/xiaopeng/ble_data_processor/BleByteMatrix
```

`JNI_OnLoad` 要成功返回 `0x10006`，进程里**必须存在**这三个同名类，其中 `BLEDataProcessor` 还要有 `RegisterNatives` 表里那 29 个方法、`AlgorithmUtils` 要有 4 个静态方法。§6.38g 那次是在 `ScanProbe`（一个自建、没有任何 `com/xiaopeng/...` 类的空壳）里 `Module.load` 后直接调 `getSessionKey`，`FindClass` 必然失败，全局 `jmethodID` 全为 null，于是 `JNIEnv->CallStaticObjectMethod` 解引用 0 崩溃。

**所以那条「access violation 0x0」证明的是「缺类」，不是「不可能在自研进程里调」。** §6.38g 的结论「`getSessionKey` 无法脱离 App 的 JVM 运行」应改读为「无法脱离 `BLEDataProcessor` + `AlgorithmUtils` 这两个类运行」——而这两个类我们可以自己写（§6.2 已记：HKDF 实体在 Java，native 只是转发）。

#### 6.74b　但这条路对本车没有价值：V2 握手不在 `libbledata.so` 里

> **⚠️ 本节结论已被 §6.77c 推翻（2026-11-03）。** 当时只搜了 `nm -D` 的符号名，而 JNI 函数名不在 `.dynsym` 里、只存在于 `RegisterNatives` 表，必须解 `.rela.dyn` 重定位才读得到。实际表里第 2 项就是 `native_generateAuthKey(IILjava/lang/String;)`。**本节保留作为方法学教训，结论不要引用。**

本车是 D55 / `bleKeyVersion 2`（§6.10），握手走 `v1v2/CarCtrlAuthPackager` + `NativeCarCtrlAuthPackager`。复核结果：

```
$ nm -D --defined-only libbledata.so | grep -iE "CarCtrlAuth|Packager|V1V2|ECData|EAData"
（0 条）
$ strings -a libbledata.so | grep -c CarCtrl
0
$ 遍历 lib/arm64-v8a/*.so 找 "carctrl|v1v2"
（所有 .so 均为 0）
```

而类名确实存在，但**只在 dex 字符串池里**：

```
com.xiaopeng.link.ble.business.carctrl.protocol.send.v1v2.NativeCarCtrlAuthPackager
com.xiaopeng.link.ble.business.carctrl.protocol.send.v1v2.NativeCarCtrlAuthPackager$Companion
com.xiaopeng.common.car.blekt.business.carctrl.CarCtrlAuthPackager
com.xiaopeng.common.car.blekt.business.carctrl.CarCtrlAuthPackager$Companion
```

`libbledata.so` 里与握手有关的导出**全是 V3 的**（`getAuth0FactorTlvData`、`getAuth1FactorTlvData`、`createBleKeyV3Auth0/Auth1RequestWithInput`、`SDKBleKeyV3::getSessionKey`、`generateSessionKey`、`BLERescueKeyData::*`），并且 `JNI_OnLoad` 注册的类名里也没有任何 carctrl 相关类。

**推论（本轮确立，此前未记录）**：D55 的 Auth0/Auth1 帧构造在**加固 Java 层**，native 侧只提供密码学原语（`hkdf_sha256_jni` / `hmac_sha256_jni` / `aes_*_cbc_*_jni`）与收发/分片（`createSendData` / `createTboxMessageWith` / `D55DataParser::parse*`）。§6.2 那句「BLE 协议层是纯函数、hook 进去可直接调 `native_generateAuth0DataV3`」**只对 V3 成立，对本车不成立**——`generateAuth0DataV3`/`generateAuth1DataV3` 是 V3 路径，本车不走。

**这条推论把「裸调 native 算 ef0110」这条路的收益直接归零**：即使把 `BLEDataProcessor`/`AlgorithmUtils` 补齐、让 `getSessionKey` 跑起来，它算的是 V3 的 sessionKey，而本车的 `ef0110` 由 Java 层的 `CarCtrlAuthPackager` 产出。

#### 6.74c　本轮对 KDF 的补充排除（离线可复现）

用 188 组真实三元组（`work/ble_capture/handshake_pairs.json` 31 组主账号 + `handshake_pairs_sub.json` 157 组子账号）又跑了两批假设，**全部 0 命中**：

| 批次 | 覆盖 | 结果 |
| --- | --- | --- |
| HMAC/SHA 族 | `HMAC-SHA256(KI, msg)` 取 `[:16]` / `[16:32]` / `[-16:]`、`HMAC-SHA256(msg, KI)`、`HMAC-MD5(KI,msg)`、`SHA256(KI‖msg)`、`SHA256(msg‖KI)`、`MD5(KI‖msg)`、`MD5(msg‖KI)`、HKDF-extract(零盐,KI) 后 HMAC × 6 种 `msg` 拼接（`aBE‖cBE`、`aLE‖cLE`、`aLE‖cBE`、`aBE‖cLE`、`cBE‖aBE`、`cLE‖aLE`） | 0/188 |
| AES 族 | 明文三种布局（§6.29b 的 2 字节 tag 版、§6.67c 的 1 字节 tag 版 + 256 种未知前缀字节、前缀后缀两种位置）× key 四种（`KI`、`MD5(a‖c)` 四种字节序）× IV 四种（全零、`KI`、`(a‖c)×2` 两种字节序），ECB 与 CBC 都跑 | 0/188 |

**这补上了 §6.63a 没覆盖的两类**：`HMAC(KI, app_n‖car_n)` 直接取前 16 字节（此前只验过 `MD5(app_n‖car_n)`），以及「未知 1 字节前缀 + 固定 key」的 AES 变体。

另单独验证：`ef0110` **不等于** `MD5(app_n_LE‖car_n_LE)`（31/31 与 157/157 全部不等），与 §6.62c 一致。

脚本没有落库（一次性），但数据与判据都在 `work/ble_capture/*.json`，可按上面表格重跑。

#### 6.74d　本轮确立的三条

| 结论 | 依据 |
| --- | --- |
| `No activity found` = 用户 0 `RUNNING_LOCKED`，与内存/数据分区无关 | §6.73a |
| §6.38g 的崩溃是「缺类」而非「不可行」；补齐两个类后 `getSessionKey` 原理上可跑 | §6.74a，`JNI_OnLoad` 符号与类名 |
| ~~但 V2/D55 的握手帧构造在加固 Java 层，native 里没有对应导出 → 裸调 native 对本车无收益~~ **已被 §6.77c 推翻** | §6.74b 当时只搜 `.dynsym` 符号名；`RegisterNatives` 表第 2 项即 `native_generateAuthKey` |
| KDF 方向新增两类排除（HMAC 族、AES+未知前缀） | §6.74c，188 组 0 命中 |

### 6.76　B1 已解除：`-wipe-data` 重建后模拟器恢复正常

2026-11-03 10:00 按用户选择清空模拟器数据重建，B1（`RUNNING_LOCKED`）解除。

#### 6.76a　操作与验证

```
adb emu kill && pkill -f qemu-system-aarch64 && adb kill-server
rm -f ~/.android/avd/xp19.avd/*.lock
emulator -avd xp19 -no-audio -no-snapshot -writable-system -wipe-data
```

重启后：

```
$ adb shell dumpsys user | grep 'State: '
    State: RUNNING_UNLOCKED          ← 已解除
$ adb shell cmd package resolve-activity --brief com.xiaopeng.mycarinfo
com.xiaopeng.mycarinfo/.core.splashscreen.SplashEmptyActivity   ← 能解析了
$ adb shell dumpsys window | grep mCurrentFocus
  .../com.xiaopeng.mycarinfo.user.login.sms.LoginBySmsActivity    ← 已到登录页
```

`gles_mode_selected:host`，`sys.boot_completed=1`，`adb root` 直接可用。

**§6.73 的判断被完整验证**：解锁后所有组件立刻可解析，App 一次 `am start` 就进到登录页。此前「改内存 / 改数据分区 / 重装 / 编译 / 唤醒」全部无效，是因为故障在 CE 层。

#### 6.76b　重装与页面状态

APK 从 `work/apk/XP_MobileAPP_Android_gw.apk` 重装，**与 wipe 前模拟器上那份 MD5 完全一致**（`bcb5ebff1f2f8dafb015a1d9589c1966`），所以版本仍是 5.19.0 / 10639，此前的静态结论全部继续适用。

页面流程：`SplashEmptyActivity` → 隐私协议弹窗（点「同意」，设备坐标 `(776,2140)`）→ `SplashLoginActivity` → `LoginBySmsActivity`（「欢迎登录小鹏汽车」+ 手机号输入框 + 获取验证码 + 微信登录）。

`adb shell screencap` 对 `LoginBySmsActivity` 仍返回全黑（21 KB 纯黑 PNG），与 §android-emulator 技能里记的一致；**改用 `screencapture -R100,100,388,891` 抓窗口区域可正常出图**（776×1782，含约 52 px 标题栏）。

#### 6.76c　现在的状态

B1 解除，B2（token）成为唯一挡在 `ble/activate` 前面的东西。继续走 §4.2 的登录链路即可，但需要真实手机号收验证码，且**会把手机上官方 App 顶下线**（单会话约束）。

#### 6.76d　由此发现的一条更短路径：用主账号登录可完全跳过 `ble/activate`

§6.34h 记了两条路，但当时把「真机做一次 activate」列为路径 A。现在把 §6.25b 与 §6.53e 放在一起看，有一条更短的：

| 事实 | 出处 |
| --- | --- |
| `getXpKeyAuthData` 按 `(uid, vin)` 固定返回**本机登录账号那把**卡，忽略入参 `cardNo` | §6.25b |
| 主账号的 KI = `7a32fc31ace4afd950b24f60eb9b2545`，车端 31/31 接受 | §6.56d、§6.61a |
| 子账号的 KI = `12a774ba5b82bddb8bae973e35bed8e8`，车端 155 次 `0x0e` | §6.61a |

**所以只要模拟器登录的是主账号，`getXpKeyAuthData` 返回的就是车端认的那把钥匙，`ble/activate` 根本不需要。** 子账号才需要 activate，而 activate 卡在 `ifaaRequest` 字段形状未知。

代价仍是单会话约束：模拟器登录主账号会把手机上官方 App 顶下线。但对「自研 App 替代官方」这个目标，这本来就是终局状态——自研端自己持有会话。

**这条把 §6.75a 的 B1→B2→B3 顺序改成 B1→B2，B3 直接消掉。** 待验证的是：主账号 token 打 `getXpKeyAuthData` 是否真返回 `7a32fc31…` 那把（此前只在子账号上验过）。

### 6.77　RegisterNatives 全表解出：`native_generateAuthKey` 存在，§6.74b 的结论必须订正

2026-11-03 用 `.rela.dyn` 重定位把 `JNI_OnLoad` 的 `RegisterNatives` 表完整解出来（§6.2 只记了「29 项」，没有内容）。**这张表直接推翻了 §6.74b。**

#### 6.77a　表在哪、怎么解

表在 vaddr `0x127838`（**不是** `0x11f838`——`0x11f838` 是文件偏移，两者差 0x8000）。29 项，每项 24 字节 `{name, sig, fn}`，三个字段都是需要 `.rela.dyn` 重定位的指针。直接读文件是乱码，必须先应用重定位。

解析脚本用 `pyelftools` 读 `.rela.dyn`，按 `r_offset` 覆盖到表项上，再用 `PT_LOAD` 做 vaddr→file offset 映射取字符串。函数地址从 `r_info_sym` 查 `.dynsym`。

#### 6.77b　全表内容（29 项，逐条）

```
 0 native_parseBleData                     (Ljava/lang/String;[B)Ljava/lang/String;
 1 native_addAuthDataFrameHeader           ([BZ)Lcom/xiaopeng/ble_data_processor/BleByteMatrix;
 2 native_generateAuthKey                  (IILjava/lang/String;)Ljava/lang/String;     ← 关键
 3 native_generateCommandParameters        (I[BBI)Lcom/xiaopeng/ble_data_processor/BleByteMatrix;
 4 native_generateLoginUidParameters       (JI)Lcom/xiaopeng/ble_data_processor/BleByteMatrix;
 5 native_generateLoginCodeParameters      (Ljava/lang/String;I)Lcom/xiaopeng/ble_data_processor/BleByteMatrix;
 6 native_generateTboxMessage              (I[BBI)Lcom/xiaopeng/ble_data_processor/BleByteMatrix;
 7 native_generateParkingHeartbeatMessage  (II)Lcom/xiaopeng/ble_data_processor/BleByteMatrix;
 8 native_generateBleKeyV3QueryStateRequestWithInput              (B[B[B[BZ)[B
 9 native_generateBleKeyV3NotifyStateRequestWithInput             (B[B[B[BZ)[B
10 native_generateBleKeyV3RkeControlRequestWithInput              (B[B[B[BZ)[B
11 native_generateSessionKey               ([B[BII)[B
12 native_generateEmergencySessionKey      (II)[B
13 native_generateHmacKey                  ([BII)[B
14 native_generateAuth0DataV3              (J[B[BIJZIIII[B[B[B[B)[B
15 native_generateAuth1DataV3              (I[B[B)[B
16 native_generateEmergencyAuth0Data       (J[B[BIJ[B)[B
17 native_generateEmergencyAuth1Data       (I[B[B)[B
18 native_generateEmergencyKeyRkeControlRequestWithInput          (B[B[BZ)[B
19 native_parseBleV3Data                   (Ljava/lang/String;[B[B[BZ)Ljava/lang/String;
20 native_generateBleKeyV3ParkingHeartWithInput                   (II[BZ)[B
21 native_generateBleKeyV3PollingCustomDataWithInput              (ZZIII[B[B)[B
22 native_generateBleKeyV3SelfCalibrationWithInput                (ZBIIIJ[B[B)[B
23 native_generateBleKeyV3DeviceModelDataWithInput                (Z[B[B)[B
24 native_generateBleKeyV3ParkingLimitDistanceWithInput           (ZZ[B)[B
25 native_generateRssiCollectDataV3        (ZIFIZIJ[B[B)[B
26 native_generateTboxMessageV3            (I[BBI)Lcom/xiaopeng/ble_data_processor/BleByteMatrix;
27 native_generateBleKeyV3PollingEnableConfigDataWithInput        (ZI[B)[B
28 native_generateBleKeyV3NotifyPollingFuncStateWithInput         (B[B[BZ)[B
```

函数地址（`r_info_sym` 查 `.dynsym`）：

```
 0 parseBleData              0xa0d6c     11 generateSessionKey   0xa2150
 1 addAuthDataFrameHeader    0xa0a64     14 generateAuth0DataV3  0xa1754
 2 generateAuthKey           0xa0b90     15 generateAuth1DataV3  0xa1ac8
 3 generateCommandParameters 0xa0cc4     19 parseBleV3Data       0xa249c
 6 generateTboxMessage       0xa0f30     26 generateTboxMessageV3 0xa2f84
```

#### 6.77c　订正 §6.74b

§6.74b 的推论「D55 的握手帧构造在加固 Java 层，native 里没有对应导出」**是错的**。表里第 2 项就是：

```
native_generateAuthKey(IILjava/lang/String;)Ljava/lang/String;
```

两个 `int` + 一个 `String`，返回 `String`。这正好是本车 `ef0110` 需要的三个输入（`app_n`、`car_n`、KI）的形状。§6.74b 之所以判错，是因为当时只搜了 `nm -D` 的**符号名**（`CarCtrlAuth`/`v1v2` 确实为 0），而 JNI 函数名不在 `.dynsym` 里——它们只以字符串形式存在于 `RegisterNatives` 表，必须解重定位才看得到。**这是搜索方法的错误，不是事实。**

#### 6.77d　`createAuthKey` 的调用链已解出

`native_generateAuthKey`（`0xa0b90`）→ PLT `0x114670` → `createAuthKey`（`0x8c13c`）。`createAuthKey(w0=a, w1=b, x2=keyString, x3=&outLen)` 的逐条逻辑：

```
0x8c178  循环：跳过 keyString 里的 ':'（0x3a），其余字符顺序搬到栈缓冲
0x8c1a8  __strlen_chk(buf, 18)
0x8c1b0  strncpy(dst, buf+strlen-10, 10)          ← 取最后 10 个字符
0x8c1c0  __strncpy_chk2(dst2, dst, 8, 9, 0xb)     ← 再取这 10 个的前 8 个
0x8c1dc  hexStringIncrement(dst2)                 ← 逐 nibble +1 mod 16（已逐条核对）
0x8c1f0  hexStringToBytes(...)                    ← 转回字节
0x8c250  MD5Init / MD5Update / MD5Final           ← 对上面那串字节做 MD5 → 16 字节
0x8c354  malloc(8); stp w23, w22, [x0]            ← 8 字节 = a_LE(4) ‖ b_LE(4)
0x8c3e0  malloc(16)
0x8c404  hmac_md5(key=那 8 字节, msg=那 16 字节 MD5, out=16 字节)
0x8c410  strh w23, [x21]                          ← *outLen = 16
```

即：

```
sessionKey16 = HMAC-MD5( key = a_LE ‖ b_LE,
                         msg = MD5( bytes( hexIncrement( KIhex[-10:][:8] ) ) ) )
```

`hmac_md5` 在 `0x8385c`，是标准实现（`>64` 字节先 `MD5`，再 `ipad`=0x36 / `opad`=0x5c 异或，两轮 MD5），没有魔改。

#### 6.77e　但这个式子对 188 组样本 0 命中

按 §6.77d 的式子实算，`main` 31 组与 `sub` 157 组**全部不匹配**：

```
[main] expect 92b7148348c91f370a898d0ce5855afe
       got    2db95465f83eb3b9fbd1cb8b18af81e6
[sub]  expect 618c3e873e1c2c08298506ec1e730f58
       got    4d5730d5e1949f38a79773023fa1af2d
```

另跑了两批变体也全 0 命中：把该 16 字节当 XOR key 去异或 TLV 明文（15 字节 + 256 种前缀、16 字节两种布局）、以及 KI 窗口 `[i:j]` 全枚举（i 任意、j−i ∈ 2..32）× 原样/递增两种处理 × MD5 与否 × 两种字节序。

**因此 §6.77d 的式子不是 `ef0110`。** 可能的解释（按可能性排序）：

1. `ef0110` 不是 `createAuthKey` 的产物，它服务别的用途（例如 `native_generateSessionKey` 的 V3 路径，或 `native_generateCommandParameters` 的参数加密）；
2. `createAuthKey` 的 `keyString` 不是 KI，而是另一个 16 字节串（它的长度被硬约束在 18 字符以内、且必须含冒号分隔，更像设备序列号或 MAC 之类的格式）；
3. 我把 `stp w23, w22` 的字节序读反了（`stp` 存 `w23` 到低地址，`w23` = 第一个 int，这个方向我有把握，但仍属推断）。

**未验证**：第 1 条可以通过「在模拟器上 hook `native_generateAuthKey` 看它是否被握手调用」直接判定，但需要模拟器登录态（B2）——现在没有。

#### 6.77f　本轮确立

| 结论 | 依据 | 性质 |
| --- | --- | --- |
| `RegisterNatives` 全表 29 项已解出，含函数地址 | §6.77b | 实测 |
| `native_generateAuthKey(IILjava/lang/String;)Ljava/lang/String;` 存在 | §6.77b 第 2 项 | 实测 |
| §6.74b「native 无 V2 握手导出」**错误**，是搜索方法错 | §6.77c | 订正 |
| `createAuthKey` 的完整指令级逻辑 | §6.77d | 实测 |
| 该式子不是 `ef0110`（188 组 0 命中） | §6.77e | 实测 |

#### 6.77g　继续深挖：`getSessionKey` 是 HKDF-SHA256，不是 `ef0110` 的式子

`native_generateSessionKey`（`0xa2150`）→ `SDKBleKeyV3::getSessionKey`（`0xa0344`），逐条：

```
0xa0394  malloc(8)
0xa03a4  stp w24, w23, [x0]              ← 8 字节 = 两个 int 依次存入
0xa03c0  hkdf_sha256_jni(ikm=x20, ikmlen=w1, salt=x22, saltlen=x3,
                         info=那 8 字节, infolen=8, out=x26, outlen=x25)
```

即 `getSessionKey` = **HKDF-SHA256**，`info` 是 `int_a_LE ‖ int_b_LE` 这 8 字节。与 §6.77d 的 HMAC-MD5 是两套东西。

按 HKDF 形状也试了一遍（`ikm` ∈ {KI, app, car, KI‖info}，`salt` ∈ {无, 空, KI, app‖car}，`info` ∈ 8 种语义串 × 四种拼接方式），188 组样本**仍然 0 命中**。

另外确认了两件事：

- `getHmacKey`（`0xa0400`）用的是 `aes_256_cbc_encrypt_jni`，同样把两个 int 拼成 8 字节传进去；
- `getXorResult`（`0xa00d4`）只是「取两者较短长度后逐字节异或」的通用工具函数，不含密钥。

#### 6.77h　本轮最终状态

`ef0110` 这个 16 字节块的派生式子**仍未解出**，但候选空间已被压缩得很窄。已排除的（全部 188 组 0 命中）：

| 已排除的候选 | 依据 |
| --- | --- |
| `HMAC-MD5(KI, app‖car)` 及 12 种字节序/编码变体 | §6.77e |
| `createAuthKey` 的完整式子（KI 末段 +1 → MD5 → HMAC-MD5） | §6.77e |
| 上述结果当 AES-128 密钥解 `ef0110`（结构判据：4B + 12×0） | §6.77g 前 |
| `AES-128-ECB(KI, app‖0¹²)` / `AES(KI, car‖0¹²)` | §6.77g 前 |
| HKDF-SHA256 的 96 种参数组合 | §6.77g |
| KI 窗口 `[i:j]` 全枚举 × 递增/原样 × MD5/原文 × 3 种字节序 | §6.77e |

**注意 §6.18g 的「`KI` 是 AES-128 密钥」这一条本身是对的**——本轮独立复现了它：拿真实 `0xED` 帧的 payload 前 16 字节用 `KI` 做 ECB 解密，得到 `76cde1a1` + 12 个零，结构与 §6.18g 记录的 `f4eee6ef` + 12 个零完全同型。所以那条结论没有被推翻，被推翻的只是「`ef0110` 能用同一把 KI 直接解」。

**唯一还开着的路**：在模拟器上 hook `createAuthKey` / `getSessionKey` / `calculateAuth1SessionKey` 三者之一，看握手时实际调用的是谁、参数是什么。这条路需要模拟器处于已登录态（B2 token 未过期），当前不具备。

#### 6.77i　一条方法学教训（写给自己）

§6.74b 的错误值得记下来：当时用 `nm -D` 搜符号名，`CarCtrlAuth` / `v1v2` 零命中，就下了「native 没有 V2 握手」的结论。但 **JNI 函数名根本不在 `.dynsym` 里**——它们只以字符串形式躺在 `RegisterNatives` 的表项中，必须解 `.rela.dyn` 重定位才读得到。同样地，`calculateAuth1SessionKey` 这种名字里没有 `v2`/`V2` 的导出，用「猜名字」的办法永远搜不到。

结论：**在这个 so 上判断「某功能是否在 native」，不能靠搜符号名，必须先把 RegisterNatives 表和导出表都完整 dump 出来再比对。** 本轮的 §6.77b 已经把两张表都 dump 完了，后续不必重复。

#### 6.77j　`calculateAuth1SessionKey` 的真实身份：`MD5(a_LE ‖ b_LE)`，与 KI 无关

导出表里 `_ZN11SDKBleKeyV324calculateAuth1SessionKeyEjjPm`（`0x891e4`，size 4）是个跳板，`b 0x114510` → GOT → 真正的实现 `_ZN11SDKBleKeyV329resc_calculateAuth1SessionKeyEjjPm`（`0xa04a0`）。逐条：

```
0xa04d4  new(8)
0xa04e4  strb w22,[x0]    strb w22>>8,[x0+1]    strb w22>>16,[x0+2]   strb w22>>24,[x0+3]
0xa0500  strb w21,[x0+4]  strb w21>>8,[x0+5]    strb w21>>16,[x0+6]   strb w21>>24,[x0+7]
0xa0518  new[](16)
0xa0524  MD5Init / MD5Update(那 8 字节) / MD5Final
0xa054c  *outLen = 16
```

即：

```
calculateAuth1SessionKey(a, b) = MD5( a_LE(4) ‖ b_LE(4) )      —— 16 字节，无 KI 参与
```

**这个名字有误导性**：它叫「Auth1 会话密钥」，但式子与 KI 完全无关，纯粹是两个 32 位整数的 MD5。这解释了为什么 §6.77e/§6.77g 里所有「带 KI」的候选全落空——如果 `ef0110` 走的是这条，那它根本不该依赖 KI。

按此式子实算，188 组样本仍然 **0 命中**（`main` 期望 `92b71483…`，实得 `2630929d…`）。所以 `ef0110` 也不是这个函数的直接输出。

#### 6.77k　由此得出的结构性判断（推论，未验证）

`ef0110` 帧的 payload 是裸 16 字节，**里面看不到 `app_n`/`car_n`**——那两个 4 字节来自同一次握手里更早的 `ef0104` 往返。所以三种可能：

1. `ef0110` = 用 `app_n`/`car_n` 派生的密钥加密的密文（我把 `MD5(a‖b)` 当 AES-128 密钥试过，解出的明文无结构）；
2. `ef0110` 与 `app_n`/`car_n` 无关，是另一路材料（例如服务端下发的会话票据）——那么这 188 组「三元组」本身就是个错误的相关性假设；
3. 派生还差一层（例如先过一次 CRC/长度混淆再 MD5）。

**第 2 条最值得先排掉**：查一下 188 组里 `ct` 与 `app_n`/`car_n` 是否存在任何单调或分组相关性，就能判定这个「三元组」前提是否成立。如果 `ct` 在 `app_n` 重复出现时也重复，则相关成立；如果完全随机，则前提错，前面所有暴力搜索都是白费。

#### 6.77l　「188 组三元组」这个前提本身站不住

§6.77e～§6.77k 所有暴力搜索都建立在「`ef0110` 的 16 字节由 `app_n`、`car_n` 派生」这个相关性假设上。本轮查了它的前提：

```
[main] n=31   unique app=31  car=31  ct=31   dup(app,car)=0
[sub]  n=157  unique app=157 car=157 ct=157  dup(app,car)=0
```

**188 组里没有任何一组 `(app_n, car_n)` 重复**。也就是说：从未出现过「同样的输入、不同的输出」或「同样的输入、同样的输出」这类能验证函数性的样本对。全部 188 个输入两两不同，输出也两两不同——这与「`ct` 是 `(app,car)` 的确定性函数」和「`ct` 与 `(app,car)` 毫无关系」**完全相容**。

因此这 188 组样本**不具备判别力**：任何候选式子只要输出是伪随机的 16 字节，都会得到 0 命中，无论它对不对。前面六轮暴力搜索的「0 命中」不能作为「候选被排除」的证据。

**这条把 §6.77e～§6.77k 的排除结论全部降级**：那些式子仍然「未被证实」，但**也不再算「被证伪」**。要继续判定，必须先拿到至少一对 `(app_n, car_n)` 重复的样本，或者换判别方式（例如在模拟器上 hook 真实调用）。

#### 6.77m　本轮的真实产出与未决项

**确立的（实测）**：

| 结论 | 依据 |
| --- | --- |
| `RegisterNatives` 全表 29 项 + 函数地址已解出 | §6.77b |
| `native_generateAuthKey(IILjava/lang/String;)` 存在 | §6.77b |
| §6.74b「native 无 V2 握手」是搜索方法错误 | §6.77c |
| `createAuthKey` = KI 末段 → `+1` → MD5 → HMAC-MD5 | §6.77d |
| `getSessionKey` = HKDF-SHA256，两个 int 作 8 字节 info | §6.77g |
| `getHmacKey` = AES-256-CBC，两个 int 同样拼法 | §6.77g |
| `calculateAuth1SessionKey` = `MD5(a_LE‖b_LE)`，**不含 KI** | §6.77j |
| `KI` 确实是 `0xED` 帧 payload 的 AES-128 密钥（独立复现 §6.18g） | §6.77g |

**未决的**：`ef0110` 这 16 字节到底怎么来的。候选空间没有被有效压缩，因为 §6.77l 说明现有样本没有判别力。

**下一步的唯一有效动作**：在模拟器上 hook `createAuthKey`（`0x8c13c`）/ `getSessionKey`（`0xa0344`）/ `calculateAuth1SessionKey`（`0xa04a0`）三个地址，跑一次真实握手，看谁被调用、参数是什么。这需要模拟器处于已登录态。

**当前阻塞**：`renew.py renew` 报 `12010206 登录状态已过期，请重新登录`——RT 本身也过期了（与 §6.68e 一致）。恢复只能重走 §4.2 完整登录（发码 → 验证码 → `LGN` 滑块 → `smsLogin`），需要真实手机号收验证码，且会把手机上官方 App 顶下线。

#### 6.77n　帧封装链已完全解出：`ef0110` 的 16 字节由调用方算好后传入

`createAuthFrameData`（`0x8b6c8`，504 B）是本轮最有价值的一块，逐条：

```
0x8b6c8  createAuthFrameData(x0=data, w1=len, w2=isTbox)
0x8b6f0  x21 = len & 0xffff
0x8b704  dataToHexString(data, len)          ← 只用于日志
0x8b718  tbz w22, #0, 0x8b7f8                ← 按 isTbox 分两条路

isTbox 路径（w22 为奇）：
0x8b71c  malloc(len+1)
0x8b734  memcpy(buf, data, len)
0x8b73c  buf[len] = 0xe0                     ← 末尾追加 0xe0
0x8b7a0  TBoxMessage::bleTboxMessage()       ← 包 TBox 外层
0x8b7b0  createSendData(..., 0xed, 0)        ← 生成 0xED 帧

非 TBox 路径（w22 为偶）：
0x8b808  createSendData(data, len, 0xef, 1)  ← 生成 0xEF 帧
```

**这解释了两件此前一直没对上的事**：

1. `0xED` 帧 payload 末尾那个 `0xe0` 不是数据的一部分，是这里硬加的（§6.11a 记录过「`0xED` 17B = 16B + `0xe0`」但没解释来源）；
2. `createAuthFrameData` **只做封装，不算密钥**——它收到的 `data` 已经是算好的 16 字节。

因此 `ef0110` 那 16 字节的产出者只能是调用方。而 native 层里**唯一**输出 16 字节、且签名形状对得上的函数就是 §6.77b 第 2 项 `native_generateAuthKey(IILjava/lang/String;)`（内部走 §6.77d 的 `createAuthKey`）。这条链现在是闭合的：

```
Java 调 native_generateAuthKey(int a, int b, String keyString)
  → createAuthKey(a, b, keyString) 返回 16 字节
  → createAuthFrameData(16字节, 16, isTbox=1)
  → 追加 0xe0 → TBox 外层 → 0xED 帧
```

#### 6.77o　但仍算不出 `ef0110`：问题在参数，不在算法

既然链路闭合，剩下的只有「`a`、`b`、`keyString` 分别是什么」这一个未知数。按 §6.77d 的式子，把 `a`/`b` 取 `app_n`/`car_n`（四种字节序）、`keyString` 取 KI 的十六进制（含「KI 窗口全枚举」）都试过，188 组 0 命中（§6.77e、§6.77l）。

结合 §6.77l 的判别力问题，现在的判断是：**算法式子可信（指令级读出），参数假设不可信**。`keyString` 很可能不是 KI——它的长度被硬约束在 18 字符以内（`__strlen_chk(buf, 18)`）、且解析时会跳过冒号，这个形状更像 **MAC 地址、设备序列号**（如 `AA:BB:CC:DD:EE:FF`）而不是 32 字符的 KI 十六进制。KI 是 32 个字符，**超过 18，会被 `__strlen_chk` 直接判定溢出**——这是个硬矛盾，说明 `keyString` 一定不是 KI。

**这条推翻 §6.77d 里「keyString 就是 KI」的隐含假设。** 之前所有「用 KI 派生」的尝试都建立在这个假设上。

#### 6.77p　当前阻塞与下一步

- `renew.py renew` → `12010206`，RT 已过期（§6.77m），无法恢复登录态，除非重走 §4.2 完整登录（要真实手机号 + 验证码，且会把手机上的官方 App 顶下线）。
- 模拟器 `emulator-5554` 在线、已 boot 完成，但**官方 App 未安装**（`pm list packages` 无 xpeng 项），`work/apk/*.apk` 也不在了（`-wipe-data` 启动后 APK 文件本身已被清理）。
- 没有登录态 → 无法跑真实握手 → 无法 hook `createAuthKey` 看实参。

**下一步只有两条，都需要用户拍板**：

1. 重新走完整登录（要手机号收验证码，会把手机官方 App 顶下线），登录后 hook `createAuthKey`/`getSessionKey` 读实参，一次就能定死 `a`/`b`/`keyString`；
2. 放弃从抓包反推，直接找 `keyString` 的真实来源——按 §6.77o 的形状推断它像 MAC/序列号，可以去 `getBleInfo` 之类的接口返回里找有没有这个形状的字段（不需要登录态的部分可以先试）。

#### 6.77q　订正 §6.77o：「`keyString` 不能是 KI」这个推论不成立

§6.77o 用 `__strlen_chk(buf, 18)` 推「keyString 必须 ≤17 字符，所以不是 32 字符的 KI」。**这条推论是错的。**

`__strlen_chk(s, n)` 的语义是「断言 `strlen(s) < n`」，`n` 是**编译期已知的目标缓冲区大小**，不是 `s` 的长度上限。看 §6.77d 的代码就明白：

```
0x8c174  sub  x9, x29, #0x1a        ← 栈缓冲，26 字节
0x8c178  循环：跳过 ':'，其余字符写进 [x9 + w8]
0x8c1a0  mov  w1, #0x12             ← 18
0x8c1a8  __strlen_chk(buf, 18)      ← 断言 strlen(buf) < 18
```

那个 18 是**栈缓冲的保护尺寸**，程序假定「去掉冒号后的 keyString 短于 18 字符」。KI 的十六进制是 32 字符，去掉冒号还是 32，**会触发 `__strlen_chk` 的溢出检查直接 abort**。所以：**要么 `keyString` 确实短于 18 字符，要么 `createAuthKey` 根本不接收 KI。**

§6.77o 的问题在于把「如果传 KI 会 abort」错读成「所以不是 KI」——它也可能是「`createAuthKey` 这条路与 KI 无关」，即 §6.77j 的 `calculateAuth1SessionKey` 那类「名字带 Auth1 但不含 KI」的情况。

**按 MAC 地址形状试过，188 组仍 0 命中**（`00:60:37:85:B9:D0` / `00603785B9D0` / `XPED-00603785B9D0` 三种写法，配合 §6.77d 的完整式子）。

#### 6.77r　本轮收尾：三条结论，一条阻塞

**本轮真正拿到的东西**（都是指令级实测，不是推断）：

1. `RegisterNatives` 全表 29 项解出（§6.77b），订正了 §6.74b 的错误结论；
2. `createAuthFrameData` 只做封装、末尾硬加 `0xe0`（§6.77n），闭合了「`0xED` 帧从哪来」；
3. `calculateAuth1SessionKey` = `MD5(a_LE‖b_LE)`，**不含 KI**（§6.77j）——这是本轮唯一一个能完整写出式子、且与 KI 无关的派生函数。

**本轮的负面结果**：`ef0110` 的 16 字节仍未解出。且 §6.77l 已证明**现有 188 组样本没有判别力**（输入两两不同、输出两两不同），所以「0 命中」既不能证实也不能证伪任何候选。继续在这个样本集上做暴力搜索是无效劳动。

**阻塞**：RT 过期（`12010206`），模拟器无官方 App，无法跑真实握手做 hook。恢复需要重走 §4.2 完整登录，要真实手机号收验证码，且会把手机上官方 App 顶下线。

**建议停止静态路线**。理由：native 层的所有派生函数都已 dump 完（§6.77b 的表 + 导出表），能读的式子都读完了；剩下的未知量是「调用方传了什么实参」，这个信息**不在二进制里**，只能靠动态 hook 或抓包获得。继续读汇编的边际收益已接近零。

### 6.78　两席复盘：订正「不需要握手」的错误口径，并定下下一步

2026-11-03 用两个独立席位重梳了「KI 获取路线」与「自研端 BLE 实现现状」。合并后最重要的一条不是新发现，而是**文档里一处从未被订正的自相矛盾**。

#### 6.78a　订正：`getXpKeyAuthData` 拿到的东西**不能**跳过握手

§6.34h 路径 A 写着：

> 激活后服务端下发的 authData 车端就会认。自研客户端此后只需调 `getXpKeyAuthData` 拿帧，**不需要私钥、不需要握手、不需要 root**。

§6.75c 继承了这句话。**这两处都错，且与 §6.35e 的实测直接冲突。**

§6.35e 是做过实验的（不是推论）：

```
-> ef0104 d4e5fee5
<- 4B 770f6cd5              ← 车端正常返回 car_n
-> ef0110 aaaa...（故意错）
<- 10B 0800 0e ...          ← 认证失败
-> ed1118 ...               ← 车端无任何响应
-> ed118b <命令帧>           ← 车端无任何响应
[*] timeout
```

**握手失败后车端不报错、不断连，只是静默丢弃后续所有帧。** 所以「拿到合法命令帧」与「能把命令帧写进去」是两件事，中间隔着 `ef0110`。

`getXpKeyAuthData` 下发的是**命令帧**（`KI`/`ED`/`SN` 三段 TLV + 服务端签名），**不含 `ef0110`**。而每条命令前都必须走 `ef0104 → ef0110 → ed1118`（§6.19a、§6.19b：每条命令重新握手，无复用捷径）。

**因此 §6.76d 那条「主账号登录即可跳过 activate」的路径，即便成立，也只解决 KI，不解决控车。** 它把 §6.75a 的 B1→B2→B3 简化成 B1→B2 是对的，但 B2 之后还横着一道此前被这句话掩盖的门：`ef0110`。

§6.34h 与 §6.75c 已就地标注订正。

#### 6.78b　路线状态总表（两席合并）

| # | 路线 | 状态 | 依据 |
| --- | --- | --- | --- |
| R1 | root 读 SP + Keystore | 关 | §6.21e/§6.21h，Keystore 密钥不可导出 |
| R2 | Frida hook `BleKeySpManager` | 关 | §6.21e/§6.23c，需 root |
| R3 | 静态解密 SharedPreferences | 关 | §6.21g，MasterKey 服务端下发 |
| R4 | 子账号 `ble/activate` 登记 KI | 关 | §6.61e，`ifaaRequest` 形状未解出 |
| R5 | 自研端自己激活 | 关（同 R4 一道门） | §6.21i |
| R6 | **主账号登录 → `getXpKeyAuthData`** | **开，但零实测** | §6.76d 自认只在子账号验过 |
| R7 | 重放握手/命令帧 | 关 | §6.35b，`ef0110` 绑定 `car_n` |
| R8 | 离线破解 KDF | 无判别力 | §6.77l，188 组样本两两不同 |
| R9 | 裸调 `libbledata.so` 自造握手帧 | 半开 | §6.77b 符号存在；实参不在二进制里 |
| R10 | 手机侧桥接 | 开（已打通） | §6.53e/§6.56b，需手机在场 |
| R11 | 从手机取主账号帧 | 关 | §6.54d/§6.54e，无 root |
| R12 | 只走 MQTT | 开 | §6.8a，蓝牙独有能力用不了 |

**R6 的证据强度必须说清楚**：

- 支持（实测）：服务端下发的 KI 与握手 KI 同源（§6.54a 99 条帧全 `12a774ba`；§6.61a 子账号握手也是 `12a774ba`）——**但全部只在子账号上验过**；
- 支持（纯推论）：`getXpKeyAuthData` 按 `(uid, vin)` 返回本机账号那把卡（§6.25b 三次，也是子账号），所以主账号应返回 `7a32fc31…`；
- **零实测**：主账号 token 打 `getXpKeyAuthData` 到底返回哪把 KI，全文档没有任何一次真实响应。`7a32fc31` 只出现在 BLE 抓包帧里（§6.18、§6.20c）。

#### 6.78c　自研端 BLE 现状（席位盘点，已核实）

| 层 | 现状 |
| --- | --- |
| `packages/protocol/src/ble.ts` | 本轮新增，帧编解码，**零调用方**；已用实车两帧 selftest 通过 |
| `packages/protocol` 其余 | 全部 MQTT/HTTP 路径，BLE 覆盖 0% |
| `apps/mobile/src/core/car.ts` | `CarLink` 是**纯 MQTT** 通道 |
| `apps/mobile/src/core/native.ts` | `XpengNet` 门面只有 post/mqtt/storage，**无 BLE 方法** |
| `apps/mobile/android/.../com/xpengmobile/` | grep `bluetooth\|BluetoothGatt\|BluetoothAdapter` **零命中** |
| `AndroidManifest.xml` | 只有 `INTERNET`，无任何蓝牙权限 |
| `scripts/ble_frame.py` | 生产可用的参考实现（实车验证），但只覆盖 `0xED` 通道单片 |
| `scripts/fakecar/*` | 一次性探针，含模拟车端 gRPC 外设 + 5 个 Frida hook 脚本 |

**结论：自研端 BLE 完成度约 5%，缺口是 Android 传输层 + 握手状态机这两大块，不是 KDF。**

#### 6.78d　下一步实验（已定，不需要登录）

原计划的两条实验（服务端取钥匙 / 自研端握手）里，**前者被 RT 过期挡死**（§6.77p），且即便做成也只解决 KI、不解决 `ef0110`（§6.78a）。所以选后者，并且把它拆成**不需要登录也能推进**的部分：

**实验 E1：用模拟车端验证握手状态机**

`scripts/fakecar/fake_car.py` 通过 netsimd 的 `registerGattDevice` 在模拟器里注册一个虚拟 BLE 外设，冒充车端（设备名、服务 UUID、写/收特征 UUID 都按实车 §6.25a/b 填）。这意味着：

1. 我们自己的 BLE 客户端可以连上它，**完全不需要账号、不需要真车**；
2. 它按 §6.25c 的握手时序应答，所以状态机（`ef0104` → 等 `car_n` → 写 `ef0110` → 等 `0800 01` → 写 `ed1118` → 发命令帧）的**时序与分片**可以先跑通并验收；
3. `ef0110` 的真值仍未知，但假车端可以配置成「接受任意 `ef0110`」，把「算法未知」与「链路未实现」这两件事解耦——这正是当前最该解耦的地方。

**E1 的验收判据**：自研客户端在模拟器里连上假车端，完整走完握手时序，并把一条 `0xED` 命令帧写进去、收到回执；日志里每一帧的字节与 `scripts/ble_frame.py` 构造的一致。

**E1 的边界**：它证明的是**链路与状态机正确**，不证明车端会接受——后者仍取决于 `ef0110` 的真值，那需要真车或已登录的模拟器（§6.77p）。

#### 6.78e　E1 首次尝试：假车端注册被 gRPC 鉴权挡住

按 §6.78d 跑 `scripts/fakecar/fake_car.py --grpc localhost:8554`：

```
10:25:14 INFO  fake car listening on localhost:50051
10:25:14 ERROR registration failed: StatusCode.UNAUTHENTICATED
              Missing the 'authorization' header with security credentials.
```

**根因**：当前模拟器实例**启动时没有带 `-grpc`**。查 `~/.android/avd/xp19.avd/emu-launch-params.txt`：

```
-avd xp19 -no-audio -no-snapshot -writable-system -wipe-data
```

没有 `-grpc`。此时 emulator 仍然在 8554 上开了 gRPC，但走的是**默认 token 鉴权**（启动日志：`Started GRPC server at 127.0.0.1:8554, security: Local, auth: +token`），而 `emulator -help-grpc` 明确写着：

> You will have to explicitly turn on jwt authorization with the `-grpc-use-jwt` flag

即不显式开 JWT 时，token 从哪来文档没写；实测也没有 `*.jwt` 文件可读（`find ~/.android -name "*jwt*"` 零命中）。

**换端口也走不通**：netsimd 自己在 `127.0.0.1:58811` 和 `127.0.0.1:6402` 上有 gRPC。58811 可达但 `registerGattDevice` 返回 `UNIMPLEMENTED`（那是 netsimd 的内部服务，不是 emulator 的 `EmulatedBluetoothService`）；6402 连 channel 都建不起来。

**结论**：§6.27b 那次成功（返回 `callback id 58904`）是在**带 `-grpc 8554` 启动**的模拟器上做的。要在当前实例上复现，必须重启模拟器并显式加 `-grpc 8554`（或加 `-grpc-use-jwt` 后再找 token）。

**这不算 E1 失败**，只说明 E1 有一个前置条件：模拟器要以 `-grpc <port>` 重启。重启代价是 `-wipe-data` 会清掉模拟器数据（当前本来也没有官方 App，无损失）。

#### 6.78f　顺带确认：自研端要跑 BLE，模拟器侧还有一道独立的坎

即使假车端注册成功，自研客户端要在模拟器里连它，需要：

1. `apps/mobile` 有 Android BLE 传输层（§6.78c：目前零行代码、Manifest 只有 `INTERNET`）；
2. 该层能拿到运行时权限 `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT`；
3. 模拟器的虚拟 BLE 栈（netsim）对 guest 可见——这一点 §6.27b 已用 `scripts/fakecar/probe/ScanProbe.java`（`app_process` 直接跑，免装 APK）验证过可行。

所以 E1 的**最短路径不是先写 RN 的 BLE 层**，而是先用 `ScanProbe` 那种 `app_process` 形式写一个「连上假车端 → 走完握手时序 → 写一条命令帧」的 guest 侧探针。它不需要 APK、不需要 RN 构建、不需要登录，能最快把「状态机对不对」这件事验证掉；验完再把逻辑搬进 `apps/mobile`。

### 6.79　子账号登录实测复核：KI 确认，但「车端不认」这条结论站不住

用户指出「子账号的蓝牙钥匙确定可用」，与 §6.53c/§6.61a 的实测冲突。按用户选择，在模拟器上重新登录子账号取真实数据复核。

#### 6.79a　环境修复：模拟器渲染与 gRPC

复核前先修了两个环境问题（都不是协议问题）：

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| `No activity found`、包名对不上 | 官方 App 包名是 **`com.xiaopeng.mycarinfo`**，不是文档里写的 `com.xiaopeng.mobile` | 更正 |
| 截图全黑、`mCurrentFocus=null`、`mDrawState=NO_SURFACE` | 模拟器渲染管线挂了 | `-gpu swiftshader_indirect` 重启后恢复 |
| `registerGattDevice` 报 `UNAUTHENTICATED` | 模拟器启动时**没带 `-grpc`**，8554 走默认 token 鉴权 | 加 `-grpc 8554` 重启 |

`-grpc` 版重启后，`fake_car.py` 注册成功：

```
10:41:15 INFO  registered as '15548' — the guest should now see XPED-00603785B9D0
```

**这同时解除了 §6.78e 记的 E1 前置阻塞。**

#### 6.79b　子账号登录后的真实数据（本次实测）

子账号登录后拉 `XpVehicle.db`（99 行 `xp_vehicle_xp_key_message`）：

```
user_id = 25400867
vin     = L1NSPGH91NA142515
cardNo  = B11793348306580
KI      = 12a774ba5b82bddb8bae973e35bed8e8   （99/99 帧全部相同）
ED      = 99 条互不相同
```

**§6.53c/§6.61a 记的「子账号 KI = `12a774ba…`」是准确的**，这部分不用订正。

#### 6.79c　但「车端不认子账号」这条推论有三个未验证前提

`xp_vehicle_keys.key_info` 里有一行此前没被注意到的字段：

```
shareFrom: 2389771      ← 这张卡是主账号「共享」给子账号的
status:    1            ← 卡状态正常
```

这把钥匙是**共享钥匙**，不是子账号自建的卡。而 §6.53c 得出「车端不认」时用的是**桥接链路**（手机当 BLE 中继），当时存在三个未分离的变量：

1. 桥接链路本身可能改变了握手时序（§6.53c 自己记着 `:BLE` 进程被反复重建）；
2. 当时的模拟器实例**没有**本次这个已登录、已激活的状态；
3. 最关键：**共享钥匙在车端是否需要单独激活，文档从未验证过**——§6.54c 说 `ble/activate` 要求 `ifaaRequest`，但那是针对**自建卡**的，共享钥匙是否走同一接口没有测过。

**所以「子账号 KI 被车端拒绝」这个结论，证据只到「桥接链路上回了 0x0e」，不足以支撑「子账号钥匙在车端不可用」。** 用户说子账号钥匙可用，与现有证据并不矛盾。

§6.53c 与 §6.61a 的结论已就地降级标注。

#### 6.79d　尝试让 App 连假车端：断网成功切到 BLE，但扫描没发现设备

假车端注册成功后（设备名已按 §6.17 改成 `XPED-DC0D30B094C4`），点数字钥匙页的「钥匙检查」：

**第一次（网络通）**：App 弹「**当前网络通畅，请确认解锁并启动车辆**」——走的是**网络通道**，根本没碰 BLE。这与 §6.5 的 `SINGLE_BLE_FIRST`/`SERIAL_BLE_FIRST` 策略一致：有网就先走网络。

**第二次（`svc wifi disable` + `svc data disable`）**：日志出现

```
W g.mycarinfo:BLE: ... com.welie.blessed.BluetoothPeripheral$startConnectionTimer$1 ...
I stack_app: appRegister: Allocated name:com.xiaopeng.mycarinfo ... gatt_if:59
D WindowManager: ... com.xiaopeng.common.car.ble.blecheck.BleCheckNewActivity
```

**断网确实把通道切到了 BLE**，App 进入 `BleCheckNewActivity`，并用 **`com.welie.blessed`** 这个第三方库注册了 GATT 客户端。这是本轮新拿到的实现情报：自研端如果要对齐行为，参考 blessed 的 API 形态比从零写 Android BLE 更省事。

**但假车端一次连接都没收到**，且蓝牙栈日志里只有：

```
le_scanning_manager_impl.cc:774 stop_scan: Scanning already stopped, return. caller=configure_scan
```

**全部是 `stop_scan`，没有任何 `start_scan`。** 说明 App 在 `BleCheckNewActivity` 里没有真正发起扫描（或扫描被过滤条件拦掉），而不是假车端不可见。

**未完成的验证**：`scripts/fakecar/probe/ScanProbe.java` 想用 `app_process` 直接扫一次来区分「假车端不可见」还是「App 没扫」，但在 Android 17 上 `app_process` 拿不到 `ActivityManager` 服务，直接崩：

```
E AndroidRuntime: at android.os.ServiceManagerProxy.getService2(...)
E AndroidRuntime: at com.android.internal.os.RuntimeInit$KillApplicationHandler.uncaughtException(...)
```

需要改成装成 APK 才能跑（`build/u.apk` 已存在但未验证）。

**所以 E1 的当前状态**：假车端已注册（§6.79a），App 已被逼到 BLE 路径并加载了 BLE 库（本节），但**握手时序还没有真正跑起来**——卡在「App 未发起扫描」这一步。

#### 6.79e　本轮对「子账号能否用蓝牙钥匙」的最终判断

用户断言子账号钥匙可用。本轮实测到的事实：

| 事实 | 来源 | 性质 |
| --- | --- | --- |
| 子账号登录后 KI = `12a774ba…`，99/99 帧一致 | `XpVehicle.db` 实读 | 实测 |
| 该卡 `shareFrom=2389771`，是主账号共享的，`status=1` | `xp_vehicle_keys.key_info` | 实测 |
| 断网后 App 确实走 BLE 并进入 `BleCheckNewActivity` | logcat | 实测 |
| 假车端注册成功，但 App 未发起扫描 | fakecar 日志 + logcat | 实测 |
| 车端是否接受子账号 KI | — | **未测** |

**结论：「车端不认子账号钥匙」这条旧结论（§6.53c/§6.61a）证据不足，已降级。** 它唯一的实测支撑是桥接链路上的 `0x0e`，而那条链路有三个未分离变量（§6.79c）。本轮既没有证实也没有推翻用户的主张——**要判定，必须让握手真的跑起来**，这正是 E1 剩余的部分。

#### 6.79f　E1 打通：假车端可发现、可连接、握手首帧已交换

把模拟器改成带 `-grpc 8554` 启动后（§6.79a），假车端注册成功，**并且真的被连上了**：

```
10:49:01 INFO  [conn] 4b:29:fe:ec:5b:01 -> CONNECTION_STATE_CONNECTED
10:49:02 INFO  <- WRITE #1 (7B) ef01048fe82373        ← 探针发的 ef0104（7 字节 = 3 头 + 4 app_n）
10:49:02 INFO  -> INDICATE (4B) 928507a3              ← 假车端回的 car_n
```

guest 侧探针（`scripts/fakecar/probe/`，装成 APK 后运行）完整走通：

```
I ScanProbe: conn state=2 status=0
I ScanProbe: services discovered status=0
I ScanProbe:   svc 0000ed28-abab-406d-832d-7ad799b479f7
I ScanProbe:     chr 0000ed28-abab-9c8c-2801-b1a015e46d6c props=12
I ScanProbe:     chr 0000ed28-abab-9c8c-2802-d3df573ff530 props=48
I ScanProbe:     subscribe true
I ScanProbe: write handshake frame=true
I ScanProbe: write ack status=0
```

**这是 §6.78d 定的 E1 第一次真正跑起来**：服务 UUID、两个特征 UUID、NOTIFY 订阅、`ef0104` 写入与 `car_n` 回应全部对上。

**探针此前跑不起来的原因**（记录以免重复踩）：`app_process` 方式在 Android 17 上拿不到 `ActivityManager`（`ServiceManagerProxy.getService2` 崩）；装成 APK 后又要显式授予运行时权限，否则

```
java.lang.SecurityException: Need android.permission.BLUETOOTH_SCAN permission
  ...: BtScan.ScanBinder.registerAndStartScan()
```

`pm grant` 三个权限（`BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT`/`ACCESS_FINE_LOCATION`）后即通。

#### 6.79g　App 连不上的真正原因：它按数据库里的 MAC 直连，不是靠扫描

用 App 内测试界面 `TestBleKeyV3Activity`（§6.44）点「启动BLE」→「连接蓝牙」，logcat 显示：

```
I bluetooth: gap_ble.cc:323 client_connect_cback: No active GAP service found
             for peer:xx:xx:xx:xx:b9:d0 callback:Disconnected
I bt_btif_gattc: btif_gattc_open_impl: Transport=BT_TRANSPORT_LE,
             address=xx:xx:xx:xx:b9:d0
```

**App 不是「扫描后发现设备再连」，而是拿一个已知 MAC 直接 `connectGatt`。** 这个 MAC 来自 `XpVehicle.db` 的 `xp_vehicle_mac` 表：

```json
{"hv":"H.2","macAddress":"00:60:37:85:b9:d0","partNo":"8810005DF10000",
 "slaveMacList":[
   {"name":"BLEFR","mac":"dc:0d:30:b0:94:c4","partNo":"8810016DG10000"},
   {"name":"BLER", "mac":"dc:0d:30:b0:c4:a4","partNo":"8810017DG10000"},
   {"name":"BLEFL","mac":"dc:0d:30:b0:79:01","partNo":"8810016DG10000"}],
 "uid":25400867,"vin":"L1NSPGH91NA142515"}
```

**这解释了两件长期没对上事**：

1. 为什么 §6.19 那会儿「把假车广播名改成 `XPED-00603785B9D0` 仍然扫不到」——App 根本不扫描，改名没用；
2. 为什么 §6.61 的桥接链路能工作——桥接是在手机侧做 BLE 中继，绕开了这个直连逻辑。

**这也给出 E1 的正确接法**：把 `xp_vehicle_mac` 里的 `macAddress` 改成假车端的 netsim MAC（本次是 `4b:29:fe:ec:5b:01`），App 就会直连假车端。

**已改但尚未生效**：改库后重进测试页点「连接蓝牙」，App 仍未发起连接（logcat 无 `btif_gattc_open`）。推测 BLE 相关代码跑在独立进程（`com.xiaopeng.mycarinfo:BLE`，§6.23c 记录过它会被反复重建），该进程缓存了旧 MAC。**下一步要 force-stop 整个 App 或杀掉 `:BLE` 进程再试**，这一步本轮没做完。

#### 6.79h　「连接蓝牙」按钮不直接发起 GATT 连接：改库后仍无动作

按 §6.79g 的思路把 `xp_vehicle_mac.macAddress` 改成假车端 MAC（`4b:29:fe:ec:5b:01`），验证过的改法：

```
adb shell "sqlite3 .../XpVehicle.db \"update xp_vehicle_mac set mac_info='<新JSON>'\""
→ 读回确认 macAddress 已是 4b:29:fe:ec:5b:01
```

随后依次尝试了三种重启粒度，**都没有产生 `btif_gattc_open`**：

| 尝试 | 结果 |
| --- | --- |
| 重进 `TestBleKeyV3Activity` 点「启动BLE」→「连接蓝牙」 | 无 GATT 动作 |
| `am force-stop` 整个 App 后重来 | 无 GATT 动作 |
| `kill -9` 单独的 `:BLE` 进程（确认已重生为 6524）后重来 | 无 GATT 动作 |

**结论：`TestBleKeyV3Activity` 的「连接蓝牙」不是「立刻连某个 MAC」的裸入口。** 这与 §6.24d 早先记的「这些按钮依赖登录态与已激活的数字钥匙，不是无条件可用的调试入口」一致——本次是在**已登录、钥匙卡 `status=1`** 的状态下重测的，仍然不动，说明还缺别的条件（很可能是 `BleService` 内部的钥匙会话状态机，而不是数据库里的 MAC）。

**这条否掉了 §6.79g 末尾那个「改 MAC 就能让 App 直连假车端」的推测。** §6.79g 里「App 用已知 MAC 直连、不靠扫描」这个事实本身仍成立（`btif_gattc_open ... address=xx:xx:xx:xx:b9:d0` 是直接证据），但**触发这次直连的不是这个按钮**，而是别的路径（`ble/activate` 或数字钥匙页的钥匙检查流程）。

#### 6.79i　本轮 E1 的净收获与剩余缺口

**已确证（可直接用于自研端）**：

1. 假车端在 netsim 下可被 guest 发现、连接、做服务发现、订阅、双向收发（§6.79f 的完整探针日志）；
2. 服务 UUID `0000ed28-abab-406d-832d-7ad799b479f7`，写特征 `…9c8c-2801-…`（`props=12`）、通知特征 `…9c8c-2802-…`（`props=48`）；
3. 首帧形态：app 写 `ef0104` + 4 字节 `app_n`（共 7 字节），车端回 4 字节 `car_n`；
4. App 侧 BLE 栈用 **`com.welie.blessed`**；
5. App **不扫描**，按数据库里的 MAC 直连。

**仍未打通**：

- 让**官方 App 自身**连到假车端并跑完整 V3 握手。缺的是触发条件，不是链路能力——链路已被探针证明可用。

**这条缺口的价值判断**：E1 的原始目的（§6.78d）是「验证自研端能否完成车端握手」。**探针已经用与自研端同构的方式（Android BLE API + 同一套帧编解码）走通了握手首帧**，所以对自研端而言 E1 的结论已经拿到。剩下「让官方 App 也连上」属于对官方实现的进一步取证，不是自研端的前置条件。

#### 6.79j　E1 完成：完整 V3 握手时序在假车端上跑通

> 已提升到 §6.24c。
#### 6.79k　打通途中踩到的四个 GATT 坑（自研端实现时必须照做）

> 已提升到 §6.24d。
#### 6.79l　E1 的边界（必须说清楚）

E1 证明的是**链路与状态机正确**：服务发现、订阅、四帧顺序、分片、队列、命令帧字节全部对上。

**它不证明车端会接受。** 探针发的 `ef0110` 是 16 字节 `0x41` 占位值——假车端被配置成接受任意值，这正是 §6.78d 说过的「把算法未知与链路未实现解耦」。真车会对这 16 字节做校验，其真值仍取决于 §6.77p 未解的 KDF。

**所以 E1 的结论落到自研端上是**：BLE 传输层 + 握手状态机这两块（§6.78c 记的两大缺口）现在有了经过验证的参考实现，剩下的是 KDF 这一块，而 KDF 不需要再动蓝牙代码。

#### 6.79m　构建方式（此前缺失，补记）

`scripts/fakecar/probe/` 原先没有构建脚本，`build/s.apk` 是历史遗留产物。本轮补全的构建链（全部在仓库内，无系统安装）：

```
JAVA_HOME=.pixi/envs/rev/lib/jvm          # pixi 的 openjdk 21，javac/java 在此
ANDROID_JAR=$SDK/platforms/android-36/android.jar
javac -source 8 -target 8 -bootclasspath $ANDROID_JAR -d build3/classes src/...
d8 --min-api 31 --output build3/ build3/classes/com/xpeng/scanprobe/*.class
aapt2 link -o build3/base.apk --manifest AndroidManifest.xml -I $ANDROID_JAR \
      --min-sdk-version 31 --target-sdk-version 34
(cd build3 && zip -q base.apk classes.dex)
zipalign -f 4 build3/base.apk build3/aligned.apk
apksigner sign --ks ~/.android/debug.keystore --ks-pass pass:android \
      --key-pass pass:android --ks-key-alias androiddebugkey \
      --out build3/probe.apk build3/aligned.apk
```

**两个必须注意的点**：`-bootclasspath` 只接受 `-source 8`（JDK 21 下 `-source 11` 会报「目标 11 不允许 --boot-class-path」）；装 APK 后**必须** `pm grant` 三个运行时权限（§6.79f），否则 `startScan` 直接抛 `SecurityException`。

#### 6.79n　自研端编解码与探针帧的一致性（已验）

`packages/protocol/src/ble.ts` 此前只有「移植时用两帧抓包验过」的记录，没有可复跑的证据。本轮固化成脚本：

```
node --experimental-strip-types scripts/verify-ble-codec.mts
→ UNLOCK: cmd=0x1 len=142 roundtrip=true
→ LOCK:   cmd=0x2 len=142 roundtrip=true
```

**142 字节与 §6.24c 里探针实际写进假车端的那条命令帧长度一致**，且 parse → rebuild 往返逐字节相同。

至此自研端 BLE 的**帧编码层**与**传输/状态机层**都有可复跑的验证，缺的只剩 `ef0110` 的 KDF（§6.77p）。

### 6.80　`ef0110` 的 KDF 已完全解出：188/188 命中（2026-11-03）

> 内容已并入 §6.19d–§6.19j（`ef0110` KDF）。

### 6.81　Mac 端直连控车还差什么（2026-11-03，KDF 解出之后）

`ef0110` 解出后（§6.80），「Mac 在车旁能不能控车」的答案仍然是**不能**。缺口从 1 个变成 2 个，性质不同。

#### 6.81a　`ed1118` 的 16 字节密文：结构解出，但随机量来源未知

> **本节 2026-11-03 车旁已订正，原结论「4 字节随机 + 12 字节零」是错的**，原因是我把密文区间取成了 `[10:26]` 之外的错误偏移。正确解出来是**完整 16 字节随机**，见 §6.26d。

对 31 组 `ed1118` 样本（`work/ble_capture/sessions.json`）做逐字节拆解：

```
ed 11 18 | 00 11 | 8e 4e c8 50 | 00 | db61b5b113d0870e6482ace4772c27e2 | e0
 头 3B      tboxlen   crc32       type   16B 密文（AES-128-ECB）           末字节
```

| 项 | 结论 | 依据 |
| --- | --- | --- |
| CRC32 | ✅ init=0、不取反，与 `ble.ts:crc32Init0` 一致 | 31 组逐组复算全部吻合 |
| 16B 密文用 `KI` 做 AES-128-ECB 解密 | ✅ 解出 **16 字节全随机**（**订正**：不是 4+12 零） | 62 帧重解，40/40 全 16 字节非零，见 §6.26d |
| 那 16 字节是不是计数器/时间戳/握手量派生 | ❌ 都不命中 | `app_n`、`car_n`、`ef0110` 各种字节序与哈希派生全部 0/31 |

所以 `ed1118` 的明文是**一段与本次会话无关的随机数**（至少与 `app_n`/`car_n`/`ef0110` 无关）。它不参与 `ef0110` 的派生，所以不影响握手前两步。

**已由 §6.26d 验证**：认证通过后，用历史模板发 `ed1118`，车端无响应。说明它不是「随便一个 16 字节随机就能过」——那 16 字节另有来源，或者需要与本轮会话绑定。

#### 6.81b　`keyString` 该用哪个 MAC：主模块还是当前连接的模块

`keyString` = 服务端下发的 `xp_vehicle_mac.macAddress` = **主模块** `00:60:37:85:B9:D0`（§6.19f）。但 Mac 端能连上的是**从模块** `XPED-DC0D30B094C4`，主模块 `XPED-00603785B9D0` 始终超时（§6.25a）。

已知事实：App 用的 `keyString` 与它**当前连哪个模块无关**——子账号那次走桥接（对端是从模块 `DC0D30B07901`），App 算出的 `ef0110` 用的仍是数据库里的 `08:00:00:00:00:00`，157/157 复现（§6.19f）。

> **2026-11-04 车旁已判定：车端用「当前连接的那个模块自己的 MAC」校验 `ef0110`。**

按上面那个实验设计实测，同一个从模块 `XPED-DC0D30B094C4`，只改 `keyString`：

| `keyString` | `car_n` | `ef0110` | 车端回应 |
| --- | --- | --- | --- |
| `00:60:37:85:B9:D0`（主模块） | `1b10c8d5` | `eaf08d74e5954d69010b5c9a45845227` | `0800 0e` **认证失败** |
| `DC:0D:30:B0:94:C4`（从模块） | `0605ee4b` | `64bcc353a0553016462d518fe70020fc` | `0800 01 44463030482e33` **认证成功** |

换成从模块 MAC 后稳定 `0x01`，复现多次。

**上面那句「App 用的 `keyString` 与它当前连哪个模块无关」要按这个结论重新理解**：
它只说明**官方 App 往 `ef0110` 里填的值**来自数据库、不随连接目标变，
不能推出**车端不校验**。车端校验的就是它自己那个模块的 MAC。
官方 App 之所以一直能用，是因为手机连的正是主模块 `00:60:37:85:B9:D0`，
数据库里的值恰好等于当前模块 MAC——两者一致，从未暴露这个约束。

**对自研端的直接后果**：连哪个模块，`keyString` 就必须填那个模块的 MAC。
Mac 上此前那批实验全回 `0x0e`（§6.81 开头），原因就是填了主模块 MAC 却连了从模块。

#### 6.81c　命令帧本身仍需要服务端

`ed118b` 的 142 字节命令帧含 `KI` / `ED` / `SN`（ECDSA P-256 签名，§6.18f）。`SN` 要私钥签，私钥在 Keystore 不可导出（§6.18h）。所以命令帧只能从 `/digital-key/v1/key/ble/getXpKeyAuthData` 拿（§6.34），那条路要登录态。

**这条没有变化**：`ef0110` 解出解决的是「握手」，不是「签名」。握手过了之后，命令帧还得从服务端取。

#### 6.81d　剩余工作量排序

| # | 事项 | 成本 | 阻塞 |
| --- | --- | --- | --- |
| 1 | 判定 `ed1118` 的 4 字节是否被校验 | 低（车旁一次连接） | 是，卡住握手第 3 步。**2026-11-04 试过，未判定**：真帧与旧帧表现相同（都无回应），需真实 `ed118b` 才能分开 |
| 2 | 判定从模块用哪个 `keyString` | 低（同上，可合并） | ✅ **2026-11-04 已判定**：用当前连接模块自己的 MAC，见 §6.81b |
| 3 | Swift 探针改成实时计算 `ef0110` | 低（公式已解出） | 否，可立即做 |
| 4 | 命令帧取服务端 `getXpKeyAuthData` | 中（要登录态） | 是，卡住最后一步 |

### 6.82　服务端 authData → 车端可写帧：转换规则已闭合（2026-11-03）

> 内容已并入 §6.25c/§6.25d（authData → 可写帧）。

### 6.83　真机（Pixel 4a，Magisk root）落地：帧库直接在设备上取（2026-11-03 夜）

> 内容已并入 §6.26a/§6.26b（真机落地）。

### 6.84　车旁实测：握手打通（2026-11-03 夜，车旁）

> 内容已并入 §6.26c（握手前三步全通）。

### 6.85　`ed1118` 的构造链已从 native 层解出（2026-11-03 深夜）

目标从「在抓包上猜」改成「读 `libbledata.so`」。符号表齐全，链路清楚。

#### 6.85a　三层调用关系

```
generateAuth1DataV3              (0xa1ac8)  JNI 入口
  └─ generateAuth1Packet         (0x8948c)  组帧
       └─ encryptAuth1Packet     (0x8a2ac)  ← 真正的构造逻辑
            ├─ BLEKeyTLV::addTLV
            └─ xorData           (0x88fe4)

generateSessionKey               (0xa2150)
  └─ getSessionKey               (0xa0344)  ← 真正的 sessionKey 派生
       └─ hkdf_sha256_jni
```

#### 6.85b　`encryptAuth1Packet` 的精确结构

反汇编 `0x8a2ac`，逐条对应：

| 地址 | 动作 |
| --- | --- |
| `0x8a2f8` | `addTLV(tag=1, u32 w1)` —— 4 字节整数 |
| `0x8a304` | `addTLV(tag=2, vec arg2)` —— 字节向量 |
| `0x8a368` | `addTLV(tag=**0x7f52**, 内层TLV)` —— 外层包住上面两个 |
| `0x8a37c` | `xorData(外层TLV, sessionKey)` |

`xorData`（`0x88fe4`）是**循环 XOR**：`out[i] = in1[i] ^ in2[i % len(in2)]`。

所以 `ed1118` 的 16 字节载荷 = `xorData(sessionKey, TLV(0x7f52, TLV(1,u32) ‖ TLV(2,vec)))`。

这与抓包结构 `ed1118 | 0011 | crc32 | 00 | <16B> | e0` 对得上：`00` 是 type，16B 是 XOR 后的结果，`e0` 恒定。

#### 6.85c　**关键**：sessionKey 用 HKDF-SHA256，不是 MD5

反汇编 `getSessionKey`（`0xa0344`）：

```
a036c: mov  w0, #8          ; malloc(8)
a0394: bl   malloc
a03a4: stp  w24, w23, [x0]  ; ← 把两个 u32 参数 a、b 依次存进这 8 字节
a03c0: bl   hkdf_sha256_jni
```

`hkdf_sha256_jni` 的实参映射：

| 寄存器 | 值 | 含义 |
| --- | --- | --- |
| `x0` | arg6 | algo 字符串 |
| `w1` | arg7 | algo 长度 |
| `x2` | arg4 | salt 指针 |
| `x3` | arg5 | salt 长度 |
| `x4` | malloc(8) | **IKM = a‖b**（两个 u32 大端拼接） |
| `w5` | `#8` | IKM 长度 |
| `x6` | arg0 | 输出缓冲 |
| `x7` | arg1 | 输出长度 |

**这解释了 §6.26d 里所有哈希猜测为什么是 0/31**——`MD5`/`SHA1`/`SHA256(ef0110)` 全都不对，因为真实算法是 HKDF-SHA256，且 IKM 是两个 u32 而非 `ef0110`。

#### 6.85d　另一个易混淆的函数

`calculateAuth1SessionKey`（`0x891e4`）→ `resc_calculateAuth1SessionKey`（`0xa04a0`）**不是主路径**，它只做 `MD5(be32(a) ‖ be32(b))`，且名字带 `resc_`（rescue，应急钥匙）。主路径是 `getSessionKey` 的 HKDF。

**实现时不要用 `calculateAuth1SessionKey`。**

#### 6.85e　下一步

还差两个实参：`getSessionKey` 的 `a`、`b` 以及 salt/info 到底传什么。需继续读 `generateSessionKey`（`0xa2150`）的调用点，确定它们来自 `app_n`/`car_n` 还是别的握手量。

一旦确定，`ed1118` 即可完整重建，配合 §6.84 已打通的 `ef0110`，握手三步全部可在 Mac 上现算。

#### 6.85f　`ed1118` 的完整构造已解到「只差实参」

继续往下读 `generateAuth1DataV3`（`0xa1ac8`）与 `getAuth1FactorTlvData`（`0x8ed74`），结构完全确定：

**TLV 编码**（`encodeTlvMessage` `0x9f9c4`）：tag 与 length 都是**变长**，每字节覆盖到 `0xff` 边界才进位。所以 `0x7f52` 占 2 字节，长度 <0x80 占 1 字节。

**明文结构**（`getAuth1FactorTlvData`，逐条对应）：

```
encodeTlvMessage(0x7f52, 内层)
  内层 = encodeTlvMessage(1, LE32(u32))      // tag=1, 4 字节小端
       ‖ encodeTlvMessage(2, buf, len)        // tag=2, 变长
```

**`BleKeyV3Auth1Params` 字段偏移**（`createBleKeyV3Auth1RequestWithInput` `0x8f4c4` 逐条读出）：

| 偏移 | 类型 | 用途 |
| --- | --- | --- |
| `+0x00` | u32 | → `TLV(1)` 的值 |
| `+0x04` | ptr | → `TLV(2)` 的载荷 |
| `+0x0c` | u8 | → `TLV(2)` 的长度 |
| `+0x0d` | ptr | **XOR key**（即 sessionKey） |
| `+0x15` | u32 | XOR key 长度 |

**`generateAuth1DataV3` 的 JNI 签名**：`(JNIEnv*, jobject, jint u32, jbyteArray buf, jint len, jbyteArray xorKey)` —— 即 **sessionKey 由 Java 侧算好后传入**，native 不负责派生。

**XOR 长度规则**（`getXorResult` `0xa00d4`）：结果长度 = `min(TLV长度, key长度)`，不是简单循环。

**CRC 是 CRC16-CCITT**（`calc_crc16_ccitt`），不是 CRC32 —— 这里之前 §6.81a 记的 CRC32 是 TBOX 外层，`ed1118` 内层另有 CRC16。

#### 6.85g　为什么反推卡住

我试了两种 TLV 布局（内层载荷 4 或 5 字节，总长 15/16），把固定位置（tag/len）的字节 XOR 掉得到密钥流片段。**但这些片段无法与任何 HKDF 候选匹配**，因为：

1. `sessionKey` 是 Java 侧传入的，`generateSessionKey` 只是它的 native 实现之一；
2. `getSessionKey` 的 `a`、`b`、`salt`、`info` 全部由 Java 侧决定；
3. 31 组样本的 sessionKey 各不相同，密钥流不可跨样本比对。

**结论：纯静态已到边界。** 下一步必须在真机上动态取 `generateAuth1DataV3` 的实参——但 §6.26b 已证明 Frida 被壳挡住。

**可行替代**：`generateAuth1DataV3` 是**导出符号**，可以写一个宿主进程 `dlopen` 后直接调用它，传入我们自己算的 sessionKey，观察输出是否与抓包一致。这能反推 Java 侧传了什么，且不需要 Frida。

#### 6.85h　TLV 结构已**实跑确认**（不再靠反汇编推测）

用 §6.19h 的 native 直调法，写 `work/kdf/harness/call_auth1.c` 直接调 `getAuth1FactorTlvData`，真机输出：

```
len=0 -> NULL
len=1 total=12 : 7f52 09 | 01 04 44332211 | 02 01 a0
len=5 total=16 : 7f52 0d | 01 04 44332211 | 02 05 a0a1a2a3a4
len=8 total=19 : 7f52 10 | 01 04 44332211 | 02 08 a0a1a2a3a4a5a6a7
```

（输入 `u32=0x11223344`，`buf=0xA0,0xA1,…`）

**由此确定**：

| 项 | 值 |
| --- | --- |
| 外层 tag | `7f 52`（2 字节） |
| 外层 len | 内层总长（1 字节，<0x80 时） |
| 内层 TLV(1) | `01 04` + **u32 小端**（`0x11223344` → `44332211`） |
| 内层 TLV(2) | `02 <len>` + 载荷 |
| 总长公式 | `6 + (2 + len) + 3 = 11 + len` |

**`len=5` 时总长正好 16**，与抓包 `ed1118` 的 16 字节密文完全吻合。所以真实载荷是 **5 字节**。

#### 6.85i　`getXorResult` 确认是纯循环 XOR（先前的"异常"是我的 bug）

**订正**：上一版记的「后 5 字节原样输出 key」是我自己的错误——那次调用里 TLV 指针来自 `getAuth1FactorTlvData` 返回的堆内存，我在调用 `getXorResult` 前已经把它 `free` 了，读到的是脏数据。

改用**栈上固定缓冲**重测（`work/kdf/harness/xor2.c`）：

```
tlv    = 7f520d0104443322110205a0a1a2a3a4
key    = 000102030405060708090a0b0c0d0e0f
实测   = 7f530f0200413525190b0fabadafadab
纯XOR  = 7f530f0200413525190b0fabadafadab   ← 完全一致
```

参数与长度规则（`0xa00fc` 的 `cmp x2, x4` 两分支，反汇编 + 实跑双向确认）：

| 参数 | 含义 |
| --- | --- |
| `x0` | 输出长度指针 |
| `x1` | data |
| `x2` | dataLen |
| `x3` | key |
| `x4` | keyLen |

- `dataLen > keyLen` → 输出长度 = **keyLen**
- `dataLen <= keyLen` → 输出长度 = **dataLen**

即 **`out[i] = data[i] ^ key[i]`，长度取 `min(dataLen, keyLen)`**。`xor_probe.c` 在 klen 1..20 上的扫描也一致（输出全是 `0x90`）。

#### 6.85j　由固定位置反推出的 sessionKey 片段

明文 16 字节里，位置 `0,1,2,3,4,9,10` 是固定的 TLV 头（`7f 52 0d 01 04 02 05`），所以：

```
sessionKey[i] = ct[i] ^ TLV_固定值[i]      i ∈ {0,1,2,3,4,9,10}
```

三个样本算出的片段：

| 样本 `app_n` | key[0] | key[1] | key[2] | key[3] | key[4] | key[9] | key[10] |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `d4e5fee5` | `a4` | `33` | `b8` | `b0` | `17` | `80` | `a9` |
| `712c7939` | `06` | `b5` | `b1` | `62` | `94` | `01` | `eb` |
| `1cc48c3f` | `52` | `75` | `db` | `e9` | `bd` | `52` | `6d` |

**这 7 个字节就是 HKDF 输出的取样点，足以做候选筛选。** 但把 `app_n`/`ef0110`/`r12`/`KI` 的 u32 组合 × 若干 salt/info 全试过，**0 命中**（`/tmp/hkdf_search.py`）。

说明 `getSessionKey` 的 `a`、`b`、salt、info 来源不在这些量里，或者 HKDF 的 `info` 是固定字符串（需从 Java 层常量池取）。

> **2026-11-04 补测：31 个会话的逐位置统计（不足以判定，见下）**
>
> `sessions.json` 里 31 条 `ed1118`（31 个不同会话）逐位置统计，16 个位置
> **全部近似均匀分布**（每位置 27–30 个不同值 / 31 条），**没有任何固定位**：
>
> | 位置 | 不同值 | 位置 | 不同值 |
> | --- | --- | --- | --- |
> | 0 | 30/31 | 8 | 29/31 |
> | 1 | 29/31 | 9 | 29/31 |
> | 2 | 30/31 | 10 | 28/31 |
> | 3 | 28/31 | 11 | 29/31 |
> | 4 | 27/31 | 12 | 29/31 |
> | 5 | 28/31 | 13 | 27/31 |
> | 6 | 28/31 | 14 | 28/31 |
> | 7 | 30/31 | 15 | 30/31 |
>
> **这条统计本身没错，但它不能像上一版那样推出结论。**
>
> 事实：`sessions.json` 里 31 条 `ed1118`（31 个不同会话）逐位置统计，
> 16 个位置全部近似均匀分布（每位置 27–30 个不同值 / 31 条），**没有固定位**。
>
> **但这不能区分 XOR 与 AES。** 两种结构都能解释观测：
>
> - **XOR**：7 个固定明文位对应 `ct[i] = key[i]`。若 sessionKey 由 HKDF 每轮重派生，
>   这些位本身就是随机的 —— 观测到的「随机」正是 sessionKey 的分布，符合预期。
> - **AES**：§6.85h 的 native 实跑给出 `len=5` 时 TLV 明文 16 字节
>   （`7f52 0d | 01 04 44332211 | 02 05 a0a1a2a3a4`），其中 9 个字节变化。
>   AES 雪崩 ⇒ 任一明文位变化即整块 16B 全变 ⇒ 31 条密文全不同。同样符合观测。
>
> 上一版本节曾据此断言「密文不是 XOR 结构、是 AES」，**那个推断是错的**：
> 它误以为「明文前缀固定 ⇒ 密文对应位固定」，忽略了 AES 的雪崩性质；
> 而按 XOR 解释时，那 7 位本就应该随机（sessionKey 每轮变），不构成反证。
>
> **目前能确定的只有**：16 字节密文与 `len=5` 的 16 字节 TLV 明文长度吻合，
> 所以 §6.85j 那条「取样点」路线**既未被证实也未被否定**。
> 36,890 组 HKDF 穷举落空仍需要一个解释，但「目标结构不对」这个理由已被撤回。
> `getXorResult` 是纯 XOR（§6.85i 栈缓冲验证，那条没错）。

#### 6.85k　本轮可复用的工具

| 文件 | 用途 |
| --- | --- |
| `work/kdf/harness/call_auth1.c` | 直调 `getAuth1FactorTlvData`，打印 TLV 结构 |
| `work/kdf/harness/xor2.c` | 直调 `getXorResult`，验证 XOR 模型 |
| `work/kdf/harness/xor_probe.c` | 扫描 key 长度 1..20 的输出长度行为 |

编译（NDK r27）：

```
CC=$SDK/ndk/27.1.12297006/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android31-clang
$CC -O1 -o out src.c -ldl
adb push out /data/local/tmp/x && adb shell "cd /data/local/tmp && ./x ./libbledata.so"
```

**注意**：`dlsym` 要用 **C++ mangled 名**（如 `_Z21getAuth1FactorTlvDatajPhmPS_`），用 C 名找不到。

#### 6.85l　`ed1118` 帧格式**完全确定**，自检通过

> 已提升到 §6.20a。
#### 6.85m　车端有速率限制，连发会回 `0x0e`

实测序列：

| 时序 | 结果 |
| --- | --- |
| 连续两次连接（间隔 ~10s） | 第 1 次 `0x0e`，第 2 次 `0x01` |
| 再连（间隔 5s） | `0x0e` |
| 冷却 45s 后 | `0x01` 正常 |

**这是排查时的重要干扰项**：`0x0e` 不一定是算法错，也可能只是被限流。后续实验必须**间隔 ≥45s**，否则会把限流误判成算法失败。

（此前 §6.84 那几次「认证通过但 `ed1118` 无响应」是真实的，不是限流——因为同一次连接里 `ef0110` 明确回了 `080001`。）

#### 6.85n　零 key 的 `ed1118` 也零响应

构造了一条**结构完全合法**（CRC 正确、长度正确）但 sessionKey 全零的帧：

```
ed11180011fc6023ef007f520d01040000000002050000000000e0
```

认证通过（`080001`）后发出，车端**仍无响应**。加上历史模板（CRC 自洽）同样无响应，可确认：

**车端确实校验 `ed1118` 的 16 字节内容**，不是「随便一条结构合法就能过」。

#### 6.85o　卡点收敛为单一未知量

```
ed1118 密文 = XOR(TLV(7f52, TLV(1,LE32(u32)) ‖ TLV(2,5B)), sessionKey)
sessionKey  = HKDF-SHA256(IKM, salt, info)     ← 只有这个未知
```

已知 7 个 sessionKey 取样字节（§6.85j），可用于验证候选。但 `getSessionKey` 走 `hkdf_sha256_jni`，它通过 JNI 回调 Java 静态方法 `hkdfSha256`——**裸进程里跑不了**（返回全零），必须在真实 App 进程内取。

Frida 被壳挡住（§6.26b），所以下一步要么：
1. 从 vdex 里读 `native_generateSessionKey` 的 Java 调用点，看它传什么；
2. 或写一个用 `JNI_CreateJavaVM` 起 JVM 的 harness，让 `hkdf_sha256_jni` 能回调到。

#### 6.85p　确认：sessionKey 由 **Java 侧**算好传入，native 不派生

之前怀疑 `BLERescueKeyData::generateAuth1Packet` 是「应急钥匙分支」，查证后**推翻**：

```
SDKBleKeyV3::generateAuth1Packet(u32, buf, len, key, keyLen, outLen)   0x8948c
  └─ 只做 vector 包装，直接转调
       BLERescueKeyData::generateAuth1Packet(...)                     0x114470
         └─ encryptAuth1Packet → addTLV / xorData
```

`SDKBleKeyV3::generateAuth1Packet` **没有独立实现**，就是转调 rescue 那个。所以 §6.85b 分析的 TLV+XOR 结构对正常握手同样成立，不是应急专用。

更关键的是调用点（`generateAuth1DataV3` 内 `0xa1ee4`）：

```
a1ee4: mov w0, w24      ; u32
a1ee8: mov x1, x23      ; buf
a1eec: mov x3, x22      ; key  ← 来自 JNI arg4 的 jbyteArray
a1ef4: bl  generateAuth1Packet
```

**`key` 直接来自 JNI 入参，native 层不做任何派生。** 所以 sessionKey 的算法只可能在 Java 侧。

#### 6.85q　纯 C 构造器已跑通，模型逐字节验证

`createBleKeyV3Auth1RequestWithInput`（`0x8f4c4`）是纯 C，裸进程可直接调（`work/kdf/harness/auth1_brute.c`）：

```
val=0 → 02 10 | 7f530f0200050607080b0f0b0c0d0e0f | 99ca
         type len  ← 16B 密文 = TLV XOR key            crc16
```

用 `key = 00..0f`、`val=0`、`buf=全0` 手算 `TLV XOR key` 与之比对，**16 字节完全一致**。构造模型至此端到端闭环。

#### 6.85r　`getSessionKey` 的形参顺序已订正

§6.85c 记的映射有误，重读 `0xa0368`–`0xa038c` 的寄存器搬运：

| 原寄存器 | 存到 | 传给 hkdf 的位置 | 含义 |
| --- | --- | --- | --- |
| `x0` | `x26` | `x6` | **info**（不是 out） |
| `x1` | `x25` | `x7` | info 长度 |
| `w2` | `w24` | IKM 高 4 字节 | u32 a |
| `w3` | `w23` | IKM 低 4 字节 | u32 b |
| `x4` | `x22` | `x2` | **salt** |
| `x5` | `x21` | `x3` | salt 长度 |
| `x6` | `x20` | `x0` | **algo 字符串** |
| `x7` | `x19` | `w1` | algo 长度 |

即 `getSessionKey(algo, algoLen, u32 a, u32 b, salt, saltLen, info, infoLen)`，`IKM = be32(a)‖be32(b)`。

#### 6.85s　用真实密文反推出的 sessionKey 候选

对样本 0，把 `val` 从 0 扫到 7、`buf` 全零，反推 `sessionKey = ct XOR TLV`：

```
val=0 → key = a4 33 b8 b0 17 d0 87 0e 64 80 a9 e4 77 2c 27 e2
val=1 → key = a4 33 b8 b0 17 d1 87 0e 64 80 a9 e4 77 2c 27 e2
```

**`val` 只影响第 6 字节**（0-indexed 的 `[6]`），其余 15 字节固定。说明 `buf` 那 5 字节如果非零，会污染 `[5]`–`[10]`。

拿这个候选去比对 HKDF（`app_n`/`car_n`/`ef0110` 的 u32 组合 × 多种 salt/info），**0 命中**。

**另一个发现**：`handshake_pairs.json` 里 `ef0110 == r12`，所以 `r12` 不是独立输入量，之前把它当独立量搜索是白费。

#### 6.85t　结论与下一步

| 判断 | 状态 |
| --- | --- |
| `ed1118` 帧格式 | ✅ 完全确定，自检逐字节一致 |
| TLV 明文结构 | ✅ 实跑确认 |
| XOR 规则 | ✅ 实跑确认 |
| 纯 C 构造器 | ✅ 跑通，与模型一致 |
| sessionKey 派生 | ❌ **在 Java 侧**，native 只接收 |

**下一步只有一条路**：反编译 dex 找 `native_generateSessionKey` 的 Java 调用点。`.tools/` 里还没有 jadx，需要先 `pixi run fetch-tools`。

不建议再在 native 层猜 HKDF 实参——已经证明 key 是外部传入的，native 侧根本没有派生代码。

### 6.86　Java 层不可静态反编译：网易易盾壳（2026-11-03 深夜）

#### 6.86a　APK 与 dex 现状

从真机拉下已安装的 APK（`com.xiaopeng.mycarinfo`，278 MB，2026-05-19 构建）：

```
$ unzip -l base.apk | grep '\.dex'
120255620  classes.dex          ← 只有这一个，120 MB
```

jadx 1.5.6 反编译结果：

| 输入 | 产出 |
| --- | --- |
| `base.apk` | 166 个 java 文件，全部是 `com.netease.nis.wrapper.*` |
| `classes.dex` | 30 个 java 文件，同上 |

**`com.netease.nis` 是网易易盾**。壳的 dex 里只有加载器，真实业务代码在运行时解密。所以：

- `native_generateSessionKey`、`MonaBleKeyMgrService` 这些字符串在 dex 里**能搜到**（字符串表未加密）；
- 但**拿不到任何方法体**，看不到 Java 侧怎么算 sessionKey、怎么调 native。

这解释了 §6.26b 记的「Frida 被壳阻断」，也解释了为什么之前静态读 vdex 只能拿到字符串、拿不到逻辑。

#### 6.86b　frida-server 在真机上的实际行为（逐个实测）

设备：Pixel 4a / Android 13 / Magisk root。frida-server 17.25.1（`/data/local/tmp/fs`，与 pixi 里的 `frida` 同版本）。

| 尝试 | 结果 |
| --- | --- |
| `frida.get_usb_device()` 枚举进程 | ✅ 成功，能看到 `com.xiaopeng.mycarinfo` 及 `:data_provider`/`:tools`/`:core` |
| `attach` 到已运行的主进程 | ❌ `TransportError: error sending data: Broken pipe`（server 端被打断） |
| `spawn` 主进程再 `attach` | ✅ 成功，能 load 脚本、能 `console.log` |
| `spawn` 后 `Interceptor.attach(dlopen)` | ✅ hook 装上，但主进程**从不加载 `libbledata.so`** |
| `attach` 到 `:BLE` 子进程 | ❌ 先 `ProtocolError: connection is closed`，重命名为 `zzbin` 后变为 `NotSupportedError: unable to parse .../libm.so: Invalid ELF header` |
| 枚举进程时找 `:BLE` | ❌ frida 的进程列表里**没有** `:BLE`，但 `adb shell ps` 明明有 |

**结论**：壳在运行中检测并阻断 frida。`spawn` 能过是因为注入发生在壳初始化之前；一旦壳跑起来，`attach` 和子进程都拿不到。

`libbledata.so` 只加载在 `:BLE` 子进程里（主进程的模块表里从来没有），而 `:BLE` 恰好是 frida 拿不到的那个。

#### 6.86c　还剩下的路

| 方案 | 可行性 |
| --- | --- |
| 静态反编译 dex | ❌ 易盾壳，只有加载器 |
| frida attach 运行时 | ❌ 壳阻断（§6.86b） |
| frida spawn + dlopen hook | ⚠️ 主进程可行，但目标库在 `:BLE` 子进程 |
| **spawn gating 捕获 `:BLE` 子进程** | 未验证 —— 需要 App 真的拉起 BLE 且 gating 能拦到 |
| 脱壳（FART / youpk 等） | 未尝试，成本高 |
| **绕开 sessionKey：让车端接受别的东西** | 未验证 |

**下一步优先做 spawn gating 捕获 `:BLE`**：`device.on("child-added")` + `enable_spawn_gating()`，在子进程 fork 出来、壳还没初始化时注入。这是目前唯一还没排除的运行时路径。

若这条也不通，就说明「纯软件解出 sessionKey」在当前壳强度下不可行，需要转向：
1. 脱壳工具链；或
2. 重新审视目标——是否真的需要 `ed1118`（比如车端是否有别的认证路径）。

#### 6.86d　车端**确实会回** `ed1118`——150 字节（关键订正）

> 已提升到 §6.26e。
#### 6.86e　frida 在 `:BLE` 进程上的实际突破（部分成功）

降到 **frida 16.5.9**（server 也换成 `frida-server-16.5.9-android-arm64`，版本必须匹配）后，情况变了：

| 版本 | `:BLE` 枚举 | attach | 建脚本 |
| --- | --- | --- | --- |
| 17.25.1 | 时有时无 | `Broken pipe` / `connection closed` | `NotSupportedError: unable to parse libm.so: Invalid ELF header` |
| **16.5.9** | ✅ 能枚举 | ✅ **成功** | ✅ **成功**，脚本能跑 |

`16.5.9` 下实测拿到：

```
[*] base=0x753e64e000        ← libbledata.so 在 :BLE 里的 r-xp 段基址
READY                         ← getSessionKey / generateAuth1Packet hook 都装上了
```

所以 **§6.86b 里「frida 拿不到 `:BLE`」的结论被推翻**——那是 17.25.1 的版本问题，不是壳的问题。

#### 6.86f　仍未解决的工程障碍：`:BLE` 生命周期太短

hook 装上了，但**没等到函数被调用**，因为：

1. `:BLE` 进程只在蓝牙相关操作时才存在，App 停在前台首页时它会退出；
2. 我 `attach` 到主进程或反复 `force-stop` 会让 App 卡在启动页（`SplashEmptyActivity`）甚至白屏；
3. 反复 ptrace 还一度把 `system_server` 搞挂（`Failure calling service activity: Broken pipe`）。

**下一轮的正确顺序**（这次没走对）：

```
1. 干净启动 App，进到车辆页（让 :BLE 常驻）
2. 确认 :BLE pid 稳定存在
3. 起 frida-server 16.5.9
4. attach :BLE 并装 hook
5. 此时才在手机上点「解锁/上锁」，触发 generateAuth1Packet
```

关键是**先让 `:BLE` 稳定存在，再挂 hook**，而不是挂完 hook 等人去操作。

#### 6.86g　离线 KDF 扫描：0 命中（覆盖面已足够广）

用两个样本交叉验证（7 个固定位置全中才算命中），扫了：

- 原语：MD5 / SHA1 / SHA256 / HMAC-MD5 / HMAC-SHA256
- 消息：`A‖C`、`C‖A`、`A‖E`、`C‖E`、`A‖C‖E`、`LE32(A)‖LE32(C)`
- key：KI、无 key
- 另加 HKDF 的各种 salt/info 组合（§6.85s）

**全部 0 命中。** 结合 §6.85p（key 由 Java 传入、native 不派生），可以确定：**sessionKey 的算法在 Java 层，且不是这些常见组合**。

#### 6.86h　结论

| 项 | 状态 |
| --- | --- |
| `ed1118` 帧格式 | ✅ 完全确定，自检逐字节一致 |
| 车端响应 | ✅ **150 字节**，31 ms（§6.26e 订正） |
| sessionKey 在 native 派生 | ❌ 已排除，是 Java 传入 |
| 静态读 Java | ❌ 网易易盾壳 |
| frida 挂 `:BLE` | ⚠️ **技术上可行**（16.5.9），但受进程生命周期限制 |
| 离线猜 KDF | ❌ 0 命中，面已铺够 |

**唯一剩下的路：frida 16.5.9 + 先让 `:BLE` 常驻再挂 hook，抓一次真实的 `generateAuth1Packet` 调用。**

#### 6.86i　`:BLE` 进程一 attach 就崩（本轮实测）

按 §6.86f 的顺序走，结果卡在更前面：**`:BLE` 进程 attach 上去就会死**。

实测序列（frida 16.5.9，`com.xiaopeng.mycarinfo:BLE`）：

| 尝试 | 结果 |
| --- | --- |
| 轮询 `pidof`，发现即 attach（无延迟） | `ProcessNotRespondingError: refused to load frida-agent, or terminated during injection` |
| 发现后等 3s 再 attach | `ProcessNotFoundError: unable to find process with pid ...`（进程已经没了） |
| 连续 4 次轮询 | 每次都拿到**不同 pid**（23137 → 23448 → 23672 → 24131），说明在**反复崩溃重启** |

logcat 确认：

```
ActivityManager: Process com.xiaopeng.mycarinfo:BLE (pid 24593) has died: fg  BTOP
ActivityManager: Canceling start item Intent { cmp=.../com.xiaopeng.link.bleenv.BleService }
ActivityManager: Scheduling restart of crashed service .../BleService
```

**`BleService` 崩溃 → 系统重启它 → 新 pid → 再崩**，形成循环。停掉 frida 后循环消失（`:BLE` 不再重启），所以是 **frida 注入触发**的，不是 App 自身问题。

另外确认：**主进程从不加载 `libbledata.so`**（`grep -c bledata` = 0），它只在 `:BLE` 里。

#### 6.86j　结论：frida 这条路在当前条件下走不通

| 环节 | 状态 |
| --- | --- |
| frida 16.5.9 能枚举 `:BLE` | ✅ |
| 能 attach 已稳定运行的 `:BLE` | ⚠️ 曾成功过一次（§6.86e 的 `READY`），但那是在 `:BLE` 恰好稳定时 |
| attach 刚启动的 `:BLE` | ❌ 触发 `BleService` 崩溃循环 |
| 主进程加载 `libbledata.so` | ❌ 从不 |

**`READY` 那次能成功，是因为当时 `:BLE` 已经在稳定运行**（pid 17779 存活多轮）。要复现必须满足：`:BLE` 已稳定 → 再 attach。而 `:BLE` 只在蓝牙操作期间稳定存活，且我的操作会让它崩。

#### 6.86k　下一步候选（按成本排序）

1. **在 App 处于"车辆页 + 蓝牙已连接"状态时 attach**——即让 `:BLE` 因为真实 BLE 连接而常驻，再挂 hook。需要用户配合把车连上。
2. **hook 主进程的 `fork`/`pthread_create`**，在 `:BLE` 子进程创建时注入（比轮询早）。
3. **改用 zygote 注入**（frida 的 `--enable-zygote`），在 fork 出 `:BLE` 前就带上 agent。
4. **脱壳**：FART/youpk 等，成本最高但能一次性拿到 Java 层。

**优先试 3（zygote 注入）**：它正好解决「子进程一启动就崩」——agent 在 zygote 里就位，`:BLE` fork 出来自带 hook，不需要事后 attach。

#### 6.86l　**闭环打通**：反推的 16 字节 key 已被 native 复现验证

这是本轮最硬的进展。把抓包反推出来的 key 喂回 `createBleKeyV3Auth1RequestWithInput`，重新构造，输出：

```
rc=0 outLen=20 : 02 10 db61b5b113d0870e6482ace4772c27e2 78d0
                 ^type ^len  ← 密文与抓包逐字节一致        ^crc16
抓包密文：            db61b5b113d0870e6482ace4772c27e2
```

**完全一致。** 这证明三件事同时成立：

1. TLV 明文结构 `7f52 0d | 01 04 <u32LE> | 02 05 <5B>` 正确；
2. `XOR(data, key)` 模型正确；
3. 反推出的 16 字节 `a4 33 b8 b0 17 d0 87 0e 64 80 a9 e4 77 2c 27 e2` **就是真实的 sessionKey**。

也就是说：**`ed1118` 的构造已经完全解开**，剩下的只是「这个 key 从哪来」。

#### 6.86m　31 组「输入 → sessionKey」确定样本

由密文反推（已闭环验证），前四组：

| # | app_n | car_n | sessionKey |
| --- | --- | --- | --- |
| 0 | `d4e5fee5` | `ffdba7e0` | `a433b8b017d0870e6480a9e4772c27e2` |
| 1 | `712c7939` | `59bfc55f` | `06b5b162947ddbaa4701ebe75aff5654` |
| 2 | `1cc48c3f` | `37aeb243` | `5275dbe9bd598fbe31526da45aa985e5` |
| 3 | `e32c8199` | `20077fba` | `4ebcad38fc81e1da7de8f50a490ecbb2` |

**31 组 app_n 和 (app_n,car_n) 配对全部互不相同**，没有重复样本可做「同输入不同输出」的交叉验证。

#### 6.86n　HKDF 穷举再次 0 命中（搜索面已足够）

这次把 u32 候选从「首 4 字节」扩到**所有 4 字节窗口 × 大小端**（34 个），salt/info 各 9 种，两组样本交叉验证：

```
u32 候选数: 34
hits 0
```

结合 §6.85s 和 §6.86g 的扫描，累计已试：

| 类别 | 覆盖 |
| --- | --- |
| 原语 | MD5 / SHA1 / SHA256 / HMAC-MD5 / HMAC-SHA256 / HKDF-SHA256 |
| u32 来源 | `app_n`/`car_n`/`ef0110` 的所有 4 字节窗口，大小端 |
| 消息拼接 | `A‖C`、`C‖A`、`A‖E`、`C‖E`、`A‖C‖E`、`be32‖be32`、`le32‖le32` |
| salt/info | 无、各字段本身、字段拼接、`hkdfSha256`/`SHA256`/`hkdf_sha256` |
| KI | 作为 key、作为消息前缀 |

**全 0 命中。**

#### 6.86o　结论：`getSessionKey` 很可能不是主路径

三条独立证据：

1. **`getSessionKey` 在裸进程里返回全零**（§6.85h 实测）——它依赖 `hkdf_sha256_jni` 的 JNI 全局句柄，说明它是给 Java 层回调用的接口，不是纯 C 主路径；
2. **`generateAuth1DataV3` 的 key 直接来自 JNI arg4**（§6.85p），native 不派生；
3. **所有 HKDF 组合都算不出真实 key**。

所以 sessionKey 的算法在 **Java 层**，而 Java 层被易盾壳包着。

#### 6.86p　现状总表

| 项 | 状态 |
| --- | --- |
| `ed1118` 帧格式 | ✅ 完全确定，自检逐字节一致 |
| TLV 明文结构 | ✅ 实跑确认（`len=5` → 16 字节） |
| XOR 模型 | ✅ 实跑确认 |
| **sessionKey 反推** | ✅ **已拿到真实值，native 闭环复现** |
| sessionKey 派生算法 | ❌ 在 Java 层，被壳包着 |
| 车端响应 | ✅ 150 字节状态快照，31 ms |
| frida 注入 `:BLE` | ❌ 触发 `BleService` 崩溃循环 |

**卡点已从「`ed1118` 未知」收敛为「sessionKey 的 Java 派生算法未知」。**

### 6.87　**找到命令帧被丢弃的真正原因：CRC 覆盖范围**（本轮最大突破）

> 内容已并入 §6.21（CRC 覆盖范围）。

### 6.88　§6.35e 的结论建立在坏帧上，需要重做

> 内容已并入 §6.22（握手是否硬前置）。

### 6.89　主路径确认：`ed1118` 由 `createBleKeyV3Auth1RequestWithInput` 构造，不是我一直在看的那个

> 内容已并入 §6.20b/§6.20c（`ed1118` 主路径）。

### 6.90　**重要修正：之前反推的 sessionKey 可能有一半是错的**

> 内容已并入 §6.20d–§6.20f（sessionKey 反推可靠性）。

### 6.91　frida 会打断真实蓝牙连接（本轮实测定论）

#### 6.91a　现象链

> 已提升到 §6.23d。
#### 6.91b　排除法确认因果

> 已提升到 §6.23e。
#### 6.91c　这对目标意味着什么

目标要求「无需额外用户操作」的稳定 BLE 车控，**不可能建立在 frida 常驻之上**：

1. frida 一 attach，连接就断，握手无从发生；
2. `:BLE` 崩溃重启循环会让 App 无法使用蓝牙钥匙；
3. 即使侥幸抓到参数，产物也要脱离 frida 才能交付。

**结论：frida 只能作为一次性取证手段，且取证窗口极窄（`:BLE` 稳定存活的那几秒），不能作为方案的一部分。**

#### 6.91d　已排除的取证路径汇总

> 已提升到 §6.23f。
#### 6.91e　剩余可行方向

**A. 静态继续挖 native（不需要 frida）**

`generateAuth1DataV3` 的 key 来自 JNI，但**调用它的 Java 代码在壳里**。不过可以退一步：看 native 侧有没有**其他**能算出同一 key 的函数，或者 key 是否被缓存到某个全局/文件。

**B. 从抓包做约束求解**

已知 7 个 key 字节（§6.20e），若 key 是 HKDF 输出，56 bit 约束足以唯一确定参数。之前搜的组合都排除了，但**参数空间可能还没覆盖全**——比如 salt/info 是运行时常量（如 `"hkdfSha256"` 的变体、包名、VIN）。

**C. 换一个有官方 App 且无壳干扰的环境**

在模拟器上装官方 App，用同样的 hook。模拟器没有真实 BLE，但**握手帧的构造不依赖真实车端**——只要能触发一次 `generateAuth1DataV3`，就能拿到参数。

**D. 接受 `ed1118` 不可解，转向「重放 + 新鲜帧」**

`getXpKeyAuthData` 下发的命令帧带服务端签名，若 §6.88 的对照实验证明「不需要握手」，则完全绕开 sessionKey。

**优先做 D 的验证（成本最低、收益最大），并行做 C（模拟器取证）。**

#### 6.91f　本轮附带排除：`ed1118` 的 key 不是 MD5 族

用 7 字节约束（§6.20e，不受 val/data 假设影响）重跑了 MD5 族：

| 覆盖 | 结果 |
| --- | --- |
| 消息组合 | `A`/`C`/`E`/`KI`/`MAC`/空 + 各种二段、三段拼接（含包名、类名、`hkdfSha256`、`XPBKTH` 等常量） |
| 原语 | `MD5`、`HMAC-MD5`（key 取 KI / E） |
| 规模 | 1552 个消息 × 4656 个候选 |
| 命中 | **0** |

另外把 `ef0110` 的中间量 `K1 = MD5(seed4)` 也当候选试了（两个 MAC 各算一遍）：

```
MAC=DC:0D:30:B0:94:C4  seed=1e41c1a5  K1=2f9dd90bbbb3f537e755c74fdd7b3613
MAC=00:60:37:85:B9:D0  seed=714896ca  K1=1c1917e742e25bf8d11b7123c86240a0
```

`K1` 本身、`HMAC-MD5(K1, A‖C)`、`MD5(K1‖A‖C)`、`MD5(K1‖E)` 等**全部 0 命中**。

**结论：`ed1118` 的 key 与 `ef0110` 不同源**，不是 `createAuthKey` 那条链的产物。

#### 6.91g　当前阻塞：token 全部过期，取不到新鲜帧

想验证 §6.88 的「不需要握手」假设，需要现取一条服务端签发的新鲜帧。实测：

```
POST /digital-key/v1/key/ble/getXpKeyAuthData
  body {"vin":"L1NSPGH91NA142515","cardNo":"B11793348306580"}
-> {"code":12010101,"msg":"登录状态已过期，请重新登录"}
```

续期也失败：

```
renew.py renew -> 12010206 登录状态已过期，请重新登录
```

**AT 和 RT 都已过期**（`work/live/` 里那份是 11-03 04:43 的）。

手机上的 App 仍在登录态（用户刚用它连过车），但 token 存在加密容器里，`PersistentSharerDataProvider.shared` 里 `strings | grep eyJ` **找不到 JWT**。

#### 6.91h　三个可选出口

| 出口 | 代价 | 备注 |
| --- | --- | --- |
| **重走登录** | 要真实手机号 + 验证码，会把手机官方 App 顶下线 | §4.2 链路已打通，能一次拿到 AT/RT |
| **从手机内存取 token** | 需要 frida，但 frida 会断蓝牙（§6.23e） | 取 token 时不需要连车，可单独做 |
| **继续静态挖 key** | 不需要登录态、不需要车 | 但已排除的路径很多（§6.23f） |

**注意**：重走登录会让手机 App 掉线，而用户当前正靠它连车。所以**重走登录应在车旁测试完成后再做**。

#### 6.91i　建议的下一步顺序

1. **先在车旁做 CRC 修好后的对照实验**（不需要新鲜帧也能做 A/B 两组：正确 CRC vs 错误 CRC）；
2. 若 A/B 无差异，再考虑重走登录取新鲜帧；
3. 静态挖 key 作为后台任务并行推进。

---
```
#### 6.42c　24 组完整握手会话（2026-11-04 车旁实测）

同一次 btsnoop（`/tmp/bts_now.log`）里按 `ef0104 → car_n → ef0110 → ed1118`
顺序配对，得 24 组 `(app_n, car_n, ef0110, ct)`。全部握手成功（`0800 01`）。

`key[0:5]` 由「密文前 5 字节 XOR 明文魔数 `7f520d0104`」算出。

| `app_n` | `car_n` | `ef0110`（前 8B） | `ct`（前 8B） | `key[0:5]` |
| --- | --- | --- | --- | --- |
| `da1640cc` | `33f2e809` | `d240bb00f3bd7ae8…` | `1b7b737a8136febf…` | `64297e7b85` |
| `617ec665` | `23824ff7` | `cb6933a9c3fa3bc4…` | `3949f15f1183e1c3…` | `461bfc5e15` |
| `7e91dce6` | `b8bacb4f` | `da384d9a3fbb62e8…` | `a9017fd5cc5b13ca…` | `d65372d4c8` |
| `fb76192b` | `619c8dea` | `f5089a9c3906b845…` | `2417c1e585afcfca…` | `5b45cce481` |
| `9b36cf95` | `39701510` | `b9f3184129dc75c1…` | `68b6adb714c23545…` | `17e4a0b610` |
| `63739e86` | `c66bb5f3` | `69122562194cccce…` | `d9e3fcc5aee04f0d…` | `a6b1f1c4aa` |
| `385dcc62` | `6e126507` | `95ca85cde5c9013c…` | `94a7ce2617222000…` | `ebf5c32713` |
| `34ccf635` | `dd3d3b66` | `f55b073f96f52b26…` | `7d578a2e1c069d47…` | `0205872f18` |
| `864056f3` | `67d1b078` | `c72960bf93b50bcb…` | `b98f37cb53108e5b…` | `c6dd3aca57` |
| `551c2f42` | `000b88f3` | `2542aadb8e7faa1d…` | `7967cad4f9212d32…` | `0635c7d5fd` |
| `fa735d8e` | `4ad068ce` | `a9772ab571024ef9…` | `71069cb6506b83c3…` | `0e5491b754` |
| `4c5fa448` | `1ac8e0a0` | `9d7965b728297347…` | `dfe7a58e9b90b857…` | `a0b5a88f9f` |
| `eac492f8` | `afdb3649` | `85055135e6290b53…` | `7c56098317918218…` | `0304048213` |
| `a665e30e` | `f1217a31` | `0cceb6a5aaae6446…` | `41a2289f574d2ad5…` | `3ef0259e53` |
| `cbd2122c` | `35183334` | `b60b745bf7214a71…` | `ca23eba9a8dd9c97…` | `b571e6a8ac` |
| `ba0171fd` | `47977cee` | `966b8b4a890a2df3…` | `ee214f6af1dc2090…` | `9173426bf5` |
| `a80a868c` | `d6e642c4` | `21ebe04e72f949e7…` | `36f5a67f61c9e6c2…` | `49a7ab7e65` |
| `71c39255` | `7ed01f53` | `f5144572ebc33667…` | `8ec13bb5cd549fac…` | `f19336b4c9` |
| `6ce0048f` | `a37951d9` | `810edd513563f7f0…` | `081b939890803ae9…` | `77499e9994` |
| `db459d16` | `e24a4d15` | `2ce4093df0a86954…` | `e87f31d27af33b3d…` | `972d3cd37e` |
| `1479280c` | `6e06950a` | `131b686aea969cac…` | `6ecef41106fb4736…` | `119cf91002` |
| `c52f5d0c` | `0e006963` | `093138e6bc036a5d…` | `07a3aabb51e43b2f…` | `78f1a7ba55` |
| `e6fb419f` | `63ffeff0` | `6b808f29288488e5…` | `137e385dfcd95a29…` | `6c2c355cf8` |
| `7d9e807b` | `0cfab1dc` | `01709a45f7e28007…` | `7a84f84a0c55e935…` | `05d6f54b08` |

**24 组得到 24 个互不相同的 `key[0:5]`**，这反证了「明文前 5 字节 = `7f520d0104`」
这个前提成立：若前提错，不会呈现「各不相同但结构一致」的分布。

### 以 24 组同时命中为判据的排除结果

| 尝试 | 结果 |
| --- | --- |
| `HKDF`，`ikm`/`salt` 取 `空/app_le/car_le/app_be/car_be/appcar_le/carapp_le/appcar_be/ef0110` 的 9×9 组合 | 0 全中 |
| `info` 取 `appcar_le/carapp_le/appcar_be/carapp_be/空` | 0 全中 |
| `MD5(appcar/carapp)` 四种字节序 | 0 全中 |
| `key[0:5]` 与 `ef0110` 13 个偏移的固定 XOR 关系 | 全部 24 种不同值，无固定关系 |

**结论：`ikm`/`salt` 中含非会话量**（固定密钥或设备常量），
不是仅由 `app_n`/`car_n`/`ef0110` 派生。这是目前对 `sessionKey` 最紧的约束。

### 一条可复用的内存取证事实

`ed1118` 帧在 `:BLE` 堆里以**十六进制字符串**形式驻留，位置在 region space 的
**block 0 偏移 15005344**（`0x13a4f6a0`），不在堆尾部。此前只扫最后 128MB 因此一直漏掉。
它紧邻日志串 `mac:00:60:37:85:B9:D0 peripheral:239515523 writing <`。

#### 6.42d　`generateSessionKey` 的 JNI 签名与 `getSessionKey` 的参数映射

反汇编 `libbledata.so` 逐条读出（`0xa2150`、`0xa0344`）：

```c
jbyteArray native_generateSessionKey(JNIEnv*, jobject,
    jbyteArray p1, jbyteArray p2, jint p3, jint p4);
```

原始 so（SHA-256 `e8aa224cc6c061df2c584fed25182f0e861460423112a338bf4e01a6aef7d860`）
在 `0xa2194`、`0xa21c8` 调 JNI 槽 `0x5c0`（`GetByteArrayElements`），
在 `0xa21ac`、`0xa21e0` 调槽 `0x558`（`GetArrayLength`），分别取两个数组及其长度。
本地 JDK 的 `jni.h` 可复核：槽索引 184/171；字符串 UTF 方法的槽实际为
`0x548`/`0x540`。因此参数契约与 RegisterNatives 的 `([B[BII)[B` 一致，
不能将两个输入解释为 Java 字符串或假定 UTF-8 编码。真实数组内容与来源仍未观测。
两个数组及长度连同两个 int 传给 `SDKBleKeyV3::getSessionKey`。

`getSessionKey` 入参为 `x4=p1, x5=len1, x6=p2, x7=len2`；在 `0xa03a8`–`0xa03bc`
重排为 `hkdf_sha256_jni(p2, len2, p1, len1, p3_le‖p4_le, 8, out, 16)`。
桥接在 `0xa36ac`–`0xa36d0` 调 Java `hkdfSha256([B[B[BI)[B`，数组顺序为：

```
hkdfSha256(p3_le‖p4_le, p1, p2, 16)
```

这是已核实的数据传递顺序；没有 Java 方法体时，不能将参数自动命名为 IKM/salt/info，
也不能依据旧名称“info串/salt串”推定数组编码。真实数组内容与语义仍须从直接 Java
调用者或真实调用记录取得。可用 `pixi run -e rev python scripts/verify-ble-jni-contract.py`
核验存档 so 的 SHA-256 及关键指令。

`hkdf_sha256_jni`（`0xa3528`）只是 JNI 桥接：`GetStaticMethodID` → `NewByteArray`
→ `SetByteArrayRegion`，**HKDF 算法在 Java 静态方法里**。这解释了为什么裸进程
直调 `getSessionKey` 必然返回全零——不是参数错，而是回调不到 Java。

#### 6.42e　紧急通道走 MD5，与普通通道不是同一套派生

`SDKBleKeyV3::calculateAuth1SessionKey`（`0x891e4`）只是一条跳转，
真实现是 `resc_calculateAuth1SessionKey`（`0xa04a0`）：

| 地址 | 动作 |
| --- | --- |
| `a04d4` | `operator new(8)` |
| `a04e4`–`a0510` | 两个 u32 按**小端序**写入 8 字节缓冲 |
| `a0524` | `MD5Init` |
| `a0534` | `MD5Update(ctx, buf, 8)` |
| `a0540` | `MD5Final(out, ctx)` |
| `a054c` | `*outLen = 16` |

**`sessionKey = MD5(p3_le(4B) ‖ p4_le(4B))`，16 字节。**

对应的 JNI 包装 `generateEmergencySessionKey`（`0xa22c0`）只接两个 int；
Java 侧日志串是 `generateEmergencySessionKey, rand0: ` 与 `…, result: `
（`classes.dex` 偏移 `54187649` / `54187687`），**参数名就叫 `rand0`**。

| 通道 | JNI 入参 | 算法 |
| --- | --- | --- |
| 紧急 | 两个 int | `MD5(p3_le ‖ p4_le)` |
| 普通 | 两个 String + 两个 int | `HKDF-SHA256(ikm=info串, salt=salt串, info=p3_le‖p4_le)` |

用 MD5 公式试普通 `ed1118`：4 组全部不匹配，符合上表。

`rand0` 这个命名间接支持「普通通道的两个 int 也是 `app_n`/`car_n` 这对随机量」。

#### 6.42f　`TestBleKeyV3Activity` 的正确拉起方式与「按钮无响应」的真因

**拉起必须用 root**。该 Activity 未导出，`shell`（uid 2000）启动会被拒：

```
java.lang.SecurityException: Permission Denial: ...
  not exported from uid 10235
```

可用写法（`dumpsys package` 的 Activity 列表里查不到它，是因为它没有 intent-filter，
不代表未注册）：

```
adb shell su -c "am start --user 0 -n com.xiaopeng.mycarinfo/com.xiaopeng.common.car.home.TestBleKeyV3Activity"
```

启动后 39 个按钮可用无障碍树读到，坐标与属性均正常：

```
btn_connect_ble  text="连接蓝牙"  bounds=[568,589][761,699]  clickable=true enabled=true
btn_unlock       text="解锁"      bounds=[818,589][1011,699]
```

窗口在 `InputDispatcher` 里也是正常注册的：

```
name='…TestBleKeyV3Activity', id=1079
inputConfig=0x0                     ← 不是 NOT_TOUCHABLE
touchableRegion=[0,0][1080,2340]
ownerUid=10235                      ← App 自己的 uid
status=NORMAL, responsive=true
```

**但点击后主进程零日志输出**，按钮的 `onClick` 未执行。这是尚未解决的现象，
不是启动方式或窗口权限问题。

**两个曾误导排查的假象**：

- 点左上角返回箭头会退回 `HomeActivity`，但日志显示是 `ShellBackPreview` /
  `CoreBackPreview` 在处理——**系统返回手势**接管了那个位置，不是 Activity 内的控件。
- 主进程抛 `NoBinderException: BLE#BINDER_NAME_BLE_COMMON_SERVICE cannot found`，
  重启 App 后可消失，但**与按钮无响应无关**：异常消失后按钮仍无响应。

#### 6.42g　4.2.0 与 5.19.0 的差异

| 版本 | APK 大小 | manifest 字符串数 | `TestBleKeyV3Activity` |
| --- | --- | --- | --- |
| 4.2.0 | 120 MB | 686 | **无** |
| 5.19.0 | 278 MB | 993 | 有 |

**这个调试界面是 5.x 才加的，4.2.0 里不存在。**

读 AXML 的注意事项：manifest 是 UTF-16LE 编码的二进制 XML，`strings` 只能抓 ASCII，
**连 `HomeActivity` 都读不出来**。据此判断「某 Activity 不在 manifest」会得出错误结论
（本次就误判过一次）。正确做法是解析 AXML 的 string pool（chunk type `0x1`，
`flags & 0x100` 判断是否 UTF-8）。

### 6.92　P5 实车 BLE 验车分片与命令回执（2026-11-04 车旁）

#### 6.92a　链路层实测值

| 项 | 实测值 |
| --- | --- |
| 官方每轮连接 | `requestMtu(160)`，车端回 `247` |
| CCCD | 写 `0x0200`（INDICATION） |
| 指示 / 确认 opcode | 车端 `0x1d`、手机 `0x1e`；同次抓包 414 条全为指示 |
| 验车分片 | 三条 `0x0082` 位于一个 30 字节指示内；官方 54 轮 × 3 = 162 条 |
| 状态表 | 150 字节；默认 23 字节 ATT MTU 下只能收到 20 字节状态碎片 |
| 自研原生桥修正 | 服务发现后请求 MTU；在 `onMtuChanged` 成功回调里写 CCCD，优先 INDICATION；连接完成时再发首帧 |

自研原生桥原先不请求 MTU 且优先 NOTIFY，导致 30/150 字节指示无法完整交付，严格认证因缺少 `0x0082` 超时。这是链路层根因，不是协议、认证算法或钥匙错误。模拟器/netsim 早期 NOTIFY 结论只适用于那套实验环境。

#### 6.92b　修正后的实车结果与回执

连接为 0.x 秒级；三段握手后收到 150 字节状态表和 30 字节 `0x0082` 三分片，严格挑战校验通过。解锁、锁车各只写一次命令帧，用户在车旁确认车门确实解锁和锁上，因此自研 App 经 BLE 控制本车解锁/锁车成立。

| 动作 | 命令帧长度 | `0x0070` 回执记录 | 现场结果 |
| --- | --- | --- | --- |
| 解锁 | 141 B | `007001000000c8000000`（code=200） | 车门确实解锁 |
| 锁车 | 142 B | `00700100002aa3000000`（code=163） | 车门确实锁上 |

`BleSession` 曾因要求 `0x70` 记录的 `payload[0]` 等于发出的 `commandCode`，丢弃锁车回执并等待 12 秒超时；同一锁车动作官方抓包回 `2`、自研抓包回 `1`，故 `payload[0]` 不是稳定命令回显。`163` 在官方结果码表/资源串中无定义，唯一有成功文案的是 `vsdk_ble_msg_200=Succeeded`；`parseControlResult`/`checkResult`/`successPrediction` 方法体不可读，因此 `163` 是成功、中间态还是失败无法判定，同帧 `0x2a` 语义亦为待取证缺口。不得把 `163` 写成成功或失败码，也不据此改动 `code===200` 的已知成功判据。

#### 6.92c　证据边界

本节使用隔离验收入口和本地注入的一条一次性材料与本地校验码，不是生产登录→自动准备物料→按钮→BLE 全链路。后续已有登录态生产包的 BLE-only 解锁/锁车真车验收见 §6.93；两节都未记录 token、校验密钥、VIN、蓝牙 MAC、authData、完整认证帧或命令帧。无钥匙账号激活、其余动作的新鲜物料与方向绑定、标准命令回执和车况 UI 刷新仍未完成。

#### 6.93　已有登录态生产 BLE-only 解锁/锁车验收

车旁且无其他设备占用车端连接槽时，已安装的生产 Release 包从 Control 页分别只点一次「解锁车门」和「锁车」。运行界面显示 DF 专属后备箱按钮，路由对 `door.unlock`/`door.lock` 映射到 `executePreparedV2(vin, 1/2)`，不调用 MQTT `carLink.send()`；两份日志中 MQTT 车控发布标记均为 0。两次连接均以 `autoConnect=true` 发起，分别得到 `status=0`、服务发现完成与 MTU 160；用户在车旁确认车门先解锁、后锁上。

解锁的界面状态同步变为「整车已解锁」。锁车的连接成功落在最初 12 秒抓窗外，由后续 logcat 环形缓冲补读确认；未观测到标准命令回执码。锁车后最终 UI 仍短暂显示「整车已解锁」，与用户确认的物理锁车结果冲突，属车况遥测刷新滞后，不能当作物理解锁证据。该验收只证明已有登录态下 P5/DF 的解锁/锁车生产 BLE-only 路径可完成物理动作；不证明无钥匙账号激活、其余 5 个动作、标准回执或状态刷新闭环。

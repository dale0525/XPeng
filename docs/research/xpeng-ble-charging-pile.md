# 蓝牙充电桩：识别、握手与启动充电

本文记录蓝牙充电桩（与车辆数字钥匙是两台不同设备）的协议事实，来源为 2026-11-06～07 在 root 的 Pixel 4a 上对官方 App 5.19.0 的 HCI 抓包、静态字符串核对，以及自研客户端的真桩实测。原始日志与取证脚本在 `work/ble-capture/`（gitignore，不入库）。

## 1. 设备与身份

- 桩 BD_ADDR `94:70:6C:44:E3:3F`，与车辆数字钥匙 `00:60:37:85:B9:D0` 严格分离；抓包时按地址与 ACL handle 分流。
- 桩不经配对（无 bond），客户端直连。
- 桩身份来源：`BlePileNetRepoImpl` 缓存对象含 `equipNo`/`ssid`/`secretKey`（`secretKey` 脱敏，不入文档）；`ble_preferences` 的 `BLE_CACHE_KEY<ssid>` 映射到 MAC；`BlePileActivity.onResume` 主动用缓存 MAC 直连。
- **没有本地发现路径**：扫描过滤只认车辆三个 UUID，桩不在扫描结果里；桩地址只能来自缓存或云端。账号下私桩按业务模型最多一个，无需筛选。
- 相关云端端点字面量：`/v5/charge/private-pile/{active,auth,query,timer}` 与 `v5/charge/private-pile/config`。332 条 `URL_*` 常量里没有 `URL_PILE_*` 注册，取不到配套 method 与参数；`/query` 最像身份来源（`bleServerPileList`、`PileDto(pileNo=`、单桩模型 `no_more_than_one_pile_msg`）。`/auth` 是授权关系（`userType: OWNER`、`vehicleAuthDtoList`），非密钥下发。字段结构落在加密 dex 内，静态取不到。

## 2. GATT 布局

- 服务 UUID `1b7e8251-2877-41c3-b46e-cf057c562023`。
- 写特征按属性句柄 `0x0006`，通知特征 `0x0003`（两次连接一致）。
- **通知特征真实 UUID `8ac32d3f-5cb9-4d44-bec2-ee689169f626`**（由 `setCharacteristicNotification` 日志取得，此前记为未知）。
- 连接后先 `setCharacteristicNotification(true)`、`requestMtu(160)`（成功协商到 160），再写 CCCD。
- 客户端可用句柄寻址，无需知道写/通知特征的 128 位 UUID。

## 3. 帧格式

- 信封统一：`68`（主动）/`69`（应答）| `b1` | payload | CRC16，2 字节大端。
- `b1` 高位是类（class），低 5 位是 payload 长度：`class = b1 >> 5`，`len = b1 & 0x1f`。
- CRC 为 **CRC16/XMODEM**（多项式 0x1021，初值 0），覆盖 `68/69 | b1 | payload`，2 字节大端附在尾部；9 条已抓帧 9/9 校验通过。
- 类 1 = 连接握手第一段，类 2 = 第二段，类 3 = 启动充电，类 5 = 状态/ACK。

## 4. 握手

- 连接握手两写两读：写类 1（`W1`）→ 读类 1 通知（`N1`）→ 写类 2（`W2`）→ 读类 2 通知（`N2`）。
- `W1` payload 9 B：`0xff` + 8 B；`W2` payload 16 B：15 B + 末字节 `0x84`。
- **桩不校验握手的密码学内容**（2026-11-07 真桩实测，自研客户端）：客户端发自己随机生成的 `W1`/`W2`，桩照样回类 1 / 类 2 通知；回显检查（客户端发送值 vs 桩返回值）为 DIFFER 时桩仍继续。因此**不需要 `secretKey` 派生公式**，客户端可本地生成握手帧。
- 两次真实会话对比：`W1` 只共享第 0、第 8 字节，`W2` 两次都是 16 B 仅共享末字节 `0x84`；故帧内容每会话可变，只有长度与格式稳定。
- 握手后桩保持静默，不发周期帧；拿握手帧必须重建连接。

## 5. 启动充电

- 启动充电帧：写 `68620000291a`（类 3，payload `0000`）。
- 应答：`6961003de1`（类 3，payload `00`）= 可以充电 / 已开始；`6961012dc0`（类 3，payload `01`）= 不能充电（条件不满足，桩未细分原因，例：车未插枪）。
- 应用层 ACK `69a1002bb5`（类 5）。
- 状态码：`00` 可充，`01` 不可充。
- **自研客户端两次实测到 payload `01`**：一次在车未插枪时，一次在车**已插枪且正在充电中**。所以 `01` 只表示「当前条件不满足」，桩不细分原因；「车未插枪」是其中一种解释，不是唯一解释，重复对已处于充电中的桩下发启动充电同样会得到 `01`。**车插枪后真正出电（payload `00`）尚未在自研端验证**。
- 停止充电命令尚未抓取（deferred）。

## 6. 连接状态 133 的成因

- 首次直连常返回 `status=133`（`GATT_CONN_FAILED_ESTABLISHMENT`），底层日志先有 `Le connection completed` 再有 `eatt disconnect cid:0xffff`，是 Android 建立 GATT 通道失败的典型表现，**不是桩侧拒绝服务，也不是「桩释放慢」**。
- 官方 App 同样吃这个 133：首次 `auto:false` 失败后，关闭并用 `auto:true` 重连，约 37–40 ms 后成功。差别只在**有没有重试**。
- 自研客户端实现：首次 `auto:false`，遇 133 关闭后隔约 200 ms 用 **`auto:false`** 重连，最多 3 次。选 `auto:false` 而非官方的 `auto:true`，是因为本机栈上 `auto:true` 的后台连接不回调 `onClientConnectionState`（会一路超时），`auto:false` 每次都能正常回调。
- 次要放大因素：同手机同时连着车辆数字钥匙时，两条 LE 链路更容易让第二条被拆。
- **连接建立后 200 ms 内的断开不要当成握手失败**：`GATT_CONN_OK` 之后紧接 `TERMINATE_LOCAL_HOST` 且发生在数百毫秒量级，多半是客户端自己结束进程（例如探针为验证握手而强杀 App）。归因前先确认当时进程是否还活着，否则会把自身的终止误判为桩侧拒绝。

## 7. 自研端实现约束

- 复用现有 `ble-v2` 车控栈连桩不成立：原生模块 `XpengBleModule.kt` 把四个车辆 UUID 写死为 `ED28` 段，扫描硬编码 `startsWith("XPED")`，桩的 `XPAC…` 进不了结果集；全仓无 CRC16。传输层、单 waiter 超时、写队列、字节工具有部分可复用。
- 代码：`packages/protocol/src/pile-frame.ts`（帧编解码）、`packages/protocol/src/pile-session.ts`（会话状态机 + `generateHandshakeMaterial`）、`apps/mobile/src/core/pile.ts`（`connectPile` 自动握手，重试在原生层）。
- **连接与启动充电必须是两个动作**：`connectPile` 只负责扫描 → GATT → 握手，成功即返回持有链路的会话；启动充电是后续按需调用，不能塞进同一条 `try/finally`。早先实现把下发与断开绑在一个流程里，导致「不启动充电就连不上、连上也不会保持」，界面上只剩「未连接/已下发」两态。桩一次会话可复用，无须每次动作重建。
- **链路生命周期归界面**：弹窗可见即自动连接并保持，关闭才 `disconnect()` 释放；原生模块同一时刻只允许一条 GATT，占着电台会挡住车辆数字钥匙的蓝牙车控，因此不能只连不放。桩侧主动断链不通过任何 promise 暴露，只能靠原生 `xpeng-ble-disconnect` 事件通知界面，否则会一直停在「已连接」。

## 8. 仍未闭合

1. 车插枪后自研端启动充电是否真出电（需真车插枪，属真实电力动作）。
2. 停止充电命令与 ACK/状态序列。
3. 服务端如何签发/轮换 `secretKey` 与私桩配置（自研客户端全新安装时拿不到该对象）。
4. `N2` 中 `00 0a` / `00 08` 字节语义未解。

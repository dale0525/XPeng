# 云端 MQTT 指令候选清单（第三方来源交叉核对）

回答「上游 Home Assistant 集成 [xpengtoolkit/xpengtoolkit](https://github.com/xpengtoolkit/xpengtoolkit) 的指令表，哪些能用来补我们未打通的通道」。

来源只读：`/tmp/xpengtk`（v0.6.49，2026-11-14 推送），核对时点 2026-11-15。**本机没有对该仓库留下可复现的副本路径**，重跑需重新 clone。

本文只是**候选清单**，不是可用指令表：`packages/protocol/src/commands.ts` 一条也没改。凡标「候选」的，都必须先按「验收判据」实测通过才可进入代码。

## 两个来源的可比性边界

| 项 | 本项目 | 上游 |
| --- | --- | --- |
| 账号区域 | 国内（`apps.xiaopeng.com`） | 欧洲/挪威（`apps-global.xiaopeng.com`） |
| AppId | `xp_xmart_android` | `xp_app_norway_android` |
| 官方 App | 国内版 5.19.0（versionCode 10639） | 海外版 3.12.0 / 3.16.0 |
| 登录 | 短信 + 第二道滑块 | 邮箱密码 + 滑块 / Google |
| 车型 | D55（P5） | G6 / G9 / P7+（FJ） |
| BLE 数字钥匙 | 已闭环 | 无（全仓 `bluetooth` 零命中） |

`service_type` 与 `cmd_type` 是**云端 MQTT 协议层**的编号，不随 App 版本变化——这一点由下面 18 条完全对齐的条目反证：两个团队在互不知情下、对着不同版本、不同区域、不同车型测出同一组 `{service_type, cmd_type}`。但**单条指令是否被某个车型接受**仍取决于车端，所以下面每条都要单独实测。

## 已交叉验证：12 组动作

这些我们用 D55 实测过、上游独立测过，编号完全一致。**不需要重测**。上游表里同一通道的开与关分两行（`openACSwitch` / `closeACSwitch`），合计占 18 行，去重后是下面 12 组。

| 动作 | `service_type` | `cmd_type` / `msg_content` |
| --- | --- | --- |
| 解锁 | 9 | `{cmd_type:0}` |
| 锁车 | 9 | `{cmd_type:1}` |
| 临停 | 9 | `{cmd_type:3}` |
| 闪灯 | 5 | `{cmd_type:1,cmd_value:1}` |
| 鸣笛 | 6 | `{cmd_type:1,cmd_value:1}` |
| 空调开/关 | 3 | `{cmd_type:1,cmd_value:1/0}` |
| 极速降温 | 3 | `{cmd_type:6,cmd_value:1/0}` |
| 极速升温 | 3 | `{cmd_type:8,cmd_value:1/0}` |
| 高温抑菌 | 3 | `{cmd_type:9,cmd_value:1/0}` |
| 天窗遮阳帘开/关 | 12 | `{cmd_type:4,cmd_value:1/0}` |
| 全车车窗降/升 | 12 | `{cmd_type:1,cmd_value:2/1}` |
| 全车状态查询 | 19 | `{cmd_type:2}` |

（上游表里 `setSeatHeat`、`setSeatVentilation`、`openTrunkPower`、`setACTemperature` 等 26 行标 `compound`、未拆参数，不参与比对；`setSteerHeat`、`setFridge` 等虽在表中给了数字通道，但在我们的语料里没有对应实测，也不按「已验」计。）

## 候选：直接补齐我们的未打通项

优先级按「我们已明确记为未打通」降序。全部为**单次可逆下发可判**。

1. **前除霜** `service_type:3 / {cmd_type:4,cmd_value:1|0}`。我们 `ct=10` 试探无回执、当时记为「疑为除霜但未确认」。注意我方 `3/4` 是**只读查状态**（不带 `cmd_value`），上游 `3/4` 是**写除霜**（带 `cmd_value`）——两者不冲突的前提是「带与不带 `cmd_value` 走不同分支」，这一点未经证实，见「冲突」。
2. **后除霜** `3 / {cmd_type:14,cmd_value:1|0}`。**与我们记录的 `10342 空调香氛通道调节失败` 冲突**（见「冲突」一节）。
3. **后视镜加热** `3 / {cmd_type:15,cmd_value:1|0}`。
4. **座椅加热 / 通风** `service_type:30 / {cmd_type,cmd_value,mode}`：`cmd_type` 1 主驾、0 副驾（P7+ 副驾为 2，见「冲突」）、3 左后、4 右后；`cmd_value` 1 加热、2 通风；`mode` 0 关、1/2/3 档位。我们已接 0 条，且 `vehicles.ts` 里 `*_seat_heat` 字段能读到。
5. **半度温度** `3 / {cmd_type:16,cmd_value:<浮点>}`。我们只接了整数 `ct=2`；上游依 `HVAC_TEMP_SUPPORT_FLOAT` 车型走 `ct=16`。配套字段可能是 `hvac_temp_float`（本机录音语料里 0 命中）。
6. **交流充电电流** `service_type:4 / {cmd_type:7,cmd_value:<索引>}`，索引 1–27 对应 6–32 A，显示值 = 索引 + 5。上游 `charge_current.py` 明确「索引不是安培」，并记录早期把这个当安培用造成误标。
7. **充电限值** `4 / {cmd_type:2,cmd_value:<50-100>}`；**电池预热** `4 / {cmd_type:5,cmd_value:1|0}`；**起/停充电** `4 / {cmd_type:1,cmd_value:1|0}`；**对外放电** `4 / {cmd_type:6,cmd_value:1|0}`；**快充口开合** `4 / {cmd_type:4}`、**慢充口开合** `4 / {cmd_type:3}`。
8. **方向盘加热** `service_type:31 / {cmd_type:1,cmd_value:0-3}`。**与我们记的「`31–70` 全部不支持」冲突**（见「冲突」）。
9. **空调静音模式** `3 / {cmd_type:17,cmd_value:1|0}`（上游记录仅在「宠物模式已激活」时于 FJ 实测）。
10. **可变遮阳帘** `12 / {cmd_type:2}`（前）、`12/{cmd_type:3}`（后）、`12/{cmd_type:5}`（顶）。我们只验了 `12/4` 天窗遮阳帘。
11. **唤醒 / 状态查询变体** `19 / {cmd_type:1}`、`19 / {cmd_type:0}`。我们只验了 `ct=2`。
12. **冰箱** `32 / {cmd_type:1-4}`。D55 大概率没有该硬件，先查能力表再决定是否探。
13. **超级锁 / 超级解锁** `9 / {cmd_type:11,cmd_value:3|1}`、**机盖** `9 / {cmd_type:10,cmd_value:1}`、**下车保持上电** `9 / {cmd_type:12}`。均有安全影响，**不进本轮范围**。

## 冲突：2026-11-16 已实测裁决

下面每一条都已在 D55 上单次下发实测，**结论已定**。实测都选可逆动作，结束后车况已确认恢复（车门锁、后备箱关、四窗升、空调关、座椅加热关）。

1. **`3/14` 是后挡除霜，上游对、我们错**。下发 `3/{cmd_type:14,cmd_value:1|0}`，车端回 `10340 后挡除霜开启失败` / `10341 后挡除霜关闭失败`，消息文本直接写明「后挡除霜」。我们旧记录的「香氛」是把 vdex 方法名 `OpenFragrance` 错配到通道号上。本车开启被拒、关闭可执行。
2. **`3/4` 是前除霜，我们错**。`{cmd_type:4,cmd_value:1}` 回 `10307 开启除霜失败`，`cmd_value:0` 回 `200` 并带 `hvac_defrost:0`。把空调开起来（`hvac_on:1`）再试一次仍回 `10307`，所以不是前置条件问题，是车型限制。旧记录「`{cmd_type:4}` 是读状态」作废——状态一律读 `st=19`。
3. **`31–70` 全部不支持是错的**。`service_type:31` 带 `{cmd_type:1,cmd_value:1}` 回 `13102 方向盘加热调节失败`、`cmd_value:0` 回 `13103 方向盘加热关闭失败`，是语义拒绝码而不是 `code:8`。通道存在，本车无该硬件。旧断言作废，32–70 仍未逐个验证。
4. **后备箱有云端 MQTT 通道，但本车不执行**。`9/{cmd_type:2,cmd_value:1}` 回 `code:200`，`cmd_value:3` 回 `10904 后尾箱关闭失败`。旧记录 `code:8` 是**漏发 `cmd_value`** 造成的假阴性。但下发后 `trunk_ajar_st` 全程为 0，物理上没有开箱，所以本车开合仍需 BLE。结论：通道可用、指令被接受、本车不执行。
5. **`3/11`–`3/13` 仍未定论**，本轮未测。

## 状态字段：本车与上游的差异（2026-11-16 抓取）

本车 `st=19` 全量状态共 **99 个叶子字段**，其中 `instant` 下 74 个。上游 124 字段表里的这些**本车一个都没有**：`trunk_ajar_st_new`、`hvac_temp_float`、`hvac_inner_temp_float`、`hvac_silent_mode`、`hvac_mirror_heat_mode`、`steering_wheel_heat`、`bonnet_ajar_st`、`electric_current_limit`、`discharge_capacity`、`vehicleMode`。

能对上的有 `instant.drive.shift_state`、`instant.hvac.hvac_defrost`、`interval.charge.charge_rate`。所以**上游字段表不能当本车字段表用**：凡依赖这些字段的能力（半度温度、方向盘加热状态、充电电流限值、机盖状态）在本车都拿不到回读，只能看指令回执。

## CanPack topic 在国内 broker 上不存在（2026-11-16）

上游记录的 6 个 CanPack 候选 topic（`Xmart/Car/+/State/CanPack1s`、`Xmart/Tbox/+/CanPack1s`、`Xmart/TboxD21B/+/CanPack1s`、`Xmart/Tbox/+/StatPack`、`Xmart/Car/+/CanPackV2/Repub`、`Xmart/Client/Connect/+`）**全部被 broker 拒绝订阅**，回 `Unspecified error`，不是「订阅成功但零帧」。国内 broker 上不存在这些 topic，那条观测面无法复用。

## 上游自身的已知不可靠处

采信前必须知道：

- 上游文档里 `setSeatHeat` / `setSeatVentilation` 标 `compound` 未拆参数，但 `docs/SEAT_COMMANDS.md` 给了完整矩阵——**同一仓库内文档互相矛盾**。
- 上游 `lock` / `unlock` 在表里标 `default/omitted (unresolved)`，实际代码固定用 `cmd_type:0/1`。**它们是拿代码不是拿文档在跑**。
- 上游明说「Source discovery is not physical verification」，`docs/ANDROID_COMMAND_AUDIT.md` 里后备箱、限值、座椅等是有实测的，但方向盘加热、冰箱、车外放电等只有拒绝码或未验。
- 上游 12 条限制里有一条直接适用于我们：一个账号只允许一个 MQTT 会话，第二会话会踢掉第一个。这与本仓库「单会话约束」一致。

## 验收判据（每条都必须全中才算通过）

1. 回执 `code:200`；
2. 下发后**等 ≥50 秒**再读 `st=19`，对应字段确实改变；
3. 对照组（不发指令、连续读三次）同一字段稳定；
4. 恢复原值并确认已恢复。

第 2 条来自上游实测：车端「下发→生效→上报」窗口是 7–50 秒，早于窗口读到的是**命令前**的值，上游因此把 `mode 3` 长期误读为「关闭」。本仓库「探测的边界」一节的悬案「遮阳帘 99→48 跳变」很可能是同类读早问题（**推论，未验证**）。

## 剩余待复核（按性价比排序）

前四条已于 2026-11-16 完成，见「冲突」一节。剩下这些：

1. **`3/11`–`3/13` 的归属**：仍未有定论。重发时把当次完整的 `msg_content` 记进原始记录——本仓库旧记录缺 `cmd_value`，正是这一缺陷造成了此前两条冲突。
2. **座椅 `30`**：四条 `cmd_type` × 加热/通风，是我们完全空白的一块。本车 `st=19` 有 8 个 `*_seat_heat` / `*_seat_ventilation` 字段可作回读，验收条件齐备。
3. **半度温度 `3/16`**：本车没有 `hvac_temp_float` 字段，即使指令被接受也无法回读，只能看回执码。
4. **充电电流 `4/7` 的索引语义**：上游声称索引 1–27 = 6–32 A。本车没有 `electric_current_limit` 字段，同样只能看回执，且需插枪状态才可判。
5. **`32`–`70` 逐个验证**：`31` 已证通道存在，说明这一区间不能整体当作不支持。

## 本轮做了什么、没做什么

做了：

- refreshToken 续期失败（`12010206`，RT 已过期）后重走了一次完整登录，令牌与 MQTT 凭据均已更新，`work/live/` 下资产为 2026-11-16。
- 抓了一次 `st=19` 全量状态（99 个叶子字段）与 6 个 CanPack 候选 topic 的订阅结果。
- 四条下发实测：后备箱、`3/4`、`31`、`3/14`，全部可逆并已恢复原值。

没做：

- 未改 `packages/protocol/src/commands.ts`。`3/4`、`3/14`、后备箱三条在本车都只到「通道存在、开启被拒或不执行」，没有一条满足「字段确实变化」的验收判据，不构成可接入的指令。
- 未测座椅、半度温度、充电电流。
- 未改动 BLE 相关代码与文档。

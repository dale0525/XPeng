/**
 * 直线召唤：RPA 心跳帧（`ef 03 02` + mode + counter）。
 *
 * 帧格式取自 `scripts/rpa_frame.py` 的结论，那是唯一有一手依据的部分：
 * 前缀恒为 `ef0302`，第 4 字节是 mode，第 5 字节是 **7 位计数器**，`0x7f` 之后
 * 回 `0x00`（`(counter + 1) & 0x7f`）。口径与 `docs/research/xpeng-app-teardown.md`
 * §6.6 一致：泊车心跳（`createParkingHeartbeatMessage`）是唯一 headerType 传 3
 * 的调用点，`0xEF` 通道就是这条，且它没有 TBox 那层 `[len][crc32][type]`。
 *
 * 发帧走原生模块已有的 `write(hex, promise)`（`XpengBleModule.kt`），也就是
 * `ble.ts` 里 `NativeBleTransport.write` 用的同一个方法：它把帧写到**当前已订阅
 * 的那条 GATT 链路**上，与车辆数字钥匙共用同一条连接。前提很硬——没有活动连接
 * 时原生层以 `E_NOT_READY / BLE not subscribed` 拒绝（`gatt == null ||
 * writer == null || connecting != null`）。所以发帧失败就按失败报给界面，不伪造成功。
 *
 * 仍**未确认**的部分，代码里不做猜测性断言：
 *
 * 1. **mode 的具体取值未确认**。`scripts/test_rpa_frame.py` 的用例里 0x01 前、
 *    0x02 后、0x00 空闲、0x07 退出，但那是脚本自身的形状断言，不是抓包结论；
 *    文档侧只确认了「泊车心跳走 0xEF」。
 * 2. **发帧间隔未确认**。`rpa_frame.py` 只按帧数出帧，没有时间维度，抓包也没
 *    记录相邻心跳的时间差。因此这里不设定时器、不编毫秒数：一次按下发一帧，
 *    由界面按住时长决定发几帧。
 * 3. **是否需要配对/鉴权未确认**。数字钥匙握手是 `0xEF` 4B/16B + `0xED` 17B
 *    三段、车控内层是 `XPBKTH`；RPA 心跳是否必须夹在同一会话的握手之后、是否
 *    依赖服务端泊车限距配置，均未验证。
 * 4. **进入召唤态的前置激活帧没有闭环**。`docs/research/xpeng-app-teardown.md`
 *    §6.18 只留下常量名 `BLE_CAR_ACTIVE_RPA` / `REQ_ENTER_BLE_PARK` /
 *    `BLE_CAR_ACTIVE_RPA_IN_HEART`，没有抓到任何一条的字节形状（`scripts/rpa_frame.py`
 *    也只产出心跳本身）。所以这里**只能**发心跳，不能伪造激活帧：车端没有收到
 *    激活时不会因心跳而动。`SummonResult.activated` 恒为 false 就是为此，
 *    界面据此显示「未进入召唤态」，而不是把「帧写出去了」说成「车辆正在召动」。
 */
import { NativeModules } from 'react-native';
import { toHex } from '@xpeng/protocol/src/bytes';

export type SummonDirection = 'forward' | 'backward';

export interface SummonResult {
  /** 帧真的写进原生 BLE 队列时为 true；连接不存在或写入失败为 false。 */
  ok: boolean;
  /** 本次构造出的心跳帧（小写 hex）。 */
  frame: string;
  /** 本次调用是否带未确认参数。当前恒为 true —— 见文件头三条「未确认」。 */
  unconfirmed: boolean;
  /** 未确认项的说明，`ok` 时可作为界面灰字。 */
  note: string;
  /** 发帧失败原因；`ok === false` 时有值。原样保留原生错误码与原文。 */
  error?: string;
  /**
   * 车端是否真的进入召唤态。**恒为 false**：进入召唤态的激活帧（`BLE_CAR_ACTIVE_RPA`）
   * 没有抓到字节形状，本模块只发心跳。界面必须据此区分「帧发出去了」与「车在动」。
   */
  activated: boolean;
  /** `activated === false` 时给界面看的前置未满足原因。 */
  prerequisite?: string;
}

interface BleWriteBridge {
  write(hex: string): Promise<void>;
}

const bridge = NativeModules.XpengBle as BleWriteBridge | undefined;

const HEARTBEAT_PREFIX = Uint8Array.from([0xef, 0x03, 0x02]);

/** 未确认：0x01 前、0x02 后、0x00 停，来自脚本用例而非抓包。 */
const MODE = { forward: 0x01, backward: 0x02, stop: 0x00 } as const;

/** 7 位计数器；`0x7f` 之后回 `0x00`。 */
let counter = 0;

function heartbeatFrame(mode: number): Uint8Array {
  const frame = new Uint8Array(5);
  frame.set(HEARTBEAT_PREFIX);
  frame[3] = mode;
  frame[4] = counter;
  counter = (counter + 1) & 0x7f;
  return frame;
}

const NOTE = '当前召唤参数未实测（mode 取值与发帧间隔均无抓包依据）';

/**
 * 召唤态前置：车端需要一个激活帧才会响应心跳。该帧字节形状没有取证
 * （`docs/research/xpeng-app-teardown.md` §6.18 只有常量名），所以本模块发不出来，
 * 必须把这句如实交给界面，不能把「心跳已写出」当成「车已在召动」。
 */
const PREREQUISITE = '未进入召唤态：车端激活帧（BLE_CAR_ACTIVE_RPA）尚无取证，本模块只发心跳，车不会动';

async function send(mode: number): Promise<SummonResult> {
  const frame = toHex(heartbeatFrame(mode));
  if (!bridge) {
    return {
      ok: false,
      frame,
      unconfirmed: true,
      note: NOTE,
      error: '未找到原生 BLE 模块（NativeModules.XpengBle 为空）',
      activated: false,
      prerequisite: PREREQUISITE,
    };
  }
  try {
    await bridge.write(frame);
    return { ok: true, frame, unconfirmed: true, note: NOTE, activated: false, prerequisite: PREREQUISITE };
  } catch (e) {
    // 原生拒写的原文必须原样带上：`E_NOT_READY / BLE not subscribed` 表示当前没有
    // 活动 GATT 链路（XpengBleModule.kt 的 write 里 gatt == null || writer == null），
    // 这是「按下去没反应」的真实原因，界面要显示它而不是笼统的「失败」。
    return {
      ok: false,
      frame,
      unconfirmed: true,
      note: NOTE,
      error: `发帧失败：${e instanceof Error ? e.message : String(e)}`,
      activated: false,
      prerequisite: PREREQUISITE,
    };
  }
}

/** 开始向某个方向召唤：写一帧心跳。每次调用推进计数器。 */
export function startSummon(direction: SummonDirection): Promise<SummonResult> {
  return send(MODE[direction]);
}

/** 停止召唤（mode 0x00，未确认）。松手与离开弹窗都要调。 */
export function stopSummon(): Promise<SummonResult> {
  return send(MODE.stop);
}
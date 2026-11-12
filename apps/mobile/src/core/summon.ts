/**
 * 直线召唤：把会话状态机接到真实的蓝牙链路上。
 *
 * 帧与节奏的事实来源、以及「进入召唤态是一条指令码 0x03 的车控帧」这一结论，
 * 写在 `summon-session.ts` 的文件头。这里只负责三件接线：
 *
 * 1. **激活**走 `bleLink.executeV2(vin, RPA_ACTIVATE_COMMAND)`：它与解锁/上锁是
 *    同一条 V2 车控路径，会消耗一行服务端一次性材料，并在当前常驻连接上完成握手。
 *    因此召唤必须与数字钥匙共用同一条 GATT 链路，不能自己另开连接。
 * 2. **心跳**走 `NativeModules.XpengBle.write`，也就是 `ble.ts` 的
 *    `NativeBleTransport.write` 用的同一个方法。没有活动连接时原生以
 *    `E_NOT_READY / BLE not subscribed` 拒绝，这个原文要如实报给界面。
 * 3. **计时器**用 JS `setInterval`：这是前台的按住操作，用户手指按着、屏幕亮着，
 *    不涉及息屏后的挂起问题（后台循环才有那个约束，见 `ble.ts`）。
 */
import { NativeModules } from 'react-native';
import { toHex } from '@xpeng/protocol/src/bytes';
import { RpaSession, type SummonDirection } from './summon-session';
import { bleLink } from './ble';

export type { SummonDirection };

/** 进入召唤态的指令码。抓包中官方 App 进页面后即发这一条（详见 `summon-session.ts`）。 */
export const RPA_ACTIVATE_COMMAND = 0x03;

export interface SummonResult {
  /** 帧真的写进原生 BLE 队列时为 true；连接不存在或写入失败为 false。 */
  ok: boolean;
  /** 本次调用的结果说明；成功时是空串。 */
  error?: string;
  /** 车端是否已进入召唤态（激活帧被车端接受）。 */
  activated: boolean;
}

interface BleWriteBridge {
  write(hex: string): Promise<void>;
}

const bridge = NativeModules.XpengBle as BleWriteBridge | undefined;

let onInterrupt: ((message: string) => void) | null = null;

const session = new RpaSession({
  async activate() {
    const vin = bleLink.currentVin();
    if (!vin) throw new Error('没有已准备的车辆：蓝牙钥匙尚未就绪');
    // 激活命令没有 0x0070 控制回执（整场真车会话都没有），不能按默认等回执，否则会误报超时。
    await bleLink.executePreparedV2(vin, RPA_ACTIVATE_COMMAND, false);
  },
  async write(frame) {
    if (!bridge) throw new Error('未找到原生 BLE 模块（NativeModules.XpengBle 为空）');
    await bridge.write(toHex(frame));
  },
  startTicker(everyMs, tick) {
    const id = setInterval(tick, everyMs);
    return () => clearInterval(id);
  },
  delay(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  },
  onInterrupted(message) {
    onInterrupt?.(message);
  },
});

/**
 * 进入召唤态。按钮按下时调用一次。
 *
 * 失败必须让界面看到真实原因（材料被拒、握手失败、车端回非 200），
 * 因为这三种都意味着「车没进召唤态，按方向不会有反应」。
 */
export async function enterSummon(onInterrupted: (message: string) => void): Promise<SummonResult> {
  onInterrupt = onInterrupted;
  try {
    await session.enter();
    return { ok: true, activated: true };
  } catch (error) {
    return {
      ok: false,
      activated: false,
      error: `进入召唤态失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 按住某个方向：切模式并立刻写一帧，之后由心跳维持。 */
export async function startSummon(direction: SummonDirection): Promise<SummonResult> {
  try {
    await session.move(direction);
    return { ok: true, activated: true };
  } catch (error) {
    return { ok: false, activated: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 松手：立刻回到待机心跳。 */
export async function haltSummon(): Promise<SummonResult> {
  try {
    await session.halt();
    return { ok: true, activated: true };
  } catch (error) {
    return { ok: false, activated: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 退出召唤态：停心跳、按心跳节奏连发退出帧。界面关闭前调用。 */
export async function exitSummon(): Promise<void> {
  onInterrupt = null;
  await session.exit();
}


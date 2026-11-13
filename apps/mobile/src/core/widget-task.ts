/**
 * 桌面组件点击后的无界面任务。
 *
 * 组件上的按钮不走界面，由原生 `WidgetHeadlessService` 起这个任务，在后台完成：
 * 确保登录态 → 拉车辆 → 建 MQTT 连接（P5 另需准备 BLE V2）→ 下发 → 回写读数快照。
 *
 * 任务必须自己 resolve：RN 的 HeadlessJsTask 只有在返回的 Promise 结束后才会
 * 释放 wake lock 与 JS 运行时。抛异常会让任务停在 pending，锁一直不放。
 */
import { AppRegistry } from 'react-native';
import { runWidgetCommand } from '../core/widget-bridge';
import { xpLog } from '../core/native';

interface WidgetTaskData {
  commandId?: string;
  nightMode?: boolean;
}

async function widgetActionTask(data: WidgetTaskData): Promise<void> {
  const commandId = data?.commandId ?? '';
  xpLog('widget', `headless start command=${commandId || '(none)'} night=${data?.nightMode === true}`);
  if (!commandId) return;
  try {
    const outcome = await runWidgetCommand(commandId);
    if (outcome.ok) {
      xpLog('widget', `headless done command=${commandId} ok`);
    } else {
      xpLog('widget', `headless done command=${commandId} reason=${outcome.reason} detail=${outcome.detail}`, 'w');
    }
  } catch (e) {
    xpLog('widget', `headless failed command=${commandId} ${e instanceof Error ? e.message : String(e)}`, 'e');
  }
}

/** 任务名与 `WidgetHeadlessService.TASK_KEY` 必须逐字一致。 */
AppRegistry.registerHeadlessTask('XpengWidgetAction', () => widgetActionTask);

/**
 * 远程查看（实时视频视角）：`service_type 11` 的 MQTT 下发。
 *
 * 报文形状来自车主账号真机逐项点击取证（docs/research/xpeng-app-teardown.md §5.7）：
 * `{"cmd_type":2,"cmd_value":N,"pushType":1,"protocolType":2}`，`pushType` /
 * `protocolType` 恒定。`cmd_value` 映射严格照文档：
 *
 *   - 2  前视（初始化 / 默认视角，回执 `camera_type=1`）
 *   - 3  后视（→ 3）
 *   - 4  左视（→ 5）
 *   - 5  右视（→ 7）
 *   - 11 启动拉流（首次回执带 `camera_live_url`）
 *   - -1 关闭（回执 `camera_type=0`）
 *
 * 这三条不在 `commands.ts` 的 `COMMANDS` 里——那张表是车控页的固定指令集，
 * 这里按需构造临时 `CommandDef`。`group` 借用现有合法值 `'sentinel'`：这组 id
 * 不参与车控页的指令表，不会被渲染成按钮。
 *
 * 回执里的 `camera_live_url` 是运行时凭据：本模块不打印、不落盘，UI 也不展示。
 */
import type { CommandDef } from '@xpeng/protocol/src/commands';
import { carLink, type CommandResult } from './car';

const REMOTE_VIEW_SERVICE_TYPE = 11;

/** 视角 → `cmd_value`。前视同时是初始化视角。 */
const VIEW_CMD_VALUE = { front: 2, back: 3, left: 4, right: 5 } as const;

export type RemoteViewAngle = keyof typeof VIEW_CMD_VALUE;

const CLOSE_CMD_VALUE = -1;
const START_STREAM_CMD_VALUE = 11;

function remoteViewCommand(id: string, label: string, cmdValue: number): CommandDef {
  return {
    id,
    label,
    group: 'sentinel',
    serviceType: REMOTE_VIEW_SERVICE_TYPE,
    msgContent: {
      cmd_type: 2,
      cmd_value: cmdValue,
      pushType: 1,
      protocolType: 2,
    },
  };
}

/**
 * 打开远程查看：先 `cmd_value 2` 初始化到前视，成功后 `cmd_value 11` 拉流。
 *
 * 返回拉流那一条的回执；初始化失败就直接返回初始化的失败结果，不再下发拉流——
 * 没有初始化过的会话下发 11 没有意义。
 *
 * 拉流成功后再补发一次前视：真机实测（2026-11-11）开流前发的视角在流尚未启动时
 * 不生效，画面仍是上一次查看时的角度（回执却回 `camera_type=1`）；用户当时手动点
 * 一下「前视」画面就对了，说明视角要在流启动之后再发一次才落到编码器上。因此这里
 * 照同一动作补一条，避免刚进去看到的是别的视角。
 *
 * 返回值始终是拉流那条的回执：`camera_live_url` 只在它里面，补发的切视角回执没有
 * 流地址，不能拿它顶替。
 */
export async function openRemoteView(): Promise<CommandResult> {
  const init = await carLink.send(remoteViewCommand('remoteView.init', '远程查看初始化', VIEW_CMD_VALUE.front));
  if (!init.ok) return init;
  const stream = await carLink.send(remoteViewCommand('remoteView.stream', '远程查看拉流', START_STREAM_CMD_VALUE));
  if (!stream.ok) return stream;
  // 补发失败不影响「已开流」的判定：画面在播，只是角度可能还停在上一次。
  await carLink.send(remoteViewCommand('remoteView.front', '远程查看切回前视', VIEW_CMD_VALUE.front));
  return stream;
}

/** 切换单路视角。前视也用这里（`cmd_value 2`），文档里从其它视角切回前视同样是它。 */
export function switchView(angle: RemoteViewAngle): Promise<CommandResult> {
  return carLink.send(remoteViewCommand(`remoteView.${angle}`, '远程查看切换视角', VIEW_CMD_VALUE[angle]));
}

/** 关闭远程查看：`cmd_value -1`，回执 `camera_type=0`、流地址消失。 */
export function closeRemoteView(): Promise<CommandResult> {
  return carLink.send(remoteViewCommand('remoteView.close', '关闭远程查看', CLOSE_CMD_VALUE));
}
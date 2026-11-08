export type CustomCommandId =
  | 'doorLock'
  | 'remoteUnlock'
  | 'acOn'
  | 'flash'
  | 'windowClose'
  | 'windowVent'
  | 'shadeOpen'
  | 'shadeClose'
  | 'quickCool'
  | 'quickWarm'
  | 'highTempSterilize'
  | 'sentinelOn'
  | 'sentinelOff'
  | 'tailgateOpen'
  | 'tempPark';

const CUSTOM_COMMAND_IDS: readonly CustomCommandId[] = [
  'doorLock', 'remoteUnlock', 'acOn', 'flash', 'windowClose', 'windowVent',
  'shadeOpen', 'shadeClose', 'quickCool', 'quickWarm', 'highTempSterilize',
  'sentinelOn', 'sentinelOff', 'tailgateOpen', 'tempPark',
];

export const DEFAULT_CUSTOM_COMMAND_IDS: readonly CustomCommandId[] = [
  'doorLock', 'remoteUnlock', 'acOn', 'flash',
];

const VALID_IDS = new Set<string>(CUSTOM_COMMAND_IDS);

export function parseQuickCommands(saved: string | null): CustomCommandId[] {
  if (!saved) return [...DEFAULT_CUSTOM_COMMAND_IDS];
  try {
    const ids: unknown = JSON.parse(saved);
    if (!Array.isArray(ids)) return [...DEFAULT_CUSTOM_COMMAND_IDS];
    return ids
      .filter((id): id is CustomCommandId => typeof id === 'string' && VALID_IDS.has(id))
      .slice(0, 4);
  } catch {
    return [...DEFAULT_CUSTOM_COMMAND_IDS];
  }
}

/**
 * 主题：亮/暗两套 CSS 变量 + 用户偏好。
 *
 * 组件里只写 `bg-surface` 这类语义类，取值由根节点注入的 `--c-*` 变量决定；
 * 切换主题 = 换一组变量，不重写任何 className。取值在 `colors.ts`。
 */
import { useCallback, useEffect, useState } from 'react';
import { Appearance } from 'react-native';
import { vars } from 'nativewind';
import { DARK_COLORS, LIGHT_COLORS, toVars } from './colors';
import { native, StorageKey } from './native';

export type ThemeMode = 'system' | 'light' | 'dark';

const LIGHT_VARS = toVars(LIGHT_COLORS);
const DARK_VARS = toVars(DARK_COLORS);

/** 当前应生效的亮暗。`system` 跟随系统设置。 */
export function resolveScheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
}

/**
 * 根节点用的 style：把对应的一套变量注入进去。
 *
 * 返回的对象必须**原样**传给 `style`（或放进 style 数组），不能展开成普通对象：
 * NativeWind 把变量元数据挂在 WeakMap 上，键就是这个对象的引用，`{ ...vars }`
 * 会得到一个空对象，所有 `--c-*` 变量随之消失（表现为全页面无配色、边框变黑）。
 */
export function themeVars(scheme: 'light' | 'dark') {
  return scheme === 'dark' ? DARK_STYLE : LIGHT_STYLE;
}

const LIGHT_STYLE = vars(LIGHT_VARS);
const DARK_STYLE = vars(DARK_VARS);

export function useThemeMode(): [ThemeMode, (m: ThemeMode) => void, 'light' | 'dark'] {
  const [mode, setMode] = useState<ThemeMode>('system');
  const [scheme, setScheme] = useState<'light' | 'dark'>(() => resolveScheme('system'));

  useEffect(() => {
    native.storageGet(StorageKey.theme).then((saved) => {
      const m = (saved as ThemeMode) || 'system';
      setMode(m);
      setScheme(resolveScheme(m));
    });
  }, []);

  // 系统主题变化时，只有 system 模式需要跟着变
  useEffect(() => {
    const sub = Appearance.addChangeListener(() => {
      setMode((cur) => {
        if (cur === 'system') setScheme(resolveScheme('system'));
        return cur;
      });
    });
    return () => sub.remove();
  }, []);

  const update = useCallback((m: ThemeMode) => {
    setMode(m);
    setScheme(resolveScheme(m));
    native.storageSet(StorageKey.theme, m).catch(() => {});
  }, []);

  return [mode, update, scheme];
}

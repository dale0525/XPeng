/**
 * 应用内更新：查 GitHub Releases 最新版 → 比版本 → 应用内下载 → 交给系统安装器。
 *
 * 下载源固定是本仓库的 releases，不接受任何外部输入的地址：更新包一旦被换成别人
 * 签名的 APK，安装器会因签名不符直接拒绝，所以这里不做额外校验，也不引入镜像配置。
 *
 * 分架构包的命名由 `.github/workflows/release.yml` 决定，两边必须一起改。
 */
import { NativeEventEmitter, NativeModules } from 'react-native';
import { useCallback, useEffect, useRef, useState } from 'react';

const REPO = 'dale0525/XPeng';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

const Updater = NativeModules.XpengUpdater as {
  versionInfo(): Promise<{ versionName: string; versionCode: number; abi: string }>;
  fetchText(url: string): Promise<string>;
  download(
    url: string,
    fileName: string,
  ): Promise<{ path: string; bytes: number }>;
  install(filePath: string): Promise<void>;
};

if (!Updater) {
  throw new Error('XpengUpdater 原生模块未注册：检查 MainActivity 里的 add(XpengNetPackage())');
}

export interface VersionInfo {
  versionName: string;
  versionCode: number;
  abi: string;
}

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  notes: string;
  assets: ReleaseAsset[];
}

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; release: ReleaseInfo; asset: ReleaseAsset }
  | { kind: 'downloading'; release: ReleaseInfo; asset: ReleaseAsset; done: number; total: number }
  | { kind: 'installing'; release: ReleaseInfo }
  | { kind: 'failed'; message: string };

export function currentVersion(): Promise<VersionInfo> {
  return Updater.versionInfo();
}

/** 取最新正式版。草稿与预发布不会出现在 `releases/latest` 里，正合本项目需要。 */
export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const raw = await Updater.fetchText(API_LATEST);
  const json = JSON.parse(raw) as {
    tag_name?: string;
    body?: string;
    assets?: Array<{ name?: string; browser_download_url?: string }>;
  };
  const tag = json.tag_name;
  if (!tag) throw new Error('release 缺少 tag_name');
  return {
    tag,
    version: tag.replace(/^v/, ''),
    notes: (json.body ?? '').trim(),
    assets: (json.assets ?? [])
      .filter((a) => a.name && a.browser_download_url)
      .map((a) => ({ name: a.name as string, url: a.browser_download_url as string })),
  };
}

/**
 * 按设备主 ABI 选包：arm64-v8a / armeabi-v7a 各有分架构包，其余架构退到 universal。
 * 找不到对应 asset 时抛错——静默挑一个别的架构包装上去，安装器只会报「应用未安装」。
 */
export function pickAsset(release: ReleaseInfo, abi: string): ReleaseAsset {
  const suffix = abi === 'arm64-v8a' || abi === 'armeabi-v7a' ? abi : 'universal';
  const wanted = `xpcarinfo-${release.version}-${suffix}.apk`;
  const found = release.assets.find((a) => a.name === wanted);
  if (found) return found;
  const universal = release.assets.find(
    (a) => a.name === `xpcarinfo-${release.version}-universal.apk`,
  );
  if (universal) return universal;
  throw new Error(`该版本没有适合 ${abi} 的安装包`);
}

/** 逐段比数字：`0.10.0` 要大于 `0.9.0`，字符串比较会判反。 */
export function isNewer(candidate: string, installed: string): boolean {
  const a = candidate.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const b = installed.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** 下载进度事件；返回取消订阅函数。 */
export function onProgress(cb: (done: number, total: number) => void): () => void {
  const emitter = new NativeEventEmitter(NativeModules.XpengUpdater);
  const sub = emitter.addListener('xpeng-update-progress', (e) => {
    const p = e as unknown as { done: number; total: number };
    cb(p.done, p.total);
  });
  return () => sub.remove();
}

export function downloadAsset(asset: ReleaseAsset): Promise<string> {
  return Updater.download(asset.url, asset.name).then((r) => r.path);
}

export function installApk(path: string): Promise<void> {
  return Updater.install(path);
}

/**
 * 系统安装器的结果事件。
 *
 * 装成功时本进程会被替换掉，用户再打开 App 就是新版本，所以这个事件主要用于
 * 失败与取消：签名不一致、降级安装、用户点了取消——原来这些情况界面都会永远
 * 停在「正在唤起系统安装器」。
 */
export function onInstallResult(cb: (ok: boolean, message?: string) => void): () => void {
  const emitter = new NativeEventEmitter(NativeModules.XpengUpdater);
  const sub = emitter.addListener('xpeng-update-install-result', (e) => {
    const r = e as unknown as { ok: boolean; message?: string };
    cb(r.ok, r.message);
  });
  return () => sub.remove();
}

/**
 * 「关于」卡片的状态机。检查与下载都由用户点出来，不做启动自动检查——
 * 这个 App 的主要用途是车控，启动路径上不该多一个网络请求。
 */
export function useUpdater() {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    currentVersion()
      .then(setVersion)
      .catch(() => setState({ kind: 'failed', message: '读取当前版本失败' }));
    return () => unsubRef.current?.();
  }, []);

  const check = useCallback(async () => {
    if (!version) return;
    setState({ kind: 'checking' });
    try {
      const release = await fetchLatestRelease();
      if (!isNewer(release.version, version.versionName)) {
        setState({ kind: 'current', version: version.versionName });
        return;
      }
      setState({ kind: 'available', release, asset: pickAsset(release, version.abi) });
    } catch (e) {
      setState({ kind: 'failed', message: describeError(e) });
    }
  }, [version]);

  const download = useCallback(async () => {
    if (state.kind !== 'available' || !version) return;
    const { release, asset } = state;
    setState({ kind: 'downloading', release, asset, done: 0, total: 0 });
    unsubRef.current = onProgress((done, total) => {
      setState({ kind: 'downloading', release, asset, done, total });
    });
    try {
      const path = await downloadAsset(asset);
      unsubRef.current?.();
      unsubRef.current = null;
      setState({ kind: 'installing', release });
      // 安装器是独立 Activity，拉起后必须等它的结果事件，否则界面永远停在
      // 「正在唤起系统安装器」。装成功时进程会被替换，这个回调用不上；它真正
      // 负责的是失败与取消——签名不一致、降级安装、用户点了取消。
      unsubRef.current = onInstallResult((ok, message) => {
        unsubRef.current?.();
        unsubRef.current = null;
        if (ok) {
          // 装成功通常伴随进程重启；万一没重启，退回「当前已是最新」而不是继续转圈。
          setState({ kind: 'current', version: release.version });
          return;
        }
        setState({ kind: 'failed', message: describeInstallFailure(message) });
      });
      await installApk(path);
    } catch (e) {
      unsubRef.current?.();
      unsubRef.current = null;
      setState({ kind: 'failed', message: describeError(e) });
    }
  }, [state, version]);

  return { version, state, check, download };
}

/** 系统安装器回报的原文，翻译成能指导用户动作的一句话。 */
function describeInstallFailure(message?: string): string {
  const raw = message ?? '';
  if (/签名|signature|INSTALL_FAILED_UPDATE_INCOMPATIBLE/i.test(raw)) {
    return `安装包签名与已装版本不一致，系统拒绝覆盖。${raw}`;
  }
  if (/降级|downgrade|INSTALL_FAILED_VERSION_DOWNGRADE/i.test(raw)) {
    return `这是比已装版本更旧的包，系统拒绝降级安装。${raw}`;
  }
  return raw || '安装未完成（可能点了取消）';
}

function describeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // 原生 reject 的 message 形如 "HTTP 403" / "Unable to resolve host ..."
  if (/HTTP 403/.test(raw)) return '访问 GitHub 被限流（HTTP 403），稍后再试';
  if (/HTTP 404/.test(raw)) return '还没有任何 release（HTTP 404）';
  if (/Unable to resolve host|E_UPDATE_NET/.test(raw)) return '网络不可达，检查连接后重试';
  return raw;
}

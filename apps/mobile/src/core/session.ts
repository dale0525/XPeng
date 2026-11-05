/**
 * 会话：一次登录永久有效，靠后台定时续期维持。
 *
 * 续期策略（对应「token 自动续期、续期失败时提示重新登录」）：
 * - accessToken 真实寿命约 2.5 h，比声明的 7200 s 宽约 33 分钟；
 * - 每 30 分钟续一次，成功就覆盖本地 RT（服务端会轮换 RT，旧的立即失效）；
 * - 任何一次续期失败 → 标记 `relogin`，UI 弹「重新登录」，不再自动重试
 *   （失败多半是 RT 已被官方 App 抢登录顶掉，重试只会持续 401）。
 */
import { XpApi } from '@xpeng/protocol/src/api';
import { ApiError } from '@xpeng/protocol/src/api';
import { CODE_TOKEN_EXPIRED, refreshSession, type Session } from '@xpeng/protocol/src/session';
import { native, StorageKey } from './native';
import { nativeHttp } from './transport';
import { SerialCallQueue } from './serial-call-queue';

export const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export type SessionState =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'active'; session: Session; lastRefreshAt: number }
  | { kind: 'relogin'; reason: string };

type Listener = (s: SessionState) => void;

class SessionStore {
  private state: SessionState = { kind: 'loading' };
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly api = new XpApi(nativeHttp);
  private deviceIdValue = '';
  private lastRefreshAt = 0;
  private readonly requestQueue = new SerialCallQueue();

  get deviceId(): string {
    return this.deviceIdValue;
  }

  get current(): SessionState {
    return this.state;
  }

  /** 上次成功续期的时间（毫秒时间戳）。 */
  get lastRefresh(): number {
    return this.lastRefreshAt;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(s: SessionState) {
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  /** 设备号首次启动生成一次并固定：密钥池与设备指纹都依赖它。 */
  async init(): Promise<void> {
    let di = await native.storageGet(StorageKey.deviceId);
    if (!di) {
      di = randomDeviceId();
      await native.storageSet(StorageKey.deviceId, di);
    }
    this.deviceIdValue = di;

    const raw = await native.storageGet(StorageKey.session);
    if (!raw) {
      this.set({ kind: 'anonymous' });
      return;
    }
    const saved = JSON.parse(raw) as { session: Session; lastRefreshAt: number };
    this.lastRefreshAt = saved.lastRefreshAt;
    this.set({ kind: 'active', session: saved.session, lastRefreshAt: saved.lastRefreshAt });
    this.startTimer();
  }

  async adopt(session: Session): Promise<void> {
    await this.persist(session);
    this.set({ kind: 'active', session, lastRefreshAt: Date.now() });
    this.startTimer();
  }

  async logout(): Promise<void> {
    this.stopTimer();
    await native.storageRemove(StorageKey.session);
    this.set({ kind: 'anonymous' });
  }

  /**
   * 打一个业务接口；遇到 12010101 就续期后重试一次。
   * 续期失败会把状态切到 `relogin`，调用方只需处理抛出的错误。
   *
   * 服务端密钥池按 deviceId 只认最近一次下发，并发取池会使先发出的签名失效，
   * 因此全部业务请求必须串行经过这条队列。
   */
  call<T = any>(path: string, body?: unknown): Promise<T> {
    return this.requestQueue.run(() => this.callNow<T>(path, body));
  }

  private async callNow<T = any>(path: string, body?: unknown): Promise<T> {
    const s = this.state;
    if (s.kind !== 'active') throw new Error('未登录');
    try {
      const r = await this.api.call(path, {
        deviceId: this.deviceIdValue,
        accessToken: s.session.accessToken,
        uid: s.session.uid,
        body,
      });
      return r.json.data as T;
    } catch (e) {
      if (e instanceof ApiError && e.code === CODE_TOKEN_EXPIRED) {
        const renewed = await this.refreshNowUnqueued();
        const r = await this.api.call(path, {
          deviceId: this.deviceIdValue,
          accessToken: renewed.accessToken,
          uid: renewed.uid,
          body,
        });
        return r.json.data as T;
      }
      throw e;
    }
  }

  /** 立刻续期。失败则切 `relogin` 并抛错。 */
  async refreshNow(): Promise<Session> {
    return this.requestQueue.run(() => this.refreshNowUnqueued());
  }

  private async refreshNowUnqueued(): Promise<Session> {
    const s = this.state;
    if (s.kind !== 'active') throw new Error('未登录，无法续期');
    try {
      const next = await refreshSession(this.api, this.deviceIdValue, s.session);
      await this.persist(next);
      this.lastRefreshAt = Date.now();
      this.set({ kind: 'active', session: next, lastRefreshAt: this.lastRefreshAt });
      return next;
    } catch (e) {
      this.stopTimer();
      const reason = e instanceof ApiError ? `${e.code} ${e.desc}` : String(e);
      this.set({ kind: 'relogin', reason });
      throw e;
    }
  }

  private async persist(session: Session) {
    await native.storageSet(
      StorageKey.session,
      JSON.stringify({ session, lastRefreshAt: Date.now() }),
    );
    await native.storageSet(StorageKey.lastRefresh, String(Date.now()));
  }

  private startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => {
      this.refreshNow().catch(() => {
        // 失败已切到 relogin，UI 会提示重新登录
      });
    }, REFRESH_INTERVAL_MS);
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function randomDeviceId(): string {
  let out = '';
  for (let i = 0; i < 32; i++) out += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return out;
}

export const sessionStore = new SessionStore();

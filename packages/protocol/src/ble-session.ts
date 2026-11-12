import { buildTbox, deriveAuth1Payload } from './ble.ts';
import { concat } from './bytes.ts';
import { createV2AuthCipher, verifyV2AuthReply } from './ble-v2-verify.ts';
import { V2VerifyReplyReceiver } from './ble-v2-reply.ts';

export interface BleTransport {
  /** Resolves only after CCCD subscription succeeds. */
  connect(mac: string): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  disconnect(): Promise<void>;
  onData(callback: (data: Uint8Array) => void): () => void;
  onDisconnect(callback: (reason: string) => void): () => void;
}

/** 一次三段握手所需的材料，命令与常驻重鉴权共用。 */
type BleHandshakeOptions = {
  mac: string;
  /** Explicit createAuthKey keyString for the target module; transport/bridge addresses may differ. */
  keyMac: string;
  appN: Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
} & ({
  createAuthCipher(appN: Uint8Array, carN: Uint8Array): Promise<Uint8Array>;
  verifyKey?: never;
  verifyRandom?: never;
} | {
  /** Explicit V2 path: authenticate the vehicle's encrypted rand+1 reply before commands. */
  verifyKey: string;
  /** Independent uint32 challenge; not appN or carN. */
  verifyRandom: number;
  createAuthCipher?: never;
});

export type BleCommandOptions = BleHandshakeOptions & {
  frame: Uint8Array;
  commandCode: number;
  /**
   * Wait for the car's `0x0070` control ACK. Defaults to true.
   *
   * RPA activation (commandCode 0x03) has no 0x0070 reply in a full captured
   * session — the car only answers with 0318/0225 status frames — so that path
   * passes false. Everything else keeps the ACK contract.
   */
  expectCommandAck?: boolean;
};

export interface BleCommandAck { code: number; commandCode: number }

export type BleStage = 'connecting' | 'authenticating' | 'authenticated' | 'command' | 'disconnected';

type Waiter = { accept(data: Uint8Array): boolean; resolve(data: Uint8Array): void;
  reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** One connection per operation; no replay of third-handshake material. */
export class BleSession {
  private transport: BleTransport;
  private active = false;
  private waiter?: Waiter;
  private disconnected?: Error;
  private readonly onStage?: (stage: BleStage) => void;

  constructor(transport: BleTransport, onStage?: (stage: BleStage) => void) {
    this.transport = transport;
    this.onStage = onStage;
  }

  private receive(data: Uint8Array) {
    const pending = this.waiter;
    if (!pending) return;
    try {
      if (!pending.accept(data)) return;
      clearTimeout(pending.timer);
      this.waiter = undefined;
      pending.resolve(data);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error) {
    const pending = this.waiter;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.waiter = undefined;
    pending.reject(error);
  }

  private async exchange(frame: Uint8Array, accept: (data: Uint8Array) => boolean,
    timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    if (this.disconnected) throw this.disconnected;
    const response = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('BLE response timeout')), timeoutMs);
      this.waiter = { accept, resolve, reject, timer };
    });
    // Install the waiter first: a notification may precede onCharacteristicWrite.
    const sent = this.transport.write(frame).catch((error: Error) => { this.fail(error); throw error; });
    const [, data] = await Promise.all([sent, response]);
    return data;
  }

  private findRecord(data: Uint8Array, first: number, second: number): Uint8Array | undefined {
    for (let i = 0; i + 10 <= data.length; i += 10) {
      if (data[i] === first && data[i + 1] === second) return data.subarray(i, i + 10);
    }
    return undefined;
  }

  async execute(options: BleCommandOptions): Promise<BleCommandAck> {
    if (this.active) throw new Error('BLE operation already running');
    options.signal?.throwIfAborted();
    if (options.appN.length !== 4) throw new Error('BLE app nonce must be four bytes');
    // 非法 V2 材料必须在建连前就失败：不要让一次注定失败的握手去动蓝牙。
    this.createAuthCipher(options);
    this.active = true;
    this.disconnected = undefined;
    const offData = this.transport.onData((data) => this.receive(data));
    const offDisconnect = this.transport.onDisconnect((reason) => {
      if (!options.signal?.aborted) this.disconnected = new Error(`BLE disconnected: ${reason}`);
      this.fail(this.disconnected!);
    });
    let disconnecting: Promise<void> | undefined;
    const disconnect = () => disconnecting ??= this.transport.disconnect();
    const abort = () => {
      const reason = options.signal!.reason;
      this.disconnected = reason instanceof Error ? reason : new Error(String(reason));
      this.fail(this.disconnected);
      // Start closing immediately; finally awaits the same promise and reports close failures.
      void disconnect().catch(() => {});
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = options.timeoutMs ?? 5000;
    try {
      this.onStage?.('connecting');
      await this.transport.connect(options.mac);
      this.onStage?.('authenticating');
      await this.handshake(options, timeout);
      this.onStage?.('authenticated');
      let ack: BleCommandAck | undefined;
      this.onStage?.('command');
      if (options.expectCommandAck === false) {
        // Fire-and-forget: write the frame and return once the write is acknowledged.
        // No server ACK is waited for — RPA activation has none.
        await this.transport.write(options.frame);
        return { commandCode: options.commandCode, code: 200 };
      }
      await this.exchange(options.frame, (data) => {
        for (let i = 0; i + 10 <= data.length; i += 10) {
          if (data[i] === 0 && data[i + 1] === 0x70) {
            ack = { commandCode: options.commandCode, code: data[i + 6] | (data[i + 7] << 8) };
            return true;
          }
        }
        return false;
      }, timeout, options.signal);
      return ack!;
    } finally {
      this.fail(new Error('BLE operation finished'));
      options.signal?.removeEventListener('abort', abort);
      offData(); offDisconnect();
      try { await disconnect(); } finally {
        this.active = false;
        this.onStage?.('disconnected');
      }
    }
  }

  /**
   * 常驻连接的「连上即认证」：握手成功即返回，**不断开**连接。
   *
   * 车端要求连上后立刻开始认证，不发就约 5 秒断开，所以常驻持有必须靠周期重鉴权
   * 维持；一次握手消耗一条一次性材料，调用方负责每条重鉴权重新取材料。
   */
  async authenticate(options: BleHandshakeOptions): Promise<void> {
    if (this.active) throw new Error('BLE operation already running');
    options.signal?.throwIfAborted();
    if (options.appN.length !== 4) throw new Error('BLE app nonce must be four bytes');
    // 常驻模式握手不建连（连接已由 BleLink 持有），但仍先校验材料。
    this.createAuthCipher(options);
    this.active = true;
    this.disconnected = undefined;
    const offData = this.transport.onData((data) => this.receive(data));
    const offDisconnect = this.transport.onDisconnect((reason) => {
      if (!options.signal?.aborted) this.disconnected = new Error(`BLE disconnected: ${reason}`);
      this.fail(this.disconnected!);
    });
    const abort = () => {
      const reason = options.signal!.reason;
      this.disconnected = reason instanceof Error ? reason : new Error(String(reason));
      this.fail(this.disconnected);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = options.timeoutMs ?? 5000;
    try {
      this.onStage?.('authenticating');
      await this.handshake(options, timeout);
      this.onStage?.('authenticated');
    } finally {
      this.fail(new Error('BLE authenticate finished'));
      options.signal?.removeEventListener('abort', abort);
      offData(); offDisconnect();
      this.active = false;
    }
  }

  private createAuthCipher(options: BleHandshakeOptions): {
    createAuthCipher(appN: Uint8Array, carN: Uint8Array): Promise<Uint8Array>;
    v2Cipher?: Uint8Array;
  } {
    const v2Cipher = options.verifyKey !== undefined
      ? createV2AuthCipher(options.verifyKey, options.verifyRandom!) : undefined;
    const createAuthCipher = v2Cipher ? async () => v2Cipher : options.createAuthCipher!;
    return { createAuthCipher, v2Cipher };
  }

  private async handshake(options: BleHandshakeOptions, timeout: number): Promise<void> {
    const { createAuthCipher, v2Cipher } = this.createAuthCipher(options);
    const carN = await this.exchange(concat([0xef, 1, 4], options.appN), (data) => data.length === 4, timeout, options.signal);
    const auth = await this.exchange(concat([0xef, 1, 16],
      deriveAuth1Payload(options.appN, carN, options.keyMac)),
      (data) => this.findRecord(data, 8, 0) !== undefined, timeout, options.signal);
    const authRecord = this.findRecord(auth, 8, 0)!;
    if (authRecord[2] !== 1) throw new Error(`BLE authentication rejected: ${authRecord[2].toString(16).padStart(2, '0')}`);
    const cipher = await createAuthCipher(options.appN, carN);
    if (cipher.length !== 16) throw new Error('BLE auth cipher must be sixteen bytes');
    const replyReceiver = v2Cipher ? new V2VerifyReplyReceiver() : undefined;
    await this.exchange(buildTbox(0xed, 0x11, 0, concat(cipher, [0xe0])), (data) => {
      if (!replyReceiver) return this.findRecord(data, 2, 0x81) !== undefined;
      // 0x0281 is only status; fragments may arrive with, before, or without it.
      const replyCipher = replyReceiver.accept(data);
      if (!replyCipher) return false;
      verifyV2AuthReply(options.verifyKey!, options.verifyRandom!, replyCipher);
      return true;
    }, timeout, options.signal);
  }
}

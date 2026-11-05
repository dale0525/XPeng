export type BleV2MaterialCall = (path: string, body: unknown) => Promise<unknown>;

export interface BleV2VerifyCode {
  code: string;
  index?: number | null;
}

export interface BleV2Material {
  cardNo: string;
  message: string;
  verifyCode: BleV2VerifyCode;
}

interface MaterialQueue {
  cardNo: string;
  messages: string[];
  verifyCode: BleV2VerifyCode;
}

const authPath = '/digital-key/v1/key/ble/getXpKeyAuthData';
const verifyPath = '/digital-key/v1/key/common/getVerifyCode';

/** Supply HTTP material independently of BLE transport. The injected call returns response data. */
export class BleV2MaterialService {
  private readonly call: BleV2MaterialCall;
  private readonly queues = new Map<string, MaterialQueue>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly consumed = new Map<string, Set<string>>();
  private generation = 0;

  constructor(call: BleV2MaterialCall) {
    this.call = call;
  }

  async prepare(accountId: string | number, vin: string): Promise<void> {
    const key = JSON.stringify([String(accountId), vin]);
    if (this.queues.get(key)?.messages.length) return;
    const current = this.pending.get(key);
    if (current) return current;
    const generation = this.generation;
    const request = this.refill(key, vin, generation);
    this.pending.set(key, request);
    try {
      await request;
    } finally {
      // A reset can already have installed a different request for this account and VIN.
      if (this.pending.get(key) === request) this.pending.delete(key);
    }
  }

  async take(accountId: string | number, vin: string): Promise<BleV2Material> {
    const key = JSON.stringify([String(accountId), vin]);
    const generation = this.generation;
    for (;;) {
      await this.prepare(accountId, vin);
      if (generation !== this.generation) throw new Error('BLE V2 material reset during request');
      const queue = this.queues.get(key)!;
      // Remove before returning: failed writes and missing ACKs must never restore this message.
      const message = queue.messages.shift();
      if (message !== undefined) {
        let consumed = this.consumed.get(key);
        if (!consumed) {
          consumed = new Set();
          this.consumed.set(key, consumed);
        }
        consumed.add(message);
        return { cardNo: queue.cardNo, message, verifyCode: { ...queue.verifyCode } };
      }
    }
  }

  reset(): void {
    this.generation++;
    this.queues.clear();
    this.pending.clear();
    this.consumed.clear();
  }

  private async refill(key: string, vin: string, generation: number): Promise<void> {
    const auth = parseAuth(await this.call(authPath, { vin, count: 300, autoCreateKey: false }));
    if (generation !== this.generation) throw new Error('BLE V2 material reset during request');
    const consumed = this.consumed.get(key);
    const messages = [...new Set(auth.messages)].filter(message => !consumed?.has(message));
    if (!messages.length) throw new Error(`${authPath}: no unused material in response`);
    const verifyCode = parseVerify(await this.call(verifyPath, { vin, typeList: [1, 2] }));
    if (generation !== this.generation) throw new Error('BLE V2 material reset during request');
    this.queues.set(key, { cardNo: auth.cardNo, messages, verifyCode });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function parseAuth(value: unknown): { cardNo: string; messages: string[] } {
  if (!record(value) || typeof value.cardNo !== 'string' || !value.cardNo ||
    !Array.isArray(value.authDataList) || value.authDataList.length === 0 ||
    value.authDataList.some(message => typeof message !== 'string' || !message ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message))) {
    throw new Error(`${authPath}: unsupported material response`);
  }
  return { cardNo: value.cardNo, messages: [...value.authDataList] };
}

const knownVerifyKeys = new Set(['verifyCodes', '1', '2', 'code', 'index']);

/**
 * Describes an external response without copying any value or raw key name.
 *
 * The live getVerifyCode shape is now confirmed as verifyCodes["1"/"2"].
 * This bounded tree records only types, counts, known protocol key names and
 * coarse string classes, so a failure can be classified without leaking values.
 */
export function describeVerifyResponseShape(value: unknown): unknown {
  let budget = 80;
  const visit = (v: unknown, depth: number): unknown => {
    if (budget-- <= 0) return 'budget-exhausted';
    if (v === null) return { type: 'null' };
    if (Array.isArray(v)) {
      const shape: Record<string, unknown> = {
        type: 'array',
        length: v.length,
        itemTypes: [...new Set(v.slice(0, 8).map(primitiveType))],
      };
      if (depth < 3) shape.items = v.slice(0, 4).map((item, itemIndex) => ({ itemIndex, shape: visit(item, depth + 1) }));
      return shape;
    }
    if (typeof v === 'string') {
      const shape: Record<string, unknown> = { type: 'string', length: v.length, charset: charsetOf(v) };
      if (v.length <= 4096) {
        try {
          const parsed = JSON.parse(v);
          shape.jsonParse = true;
          shape.jsonRootType = primitiveType(parsed);
          shape.jsonKnownKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? Object.keys(parsed).filter(key => knownVerifyKeys.has(key)).slice(0, 20) : [];
        } catch {
          shape.jsonParse = false;
        }
      } else {
        shape.jsonParse = 'skipped';
      }
      return shape;
    }
    if (typeof v === 'number') return { type: 'number', numeric: Number.isInteger(v) ? 'integer' : 'float' };
    if (typeof v === 'boolean') return { type: 'boolean' };
    if (typeof v === 'object') {
      const source = v as Record<string, unknown>;
      const keys = Object.keys(source);
      const knownKeys = keys.filter(key => knownVerifyKeys.has(key)).slice(0, 20);
      const shape: Record<string, unknown> = {
        type: 'object',
        fieldCount: keys.length,
        knownKeys,
        otherKeyCount: keys.length - knownKeys.length,
      };
      if (depth < 3) shape.children = keys.slice(0, 12).map((key, fieldIndex) => ({
        fieldIndex, shape: visit(source[key], depth + 1),
      }));
      else shape.truncated = true;
      return shape;
    }
    return { type: typeof v };
  };
  return visit(value, 0);
}

function primitiveType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function charsetOf(value: string): 'hex-prefix' | 'hex' | 'decimal' | 'base64' | 'other' {
  const sample = value.slice(0, 256);
  if (/^0[xX][0-9a-fA-F]+$/.test(sample)) return 'hex-prefix';
  if (/^[0-9a-fA-F]+$/.test(sample)) return 'hex';
  if (/^\d+$/.test(sample)) return 'decimal';
  if (/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(sample)) return 'base64';
  return 'other';
}

function parseVerify(value: unknown): BleV2VerifyCode {
  const code = record(value) && record(value.verifyCodes) ? value.verifyCodes['1'] : undefined;
  if (!record(code) || typeof code.code !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(code.code) ||
    (code.index !== undefined && code.index !== null && !Number.isInteger(code.index))) {
    let shape = 'diagnostic-unavailable';
    try {
      shape = JSON.stringify(describeVerifyResponseShape(value));
    } catch {
      // Keep the original parse failure visible even if diagnostic traversal fails.
    }
    throw new Error(`${verifyPath}: unsupported phoneBle response shape=${shape}`);
  }
  return code.index === undefined ? { code: code.code } : { code: code.code, index: code.index as number | null };
}

/**
 * MQTT 3.1.1 报文编解码。
 *
 * broker 是标准 MQTT over TLS（`iot-app.xiaopeng.com:8883`），只需用户名密码，
 * 不认 mTLS。报文全部用 JSON 字段，不能字符串拼接——拼接格式 broker 会接受
 * publish，但车辆端解析失败、不回任何回执。
 */
import { concat, utf8, utf8Decode } from './bytes.ts';
import { randomBytes } from './bytes.ts';

// 用普通常量对象而非 const enum：Metro 与 node 的 TS 剥离都不支持 const enum。
export const PacketType = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
} as const;
export type PacketType = (typeof PacketType)[keyof typeof PacketType];

export interface DecodedPacket {
  type: PacketType;
  flags: number;
  payload: Uint8Array;
}

function varint(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  do {
    let d = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) d |= 0x80;
    out.push(d);
  } while (v > 0);
  return new Uint8Array(out);
}

function utf8Field(s: string): Uint8Array<ArrayBuffer> {
  const b = utf8(s);
  return concat([b.length >> 8, b.length & 0xff], b);
}

function packet(type: number, flags: number, body: Uint8Array): Uint8Array {
  return concat([(type << 4) | flags], varint(body.length), body);
}

export interface ConnectOptions {
  clientId: string;
  username: string;
  password: string;
  keepAliveSeconds?: number;
}

/**
 * CONNECT。cleanSession=true + 遗嘱关闭：客户端每次连上都重新订阅，不依赖
 * broker 保存的会话（车控是即时指令，丢一条历史消息没有影响）。
 */
export function encodeConnect(o: ConnectOptions): Uint8Array {
  const vh = concat(
    utf8Field('MQTT'),
    new Uint8Array([4, 0x02]),
    new Uint8Array([
      ((o.keepAliveSeconds ?? 60) >> 8) & 0xff,
      (o.keepAliveSeconds ?? 60) & 0xff,
    ]),
  );
  const payload = concat(
    utf8Field(o.clientId),
    utf8Field(o.username),
    utf8Field(o.password),
  );
  return packet(PacketType.CONNECT, 0, concat(vh, payload));
}

export function encodeSubscribe(messageId: number, topics: Array<[string, number]>): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([messageId >> 8, messageId & 0xff])];
  for (const [topic, qos] of topics) {
    parts.push(utf8Field(topic), new Uint8Array([qos]));
  }
  return packet(PacketType.SUBSCRIBE, 0x02, concat(...parts));
}

export function encodePublish(topic: string, payload: Uint8Array): Uint8Array {
  return packet(PacketType.PUBLISH, 0, concat(utf8Field(topic), payload));
}

export function encodePingReq(): Uint8Array {
  return packet(PacketType.PINGREQ, 0, new Uint8Array(0));
}

export function encodeDisconnect(): Uint8Array {
  return packet(PacketType.DISCONNECT, 0, new Uint8Array(0));
}

/** 从字节流里切出完整报文；数据不完整时返回 null 并把剩余留在 buffer 里。 */
export class PacketReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): void {
    this.buf = concat(this.buf, chunk);
  }

  next(): DecodedPacket | null {
    if (this.buf.length < 2) return null;
    let mult = 1;
    let len = 0;
    let i = 1;
    for (;;) {
      if (i >= this.buf.length) return null;
      const b = this.buf[i];
      len += (b & 0x7f) * mult;
      mult *= 128;
      i++;
      if ((b & 0x80) === 0) break;
    }
    const total = i + len;
    if (this.buf.length < total) return null;
    const head = this.buf[0];
    const body = this.buf.slice(i, total);
    this.buf = this.buf.slice(total);
    return { type: (head >> 4) as PacketType, flags: head & 0x0f, payload: body };
  }
}

export interface PublishMessage {
  topic: string;
  payload: string;
}

/** 解析 PUBLISH 报文；QoS>0 时跳过 packet id。 */
export function decodePublish(p: DecodedPacket): PublishMessage {
  const qos = (p.flags >> 1) & 0x03;
  const topicLen = (p.payload[0] << 8) | p.payload[1];
  const topic = utf8Decode(p.payload.slice(2, 2 + topicLen));
  let off = 2 + topicLen;
  if (qos > 0) off += 2;
  return { topic, payload: utf8Decode(p.payload.slice(off)) };
}

/** CONNACK 的返回码；0 是接受。 */
export function connackCode(p: DecodedPacket): number {
  return p.payload.length >= 2 ? p.payload[1] : -1;
}

export interface CarMessage {
  protocol_ver: string;
  msg_id: string;
  target_id: string;
  service_type: number;
  msg_type: number;
  msg_content: Record<string, unknown>;
}

export interface DownlinkMessage {
  msg_id: string;
  msg_ref: string;
  msg_type: number;
  service_type: number;
  vin: string;
  msg_content: any;
}

/** 构造车控请求报文。`msg_id` = "10" + uid(8) + 毫秒时间戳(13) + 2 位随机数。 */
export function buildCarMessage(
  uid: string,
  vin: string,
  serviceType: number,
  msgContent: Record<string, unknown>,
  msgType = 2,
): { payload: string; msgId: string } {
  const rnd = 10 + Math.floor(Math.random() * 90);
  const msgId = '10' + uid + String(Date.now()) + String(rnd);
  const payload = JSON.stringify({
    protocol_ver: '2.0',
    msg_id: msgId,
    target_id: vin,
    service_type: serviceType,
    msg_type: msgType,
    msg_content: msgContent,
  });
  return { payload, msgId };
}

export function uplinkTopic(uid: string): string {
  return `Xmart/Send/User/${uid}`;
}

export function downlinkTopics(uid: string, deviceId: string): string[] {
  return [
    `Xmart/Msg/User/${uid}`,
    `Xmart/Msg/User/${uid}/#`,
    `Xp/Msg/Push/${deviceId}`,
  ];
}

export { randomBytes };

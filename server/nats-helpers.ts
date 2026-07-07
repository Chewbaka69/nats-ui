import { headers as createHeaders, type Msg, type MsgHdrs } from '@nats-io/transport-node';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Build NATS message headers from a plain record. */
export function buildHeaders(input?: Record<string, string>): MsgHdrs | undefined {
  if (!input || Object.keys(input).length === 0) return undefined;
  const h = createHeaders();
  for (const [key, value] of Object.entries(input)) {
    h.append(key, value);
  }
  return h;
}

/** Encode a payload (string or JSON-serializable value) into bytes. */
export function encodePayload(data: unknown): { bytes: Uint8Array; text: string } {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { bytes: encoder.encode(text), text };
}

export interface WireMessage {
  subject: string;
  data: unknown;
  headers?: Record<string, string>;
  reply?: string;
  timestamp: number;
}

/** Convert a received NATS message to the JSON shape the frontend expects. */
export function toWireMessage(msg: Msg): WireMessage {
  const text = decoder.decode(msg.data);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  let headers: Record<string, string> | undefined;
  if (msg.headers) {
    headers = {};
    for (const [key, values] of msg.headers) {
      headers[key] = Array.isArray(values) ? values[0] : (values as string);
    }
  }

  return {
    subject: msg.subject,
    data,
    headers,
    reply: msg.reply,
    timestamp: Date.now(),
  };
}

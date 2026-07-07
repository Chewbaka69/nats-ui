import { toast } from 'sonner';
import { subjectTracker } from './subject-tracker';
import { config } from '../config';

/**
 * Frontend NATS service.
 *
 * The browser no longer connects to NATS directly. Every call goes through the
 * backend API (`config.api.baseUrl`, default `/api`); the backend owns the NATS
 * connection and can therefore reach a NATS server that is only accessible from
 * the server host. Real-time subscriptions are multiplexed over a single
 * WebSocket to the backend.
 *
 * The public shape (NatsService, JetStreamManager, createNatsService, and the
 * fetch* helpers) is preserved so pages/components require no changes.
 */

export interface SubscribeMessage {
  subject: string;
  data: unknown;
  headers?: Record<string, string>;
  timestamp: number;
  reply?: string;
}

export interface NatsService {
  publish: (subject: string, data: unknown, headers?: Record<string, string>) => Promise<void>;
  subscribe: (subject: string, callback: (msg: SubscribeMessage) => void) => Promise<() => void>;
  close: () => Promise<void>;
  isClosed: () => boolean;
  jetstream: JetStreamManager;
}

export interface NatsConnectConfig {
  server: string;
  httpUrl?: string;
  name?: string;
  user?: string;
  pass?: string;
  token?: string;
  timeout?: number;
}

// The single active connection id, shared with the module-level fetch* helpers
// (which are called from pages that don't hold a service instance).
let activeConnectionId: string | null = null;

function apiUrl(path: string): string {
  return `${config.api.baseUrl}${path}`;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      // ignore body parse errors
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

class RealNatsService implements NatsService {
  public readonly jetstream: JetStreamManager;
  private readonly connectionId: string;
  private closed = false;

  // Real-time WebSocket state.
  private ws: WebSocket | null = null;
  private readonly callbacks = new Map<string, Set<(msg: SubscribeMessage) => void>>();
  private readonly pending: string[] = [];

  constructor(connectionId: string) {
    this.connectionId = connectionId;
    this.jetstream = new JetStreamManager(connectionId);
  }

  async publish(subject: string, data: unknown, msgHeaders?: Record<string, string>): Promise<void> {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    try {
      await apiFetch(`/connections/${this.connectionId}/publish`, {
        method: 'POST',
        body: JSON.stringify({ subject, data, headers: msgHeaders }),
      });
      subjectTracker.track(subject, payload);
    } catch (error) {
      console.error(`Failed to publish to subject ${subject}:`, error);
      throw error;
    }
  }

  async subscribe(subject: string, callback: (msg: SubscribeMessage) => void): Promise<() => void> {
    this.ensureSocket();

    let set = this.callbacks.get(subject);
    const isNewSubject = !set;
    if (!set) {
      set = new Set();
      this.callbacks.set(subject, set);
    }
    set.add(callback);

    if (isNewSubject) {
      this.sendFrame({ action: 'subscribe', subject });
    }

    const unsubscribe = () => {
      const callbacks = this.callbacks.get(subject);
      if (!callbacks) return;
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.callbacks.delete(subject);
        this.sendFrame({ action: 'unsubscribe', subject });
      }
    };

    return unsubscribe;
  }

  private ensureSocket(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = config.api.baseUrl.startsWith('http')
      ? config.api.baseUrl.replace(/^http/, 'ws')
      : `${proto}//${window.location.host}${config.api.baseUrl}`;
    const ws = new WebSocket(`${base}/connections/${this.connectionId}/subscribe`);
    this.ws = ws;

    ws.onopen = () => {
      // Flush queued frames.
      while (this.pending.length > 0) {
        ws.send(this.pending.shift()!);
      }
    };

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.type !== 'message' || !frame.message) return;
        const message = frame.message as SubscribeMessage;
        subjectTracker.track(
          message.subject,
          typeof message.data === 'string' ? message.data : JSON.stringify(message.data),
        );
        const set = this.callbacks.get(frame.subject);
        if (set) {
          for (const cb of set) cb(message);
        }
      } catch (error) {
        console.error('Error processing message:', error);
      }
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
    };
  }

  private sendFrame(frame: Record<string, unknown>): void {
    const data = JSON.stringify(frame);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.pending.push(data);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.callbacks.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    if (activeConnectionId === this.connectionId) {
      activeConnectionId = null;
    }
    try {
      await apiFetch(`/connections/${this.connectionId}`, { method: 'DELETE' });
    } catch (error) {
      console.error('Failed to close connection:', error);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }
}

export async function createNatsService(connectConfig: NatsConnectConfig): Promise<NatsService> {
  try {
    const { connectionId } = await apiFetch<{ connectionId: string }>(`/connections`, {
      method: 'POST',
      body: JSON.stringify({
        servers: [connectConfig.server],
        name: connectConfig.name,
        user: connectConfig.user,
        pass: connectConfig.pass,
        token: connectConfig.token,
        timeout: connectConfig.timeout,
        httpUrl: connectConfig.httpUrl,
      }),
    });
    activeConnectionId = connectionId;
    return new RealNatsService(connectionId);
  } catch (error) {
    console.error('Failed to connect to NATS server:', error);
    toast.error(`Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

// ---- Monitoring helpers (proxied through the backend) --------------------

async function fetchMonitoring<T>(what: string, query = ''): Promise<T | null> {
  if (!activeConnectionId) return null;
  try {
    const response = await fetch(
      apiUrl(`/connections/${activeConnectionId}/monitoring/${what}${query}`),
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    console.warn(`Could not fetch NATS ${what}:`, error);
    return null;
  }
}

export async function fetchNatsInfo(): Promise<Record<string, unknown> | null> {
  return fetchMonitoring<Record<string, unknown>>('varz');
}

export async function fetchNatsConnections(): Promise<Record<string, unknown> | null> {
  return fetchMonitoring<Record<string, unknown>>('connz');
}

export async function fetchJetStreamInfo(): Promise<Record<string, unknown> | null> {
  return fetchMonitoring<Record<string, unknown>>('jsz');
}

export async function fetchActiveSubjects(): Promise<string[]> {
  const data = await fetchMonitoring<Record<string, unknown>>('connz', '?subs=1');
  if (!data) return [];

  const subjects = new Set<string>();
  if (Array.isArray(data.connections)) {
    (data.connections as Record<string, unknown>[]).forEach((conn) => {
      if (Array.isArray(conn.subscriptions_list)) {
        (conn.subscriptions_list as string[]).forEach((sub) => subjects.add(sub));
      }
    });
  }
  return Array.from(subjects).sort((a, b) => a.localeCompare(b));
}

export async function fetchJetStreamStreams(): Promise<Record<string, unknown>[]> {
  const data = await fetchMonitoring<{ streams?: Record<string, unknown>[] }>('jsz', '?streams=1');
  return data?.streams || [];
}

export async function fetchJetStreamStreamInfo(streamName: string): Promise<Record<string, unknown> | null> {
  const data = await fetchMonitoring<{ stream_detail?: Record<string, unknown> }>(
    'jsz',
    `?stream=${encodeURIComponent(streamName)}`,
  );
  return data?.stream_detail || null;
}

export async function fetchAllConsumers(): Promise<Record<string, unknown>[]> {
  const data = await fetchMonitoring<{ streams?: Record<string, unknown>[] }>('jsz', '?consumers=1');
  if (!data) return [];

  const consumers: Record<string, unknown>[] = [];
  if (Array.isArray(data.streams)) {
    data.streams.forEach((stream) => {
      if (Array.isArray(stream.consumer_detail)) {
        (stream.consumer_detail as Record<string, unknown>[]).forEach((consumer) => {
          consumers.push({ ...consumer, stream_name: stream.name });
        });
      }
    });
  }
  return consumers;
}

// ---- JetStream / KV management (proxied through the backend) -------------

export class JetStreamManager {
  private readonly connectionId: string;

  constructor(connectionId: string) {
    this.connectionId = connectionId;
  }

  private base(): string {
    return `/connections/${this.connectionId}`;
  }

  async createStream(streamConfig: {
    name: string;
    subjects: string[];
    description?: string;
    retention: 'limits' | 'interest' | 'workqueue';
    storage: 'file' | 'memory';
    maxMsgs: number;
    maxBytes: number;
    maxAge: number;
    replicas: number;
  }): Promise<Record<string, unknown>> {
    return apiFetch<Record<string, unknown>>(`${this.base()}/streams`, {
      method: 'POST',
      body: JSON.stringify(streamConfig),
    });
  }

  async deleteStream(streamName: string): Promise<void> {
    await apiFetch(`${this.base()}/streams/${encodeURIComponent(streamName)}`, { method: 'DELETE' });
  }

  async listStreams(): Promise<Record<string, unknown>[]> {
    const data = await apiFetch<{ streams: Record<string, unknown>[] }>(`${this.base()}/streams`);
    return data.streams || [];
  }

  async getStreamInfo(streamName: string): Promise<Record<string, unknown> | null> {
    try {
      return await apiFetch<Record<string, unknown>>(
        `${this.base()}/streams/${encodeURIComponent(streamName)}`,
      );
    } catch {
      return null;
    }
  }

  async listConsumers(streamName: string): Promise<Record<string, unknown>[]> {
    try {
      const data = await apiFetch<{ consumers: Record<string, unknown>[] }>(
        `${this.base()}/streams/${encodeURIComponent(streamName)}/consumers`,
      );
      return data.consumers || [];
    } catch {
      return [];
    }
  }

  async getConsumerInfo(streamName: string, consumerName: string): Promise<Record<string, unknown> | null> {
    try {
      return await apiFetch<Record<string, unknown>>(
        `${this.base()}/streams/${encodeURIComponent(streamName)}/consumers/${encodeURIComponent(consumerName)}`,
      );
    } catch {
      return null;
    }
  }

  async deleteConsumer(streamName: string, consumerName: string): Promise<void> {
    await apiFetch(
      `${this.base()}/streams/${encodeURIComponent(streamName)}/consumers/${encodeURIComponent(consumerName)}`,
      { method: 'DELETE' },
    );
  }

  async listKVBuckets(): Promise<string[]> {
    try {
      const data = await apiFetch<{ buckets: string[] }>(`${this.base()}/kv`);
      return data.buckets || [];
    } catch (error) {
      console.error('Failed to list KV buckets:', error);
      return [];
    }
  }

  async createKVBucket(name: string, ttl?: number): Promise<void> {
    await apiFetch(`${this.base()}/kv`, {
      method: 'POST',
      body: JSON.stringify({ name, ttl }),
    });
  }

  async deleteKVBucket(name: string): Promise<void> {
    await apiFetch(`${this.base()}/kv/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  async getKVKeys(bucket: string): Promise<string[]> {
    try {
      const data = await apiFetch<{ keys: string[] }>(
        `${this.base()}/kv/${encodeURIComponent(bucket)}/keys`,
      );
      return data.keys || [];
    } catch (error) {
      console.error('Failed to get KV keys:', error);
      return [];
    }
  }

  async getKVValue(bucket: string, key: string): Promise<string | null> {
    try {
      const data = await apiFetch<{ value: string | null }>(
        `${this.base()}/kv/${encodeURIComponent(bucket)}/value?key=${encodeURIComponent(key)}`,
      );
      return data.value;
    } catch (error) {
      console.error('Failed to get KV value:', error);
      return null;
    }
  }

  async putKVValue(bucket: string, key: string, value: string): Promise<void> {
    await apiFetch(`${this.base()}/kv/${encodeURIComponent(bucket)}/value`, {
      method: 'PUT',
      body: JSON.stringify({ key, value }),
    });
  }

  async deleteKVKey(bucket: string, key: string): Promise<void> {
    await apiFetch(
      `${this.base()}/kv/${encodeURIComponent(bucket)}/value?key=${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    );
  }
}

import { connect, type NatsConnection } from '@nats-io/transport-node';

/**
 * Input sent by the browser to open a NATS connection. The browser chooses the
 * target; the backend performs the actual (TCP) connection to NATS. This lets
 * the UI talk to a NATS server that is only reachable from the backend host.
 */
export interface CreateConnectionInput {
  servers: string | string[];
  name?: string;
  user?: string;
  pass?: string;
  token?: string;
  timeout?: number;
  /** NATS monitoring HTTP endpoint (e.g. http://localhost:8222), proxied by the backend. */
  httpUrl?: string;
}

export interface ConnectionEntry {
  nc: NatsConnection;
  httpUrl?: string;
  /** Target key used for deduplication (see targetKey). */
  key: string;
}

const connections = new Map<string, ConnectionEntry>();
// Maps a target (servers + credentials) to its live connection id, so repeated
// connects to the same NATS server reuse one connection instead of piling up
// (e.g. on every browser reload).
const byTarget = new Map<string, string>();
let counter = 0;

function generateId(): string {
  counter += 1;
  return `conn_${Date.now().toString(36)}_${counter}`;
}

function targetKey(input: CreateConnectionInput): string {
  const servers = Array.isArray(input.servers) ? [...input.servers].sort() : input.servers;
  return JSON.stringify({
    servers,
    user: input.user ?? null,
    pass: input.pass ?? null,
    token: input.token ?? null,
  });
}

export async function createConnection(input: CreateConnectionInput): Promise<string> {
  const key = targetKey(input);

  // Reuse an existing live connection to the same target.
  const existingId = byTarget.get(key);
  if (existingId) {
    const existing = connections.get(existingId);
    if (existing && !existing.nc.isClosed()) {
      existing.httpUrl = input.httpUrl; // keep the latest monitoring URL
      return existingId;
    }
    byTarget.delete(key);
  }

  const nc = await connect({
    servers: input.servers,
    name: input.name || 'NATS UI Client',
    user: input.user,
    pass: input.pass,
    token: input.token,
    timeout: input.timeout ?? 10000,
    // Keep the connection durable: reconnect indefinitely so the UI stays live
    // across NATS restarts or transient network drops.
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
  });

  const id = generateId();
  connections.set(id, { nc, httpUrl: input.httpUrl, key });
  byTarget.set(key, id);

  // Drop the entry from both registries once the underlying connection closes.
  const cleanup = () => {
    connections.delete(id);
    if (byTarget.get(key) === id) byTarget.delete(key);
  };
  nc.closed().then(cleanup).catch(cleanup);

  return id;
}

export function getConnection(id: string): ConnectionEntry | undefined {
  return connections.get(id);
}

export async function closeConnection(id: string): Promise<boolean> {
  const entry = connections.get(id);
  if (!entry) return false;
  connections.delete(id);
  if (byTarget.get(entry.key) === id) byTarget.delete(entry.key);
  try {
    await entry.nc.close();
  } catch {
    // ignore errors while closing
  }
  return true;
}

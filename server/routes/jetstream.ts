import { Hono } from 'hono';
import { jetstreamManager, type StreamConfig } from '@nats-io/jetstream';
import { Kvm } from '@nats-io/kv';
import { getConnection } from '../connections.ts';

export const jetstreamRoutes = new Hono();

const encoder = new TextEncoder();

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

// ---- Streams -------------------------------------------------------------

jetstreamRoutes.get('/:id/streams', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  const jsm = await jetstreamManager(entry.nc);
  const streams = await collect(jsm.streams.list());
  return c.json({ streams });
});

jetstreamRoutes.post('/:id/streams', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);

  const body = await c.req.json<{
    name: string;
    subjects: string[];
    description?: string;
    retention: string;
    storage: string;
    maxMsgs: number;
    maxBytes: number;
    maxAge: number; // seconds
    replicas: number;
  }>();

  const config = {
    name: body.name,
    subjects: body.subjects,
    description: body.description,
    retention: body.retention,
    storage: body.storage,
    max_msgs: body.maxMsgs,
    max_bytes: body.maxBytes,
    max_age: body.maxAge * 1_000_000_000, // seconds -> nanoseconds
    num_replicas: body.replicas,
  } as unknown as StreamConfig;

  try {
    const jsm = await jetstreamManager(entry.nc);
    const info = await jsm.streams.add(config);
    return c.json(info);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Create stream failed' }, 500);
  }
});

jetstreamRoutes.get('/:id/streams/:name', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  try {
    const jsm = await jetstreamManager(entry.nc);
    const info = await jsm.streams.info(c.req.param('name'));
    return c.json(info);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Stream not found' }, 404);
  }
});

jetstreamRoutes.delete('/:id/streams/:name', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  try {
    const jsm = await jetstreamManager(entry.nc);
    await jsm.streams.delete(c.req.param('name'));
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Delete stream failed' }, 500);
  }
});

// ---- Consumers -----------------------------------------------------------

jetstreamRoutes.get('/:id/streams/:name/consumers', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  try {
    const jsm = await jetstreamManager(entry.nc);
    const consumers = await collect(jsm.consumers.list(c.req.param('name')));
    return c.json({ consumers });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'List consumers failed' }, 500);
  }
});

jetstreamRoutes.get('/:id/streams/:name/consumers/:consumer', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  try {
    const jsm = await jetstreamManager(entry.nc);
    const info = await jsm.consumers.info(c.req.param('name'), c.req.param('consumer'));
    return c.json(info);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Consumer not found' }, 404);
  }
});

jetstreamRoutes.delete('/:id/streams/:name/consumers/:consumer', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  try {
    const jsm = await jetstreamManager(entry.nc);
    await jsm.consumers.delete(c.req.param('name'), c.req.param('consumer'));
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Delete consumer failed' }, 500);
  }
});

// ---- Key-Value -----------------------------------------------------------

// List KV buckets (streams whose name starts with KV_).
jetstreamRoutes.get('/:id/kv', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  const jsm = await jetstreamManager(entry.nc);
  const streams = await collect(jsm.streams.list());
  const buckets = streams
    .map((s) => s.config?.name)
    .filter((n): n is string => typeof n === 'string' && n.startsWith('KV_'))
    .map((n) => n.slice('KV_'.length));
  return c.json({ buckets });
});

// Create a KV bucket.
jetstreamRoutes.post('/:id/kv', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  const body = await c.req.json<{ name: string; ttl?: number }>();
  try {
    const kvm = new Kvm(entry.nc);
    await kvm.create(body.name, { ttl: body.ttl ? body.ttl * 1000 : undefined });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Create bucket failed' }, 500);
  }
});

// Delete a KV bucket.
jetstreamRoutes.delete('/:id/kv/:bucket', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  try {
    const kvm = new Kvm(entry.nc);
    const kv = await kvm.open(c.req.param('bucket'));
    await kv.destroy();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Delete bucket failed' }, 500);
  }
});

// List keys of a bucket.
jetstreamRoutes.get('/:id/kv/:bucket/keys', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  try {
    const kvm = new Kvm(entry.nc);
    const kv = await kvm.open(c.req.param('bucket'));
    const iter = await kv.keys();
    const keys = await collect(iter);
    return c.json({ keys });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'List keys failed' }, 500);
  }
});

// Get a single value. Key is passed as a query param to tolerate '.' / '/' in keys.
jetstreamRoutes.get('/:id/kv/:bucket/value', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  const key = c.req.query('key');
  if (!key) return c.json({ error: 'key is required' }, 400);
  try {
    const kvm = new Kvm(entry.nc);
    const kv = await kvm.open(c.req.param('bucket'));
    const e = await kv.get(key);
    return c.json({ value: e ? e.string() : null });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Get value failed' }, 500);
  }
});

// Put a value.
jetstreamRoutes.put('/:id/kv/:bucket/value', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  const body = await c.req.json<{ key: string; value: string }>();
  if (!body.key) return c.json({ error: 'key is required' }, 400);
  try {
    const kvm = new Kvm(entry.nc);
    const kv = await kvm.open(c.req.param('bucket'));
    await kv.put(body.key, encoder.encode(body.value ?? ''));
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Put value failed' }, 500);
  }
});

// Delete a key.
jetstreamRoutes.delete('/:id/kv/:bucket/value', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  const key = c.req.query('key');
  if (!key) return c.json({ error: 'key is required' }, 400);
  try {
    const kvm = new Kvm(entry.nc);
    const kv = await kvm.open(c.req.param('bucket'));
    await kv.delete(key);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Delete key failed' }, 500);
  }
});

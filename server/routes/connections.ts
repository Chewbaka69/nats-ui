import { Hono } from 'hono';
import { createConnection, getConnection, closeConnection, type CreateConnectionInput } from '../connections.ts';
import { buildHeaders, encodePayload } from '../nats-helpers.ts';

export const connectionsRoutes = new Hono();

const ALLOWED_MONITORING = new Set(['varz', 'connz', 'jsz', 'healthz']);

// Open a connection. Returns a connectionId the client uses for all later calls.
connectionsRoutes.post('/', async (c) => {
  let body: CreateConnectionInput;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.servers || (Array.isArray(body.servers) && body.servers.length === 0)) {
    return c.json({ error: 'servers is required' }, 400);
  }

  try {
    const connectionId = await createConnection(body);
    return c.json({ connectionId, status: 'connected' });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Connection failed' }, 502);
  }
});

// Connection status.
connectionsRoutes.get('/:id', (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ status: 'closed' }, 404);
  return c.json({ status: entry.nc.isClosed() ? 'closed' : 'connected' });
});

// Close a connection.
connectionsRoutes.delete('/:id', async (c) => {
  await closeConnection(c.req.param('id'));
  return c.json({ status: 'closed' });
});

// Publish a message.
connectionsRoutes.post('/:id/publish', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);

  const body = await c.req.json<{ subject: string; data: unknown; headers?: Record<string, string> }>();
  if (!body.subject) return c.json({ error: 'subject is required' }, 400);

  try {
    const { bytes } = encodePayload(body.data);
    entry.nc.publish(body.subject, bytes, { headers: buildHeaders(body.headers) });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Publish failed' }, 500);
  }
});

// Proxy the NATS HTTP monitoring API (varz/connz/jsz) using the httpUrl stored
// with the connection. Query params are forwarded (e.g. ?streams=1, ?subs=1).
connectionsRoutes.get('/:id/monitoring/:what', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  if (!entry.httpUrl) return c.json({ error: 'No monitoring URL configured' }, 400);

  const what = c.req.param('what');
  if (!ALLOWED_MONITORING.has(what)) {
    return c.json({ error: `Unsupported monitoring endpoint: ${what}` }, 400);
  }

  const base = entry.httpUrl.replace(/\/+$/, '');
  const url = new URL(`${base}/${what}`);
  for (const [key, value] of Object.entries(c.req.query())) {
    url.searchParams.set(key, value);
  }

  try {
    const res = await fetch(url);
    if (!res.ok) return c.json({ error: `HTTP ${res.status}` }, 502);
    const data = await res.json();
    return c.json(data);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Monitoring fetch failed' }, 502);
  }
});

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

type MonitoringResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: string };

// Fetch the NATS HTTP monitoring API (varz/connz/jsz/healthz) server-side, using
// the httpUrl stored with the connection. The browser never contacts the
// monitoring endpoint directly — it only ever talks to this backend.
async function fetchMonitoring(
  httpUrl: string,
  what: string,
  search?: Record<string, string>,
): Promise<MonitoringResult> {
  if (!ALLOWED_MONITORING.has(what)) {
    return { ok: false, status: 400, error: `Unsupported monitoring endpoint: ${what}` };
  }

  const base = httpUrl.replace(/\/+$/, '');
  const url = new URL(`${base}/${what}`);
  if (search) {
    for (const [key, value] of Object.entries(search)) {
      url.searchParams.set(key, value);
    }
  }

  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, status: 502, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? err.message : 'Monitoring fetch failed' };
  }
}

// Report whether the NATS HTTP monitoring API is reachable. The probe runs
// server-side (like the NATS connection itself); the UI only displays the
// result instead of calling the monitoring endpoint from the browser.
connectionsRoutes.get('/:id/monitoring-status', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  if (!entry.httpUrl) return c.json({ status: 'unconfigured' });

  const result = await fetchMonitoring(entry.httpUrl, 'healthz');
  if (result.ok) return c.json({ status: 'available' });
  return c.json({ status: 'error', error: result.error });
});

// Proxy the NATS HTTP monitoring API (varz/connz/jsz) using the httpUrl stored
// with the connection. Query params are forwarded (e.g. ?streams=1, ?subs=1).
connectionsRoutes.get('/:id/monitoring/:what', async (c) => {
  const entry = getConnection(c.req.param('id'));
  if (!entry) return c.json({ error: 'Connection not found' }, 404);
  if (!entry.httpUrl) return c.json({ error: 'No monitoring URL configured' }, 400);

  const result = await fetchMonitoring(entry.httpUrl, c.req.param('what'), c.req.query());
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 502);
  return c.json(result.data);
});

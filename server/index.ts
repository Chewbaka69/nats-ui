import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { connectionsRoutes } from './routes/connections.ts';
import { jetstreamRoutes } from './routes/jetstream.ts';
import { registerWebSocket } from './ws.ts';

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Real-time subscription WebSocket (registered before serving).
registerWebSocket(app, upgradeWebSocket);

// REST API — both routers are mounted under /api/connections.
app.route('/api/connections', connectionsRoutes);
app.route('/api/connections', jetstreamRoutes);

app.get('/api/health', (c) => c.json({ ok: true }));

// Static frontend (production build). In dev, Vite serves the client and
// proxies /api + the WebSocket to this backend, so these are inert.
app.use('/*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));

const port = Number(process.env.PORT) || 3000;
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`NATS UI backend listening on http://localhost:${info.port}`);
});
injectWebSocket(server);

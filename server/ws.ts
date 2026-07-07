import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Subscription } from '@nats-io/transport-node';
import { getConnection } from './connections.ts';
import { toWireMessage } from './nats-helpers.ts';

/**
 * Registers a multiplexed real-time subscription endpoint:
 *   GET /api/connections/:id/subscribe  (WebSocket upgrade)
 *
 * The client sends { action: 'subscribe' | 'unsubscribe', subject }. The backend
 * holds the NATS subscription and streams each message back as
 * { type: 'message', message: { subject, data, headers, reply, timestamp } }.
 */
export function registerWebSocket(app: Hono, upgradeWebSocket: UpgradeWebSocket) {
  app.get(
    '/api/connections/:id/subscribe',
    upgradeWebSocket((c) => {
      const id = c.req.param('id') as string;
      const subs = new Map<string, Subscription>();

      return {
        onMessage(event, ws) {
          let payload: { action?: string; subject?: string };
          try {
            payload = JSON.parse(typeof event.data === 'string' ? event.data : '{}');
          } catch {
            return;
          }
          const { action, subject } = payload;
          if (!subject) return;

          if (action === 'subscribe') {
            if (subs.has(subject)) return;
            const entry = getConnection(id);
            if (!entry) {
              ws.send(JSON.stringify({ type: 'error', subject, error: 'Connection not found' }));
              return;
            }
            const sub = entry.nc.subscribe(subject);
            subs.set(subject, sub);
            (async () => {
              for await (const msg of sub) {
                if (ws.readyState !== 1 /* OPEN */) break;
                // `subject` echoes the subscribed pattern so the client can route
                // messages back to the right (possibly wildcard) subscription.
                ws.send(JSON.stringify({ type: 'message', subject, message: toWireMessage(msg) }));
              }
            })().catch(() => {
              /* subscription ended */
            });
          } else if (action === 'unsubscribe') {
            const sub = subs.get(subject);
            if (sub) {
              sub.unsubscribe();
              subs.delete(subject);
            }
          }
        },
        onClose() {
          for (const sub of subs.values()) sub.unsubscribe();
          subs.clear();
        },
      };
    }),
  );
}

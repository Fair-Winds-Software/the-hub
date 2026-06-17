// Authorized by HUB-1006 — integration tests: flush success; flush retry after 503; disconnect empties buffer; version POST

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

const mockAcquireToken = vi.hoisted(() => vi.fn());
vi.mock('../auth/acquireToken.js', () => ({ acquireToken: mockAcquireToken }));

import { HubClient } from '../HubClient.js';
import { SDK_VERSION } from '../version.js';

// ── in-process mock server helpers ────────────────────────────────────────────

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

function createMockServer(
  handler: (req: RecordedRequest) => { status: number; body?: unknown },
): { server: http.Server; requests: RecordedRequest[]; url: string } {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const recorded: RecordedRequest = { method: req.method ?? 'GET', url: req.url ?? '/', body };
      requests.push(recorded);
      const result = handler(recorded);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body ?? {}));
    });
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;
  return { server, requests, url: `http://localhost:${port}` };
}

// ── integration tests ─────────────────────────────────────────────────────────

(RUN_INTEGRATION ? describe : describe.skip)(
  'Usage Integration Tests (RUN_INTEGRATION=1)',
  () => {
    let server: http.Server;
    let serverUrl: string;
    let requests: RecordedRequest[];

    beforeEach(() => {
      mockAcquireToken.mockResolvedValue({ token: 'tok', expiresAt: Date.now() + 3_600_000 });
    });

    afterEach(() => {
      return new Promise<void>(resolve => server.close(() => resolve()));
    });

    it('flush success — events are POSTed to /api/v1/usage/ingest', async () => {
      ({ server, requests, url: serverUrl } = createMockServer(() => ({ status: 200 })));

      const client = new HubClient({
        clientId: 'cid',
        clientSecret: 'csec',
        hubUrl: serverUrl,
        flushIntervalMs: 200,
        lateThresholdMs: 60_000,
        disconnectFlushTimeoutMs: 2_000,
        versionReportIntervalMs: 99_999_000,
      });
      await client.connect();

      client.trackUsage('t1', 'p1', { event_type: 'api_call', quantity: 3 });

      await new Promise(r => setTimeout(r, 400)); // wait 2 flush intervals

      const ingestReqs = requests.filter(r => r.url === '/api/v1/usage/ingest');
      expect(ingestReqs.length).toBeGreaterThanOrEqual(1);

      const body = JSON.parse(ingestReqs[0]!.body) as {
        events: Array<{ event_type: string; quantity: number }>;
      };
      expect(body.events[0]!.event_type).toBe('api_call');
      expect(body.events[0]!.quantity).toBe(3);

      await client.disconnect();
    });

    it('flush retry after 503 — events retained and resent on next interval', async () => {
      let callCount = 0;
      ({ server, requests, url: serverUrl } = createMockServer(req => {
        if (req.url === '/api/v1/usage/ingest') {
          callCount++;
          return callCount === 1 ? { status: 503 } : { status: 200 };
        }
        return { status: 200 };
      }));

      const client = new HubClient({
        clientId: 'cid',
        clientSecret: 'csec',
        hubUrl: serverUrl,
        flushIntervalMs: 150,
        lateThresholdMs: 60_000,
        disconnectFlushTimeoutMs: 2_000,
        versionReportIntervalMs: 99_999_000,
      });
      await client.connect();

      client.trackUsage('t1', 'p1', { event_type: 'retry_event', quantity: 1 });

      // Wait for 503 flush + recovery flush
      await new Promise(r => setTimeout(r, 500));

      const ingestReqs = requests.filter(r => r.url === '/api/v1/usage/ingest');
      expect(ingestReqs.length).toBeGreaterThanOrEqual(2); // first failed, second succeeded

      // Final successful ingest should contain the event
      const lastBody = JSON.parse(ingestReqs.at(-1)!.body) as {
        events: Array<{ event_type: string }>;
      };
      expect(lastBody.events.some(e => e.event_type === 'retry_event')).toBe(true);

      await client.disconnect();
    });

    it('disconnect() flushes buffered events before closing', async () => {
      ({ server, requests, url: serverUrl } = createMockServer(() => ({ status: 200 })));

      const client = new HubClient({
        clientId: 'cid',
        clientSecret: 'csec',
        hubUrl: serverUrl,
        flushIntervalMs: 60_000, // long interval — won't auto-flush
        lateThresholdMs: 60_000,
        disconnectFlushTimeoutMs: 3_000,
        versionReportIntervalMs: 99_999_000,
      });
      await client.connect();

      client.trackUsage('t1', 'p1', { event_type: 'disconnect_event', quantity: 5 });

      await client.disconnect();

      const ingestReqs = requests.filter(r => r.url === '/api/v1/usage/ingest');
      expect(ingestReqs.length).toBeGreaterThanOrEqual(1);

      const body = JSON.parse(ingestReqs[0]!.body) as {
        events: Array<{ event_type: string }>;
      };
      expect(body.events[0]!.event_type).toBe('disconnect_event');
    });

    it('version report POSTed to /api/v1/sdk/version on connect()', async () => {
      ({ server, requests, url: serverUrl } = createMockServer(() => ({ status: 200 })));

      const client = new HubClient({
        clientId: 'integration-client',
        clientSecret: 'csec',
        hubUrl: serverUrl,
        flushIntervalMs: 60_000,
        disconnectFlushTimeoutMs: 1_000,
        versionReportIntervalMs: 99_999_000,
      });
      await client.connect();

      const versionReqs = requests.filter(r => r.url === '/api/v1/sdk/version');
      expect(versionReqs.length).toBeGreaterThanOrEqual(1);

      const body = JSON.parse(versionReqs[0]!.body) as {
        sdk_version: string;
        client_id: string;
      };
      expect(body.sdk_version).toBe(SDK_VERSION);
      expect(body.client_id).toBe('integration-client');

      await client.disconnect();
    });
  },
);

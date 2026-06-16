// Authorized by HUB-747 — unit tests: in-app notification INSERT; message format; returned id
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

vi.mock('../../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleInAppDelivery } from '../inAppHandler.js';
import type { AlertJobData, NotificationChannel } from '../types.js';

const CHANNEL: NotificationChannel = {
  id: 'ch-333',
  tenant_id: 'ten-333',
  product_id: 'prod-333',
  channel_type: 'in_app',
  config: {},
  hmac_secret: null,
  enabled: true,
  created_at: new Date(),
};

const ALERT: AlertJobData = {
  alertId: 'alert-333',
  tenantId: 'ten-333',
  productId: 'prod-333',
  alertType: 'below_floor',
  severity: 'info',
  fireCount: 2,
};

beforeEach(() => {
  vi.resetAllMocks();
  mockPoolQuery.mockResolvedValue({ rows: [{ id: 'notif-uuid-1' }] });
});

describe('handleInAppDelivery', () => {
  it('returns the inserted notification id', async () => {
    const id = await handleInAppDelivery(CHANNEL, ALERT);
    expect(id).toBe('notif-uuid-1');
  });

  it('inserts with correct tenant_id, product_id, and alert_event_id', async () => {
    await handleInAppDelivery(CHANNEL, ALERT);
    const [, params] = mockPoolQuery.mock.calls[0]!;
    expect(params).toContain(ALERT.tenantId);
    expect(params).toContain(ALERT.productId);
    expect(params).toContain(ALERT.alertId);
  });

  it('message includes severity uppercased and alertType', async () => {
    await handleInAppDelivery(CHANNEL, ALERT);
    const [, params] = mockPoolQuery.mock.calls[0]!;
    const message = params[3] as string;
    expect(message).toContain('INFO');
    expect(message).toContain('below_floor');
  });

  it('message includes fireCount', async () => {
    await handleInAppDelivery(CHANNEL, ALERT);
    const [, params] = mockPoolQuery.mock.calls[0]!;
    const message = params[3] as string;
    expect(message).toContain('fire #2');
  });

  it('rethrows query errors', async () => {
    mockPoolQuery.mockRejectedValue(new Error('DB error'));
    await expect(handleInAppDelivery(CHANNEL, ALERT)).rejects.toThrow('DB error');
  });
});

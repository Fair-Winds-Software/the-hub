// Authorized by HUB-175 — integration tests for stripe_webhook_events table migration
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://hub:hub@localhost:5432/hub_dev';

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  // Clean up any leftover test rows from previous runs
  await client.query(`DELETE FROM stripe_webhook_events WHERE event_id LIKE 'evt_hub175_%'`);
});

afterAll(async () => {
  await client.query(`DELETE FROM stripe_webhook_events WHERE event_id LIKE 'evt_hub175_%'`);
  await client.end();
});

describe('stripe_webhook_events schema', () => {
  it('table exists with all required columns', async () => {
    const { rows } = await client.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'stripe_webhook_events'
       ORDER BY ordinal_position`
    );
    const cols = rows.reduce<Record<string, string>>((acc, r) => {
      acc[r.column_name] = r.is_nullable;
      return acc;
    }, {});

    expect(cols).toHaveProperty('id');
    expect(cols).toHaveProperty('event_id');
    expect(cols).toHaveProperty('event_type');
    expect(cols).toHaveProperty('product_id');
    expect(cols).toHaveProperty('received_at');
    expect(cols).toHaveProperty('processed_at');
    expect(cols).toHaveProperty('status');
    expect(cols).toHaveProperty('raw_event');
    expect(cols).toHaveProperty('delta_data');

    // product_id and processed_at must be nullable
    expect(cols['product_id']).toBe('YES');
    expect(cols['processed_at']).toBe('YES');
    // status must be NOT NULL
    expect(cols['status']).toBe('NO');
  });

  it('index on (product_id, received_at) exists', async () => {
    const { rows } = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'idx_stripe_webhook_events_product_received'`
    );
    expect(rows).toHaveLength(1);
  });
});

describe('stripe_webhook_events idempotency', () => {
  it('duplicate event_id raises unique constraint violation (23505)', async () => {
    await client.query(
      `INSERT INTO stripe_webhook_events (event_id, event_type, raw_event)
       VALUES ('evt_hub175_dup', 'customer.created', '{}')
       ON CONFLICT DO NOTHING`
    );

    const err = await client
      .query(
        `INSERT INTO stripe_webhook_events (event_id, event_type, raw_event)
         VALUES ('evt_hub175_dup', 'customer.created', '{}')`
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException & { code: string }).code).toBe('23505');
  });
});

describe('stripe_webhook_events delta tracking', () => {
  it('UPDATE sets delta_data with before/after snapshot', async () => {
    await client.query(
      `INSERT INTO stripe_webhook_events (event_id, event_type, raw_event, status)
       VALUES ('evt_hub175_update', 'invoice.paid', '{"amount": 100}', 'received')`
    );

    await client.query(
      `UPDATE stripe_webhook_events SET status = 'dispatched'
       WHERE event_id = 'evt_hub175_update'`
    );

    const { rows } = await client.query<{ delta_data: Record<string, unknown> }>(
      `SELECT delta_data FROM stripe_webhook_events WHERE event_id = 'evt_hub175_update'`
    );

    expect(rows).toHaveLength(1);
    const delta = rows[0].delta_data;
    expect(delta).toHaveProperty('before');
    expect(delta).toHaveProperty('after');
    expect(delta).toHaveProperty('changed_at');
    expect((delta['before'] as Record<string, unknown>)['status']).toBe('received');
    expect((delta['after'] as Record<string, unknown>)['status']).toBe('dispatched');
  });

  it('DELETE inserts a row into delta_log', async () => {
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO stripe_webhook_events (event_id, event_type, raw_event)
       VALUES ('evt_hub175_delete', 'charge.failed', '{}')
       RETURNING id`
    );
    const rowId = inserted[0].id;

    const { rows: logBefore } = await client.query(
      `SELECT id FROM delta_log WHERE table_name = 'stripe_webhook_events' AND row_id = $1`,
      [rowId]
    );
    expect(logBefore).toHaveLength(0);

    await client.query(
      `DELETE FROM stripe_webhook_events WHERE event_id = 'evt_hub175_delete'`
    );

    const { rows: logAfter } = await client.query(
      `SELECT id FROM delta_log WHERE table_name = 'stripe_webhook_events' AND row_id = $1`,
      [rowId]
    );
    expect(logAfter).toHaveLength(1);
  });
});

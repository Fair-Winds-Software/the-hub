// Authorized by HUB-1779 (S6 of HUB-1773) — integration tests for the file importers.
// Verifies CSV + single-JSON + NDJSON paths funnel through the S5 seed API's validate-then-
// insert flow, enforce FK integrity, respect the S7 mock-only guard, and observe all-or-
// nothing semantics on any malformed / orphan-ref failure.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../index.js';
import { importCsv, importJson } from '../importers.js';
import { _resetStripeRegistryForTest, _setStripeModeForTest } from '../../registry.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

async function writeTemp(filename: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-import-'));
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

(RUN_INTEGRATION ? describe : describe.skip)(
  'Seeding importers (RUN_INTEGRATION=1)',
  () => {
    beforeAll(() => {
      _setStripeModeForTest('mock');
    });

    afterAll(async () => {
      _setStripeModeForTest('mock');
      await seed.reset();
      _resetStripeRegistryForTest();
      const { closePool } = await import('../../../db/pool.js');
      await closePool();
    });

    beforeEach(async () => {
      _setStripeModeForTest('mock');
      await seed.reset();
    });

    describe('importCsv', () => {
      it('imports a valid customers.csv and returns success:true', async () => {
        const csv = [
          'id,email,name',
          'cus_csv_1,alice@example.com,Alice',
          'cus_csv_2,bob@example.com,',
        ].join('\n');
        const filePath = await writeTemp('customers.csv', csv);
        const result = await importCsv(filePath, 'customers');
        expect(result).toMatchObject({ success: true, rowsAttempted: 2, rowsCommitted: 2 });
        const snap = await seed.snapshot();
        expect(snap.customers).toBe(2);
      });

      it('malformed CSV row (missing required field) rolls back the whole load', async () => {
        const csv = [
          'id,email',
          'cus_csv_ok,alice@example.com',
          'cus_csv_bad,not-a-valid-email',
        ].join('\n');
        const filePath = await writeTemp('customers.csv', csv);
        const result = await importCsv(filePath, 'customers');
        expect(result.success).toBe(false);
        expect(result.rowsCommitted).toBe(0);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]!.message).toMatch(/email|Invalid/);
        const snap = await seed.snapshot();
        expect(snap.customers).toBe(0);
      });

      it('orphaned customer_id in subscriptions.csv rolls back', async () => {
        // Seed one customer + one product + one price so subscriptions has SOMETHING valid to reference.
        const [customer] = await seed.customers.create({ email: 'exists@example.com' });
        const [product] = await seed.products.create({ name: 'p' });
        const [price] = await seed.prices.create({
          product: product!.id, unit_amount: 1000, currency: 'usd',
        });

        // subscriptions.csv references one existing customer + one bogus id.
        const csv = [
          'customer,items',
          `${customer!.id},"[{""price"":""${price!.id}""}]"`,
          `cus_bogus,"[{""price"":""${price!.id}""}]"`,
        ].join('\n');
        const filePath = await writeTemp('subscriptions.csv', csv);
        const result = await importCsv(filePath, 'subscriptions');
        expect(result.success).toBe(false);
        expect(result.rowsCommitted).toBe(0);
        expect(result.errors[0]!.message).toMatch(/Orphaned customer/);
        const snap = await seed.snapshot();
        expect(snap.subscriptions).toBe(0);
      });

      it('respects the mock-only guard: throws in LIVE mode', async () => {
        _setStripeModeForTest('live');
        const csv = 'id,email\ncus_live_x,x@example.com\n';
        const filePath = await writeTemp('customers.csv', csv);
        const result = await importCsv(filePath, 'customers');
        expect(result.success).toBe(false);
        expect(result.errors[0]!.message).toMatch(/Seeding forbidden/);
      });
    });

    describe('importJson — single-file bundle', () => {
      it('imports a full customers/products/prices/subscriptions bundle', async () => {
        const bundle = {
          customers: [
            { id: 'cus_json_alice', email: 'alice@example.com' },
            { id: 'cus_json_bob', email: 'bob@example.com' },
          ],
          products: [{ id: 'prod_pro', name: 'Pro' }],
          prices: [
            { id: 'price_pro_monthly', product: 'prod_pro', unit_amount: 2000, currency: 'usd' },
          ],
          subscriptions: [
            { customer: 'cus_json_alice', items: [{ price: 'price_pro_monthly' }] },
          ],
        };
        const filePath = await writeTemp('bundle.json', JSON.stringify(bundle));
        const result = await importJson(filePath);
        expect(result).toMatchObject({ success: true, rowsAttempted: 5, rowsCommitted: 5 });
        const snap = await seed.snapshot();
        expect(snap.customers).toBe(2);
        expect(snap.products).toBe(1);
        expect(snap.prices).toBe(1);
        expect(snap.subscriptions).toBe(1);
      });

      it('malformed row deep in the bundle rolls back ALL prior groups too', async () => {
        // customers + products + prices commit OK; the subscription row references a bogus price.
        const bundle = {
          customers: [{ id: 'cus_j1', email: 'a@b.co' }],
          products: [{ id: 'prod_j1', name: 'X' }],
          prices: [
            { id: 'price_j1', product: 'prod_j1', unit_amount: 500, currency: 'usd' },
          ],
          subscriptions: [
            { customer: 'cus_j1', items: [{ price: 'price_does_not_exist' }] },
          ],
        };
        const filePath = await writeTemp('bundle_bad.json', JSON.stringify(bundle));
        const result = await importJson(filePath);
        expect(result.success).toBe(false);
        expect(result.rowsCommitted).toBe(0);
        expect(result.errors[0]!.message).toMatch(/Orphaned price/);
        const snap = await seed.snapshot();
        expect(snap.customers).toBe(0);
        expect(snap.products).toBe(0);
        expect(snap.prices).toBe(0);
        expect(snap.subscriptions).toBe(0);
      });
    });

    describe('importJson — NDJSON', () => {
      it('imports NDJSON with _object discriminators in FK-safe order', async () => {
        const lines = [
          '{"_object":"customer","id":"cus_nd_alice","email":"a@ex.com"}',
          '{"_object":"customer","id":"cus_nd_bob","email":"b@ex.com"}',
          '{"_object":"product","id":"prod_ndj","name":"P"}',
          '{"_object":"price","id":"price_ndj","product":"prod_ndj","unit_amount":500,"currency":"usd"}',
        ].join('\n');
        const filePath = await writeTemp('bundle.ndjson', lines);
        const result = await importJson(filePath);
        expect(result.success).toBe(true);
        expect(result.rowsCommitted).toBe(4);
        const snap = await seed.snapshot();
        expect(snap.customers).toBe(2);
        expect(snap.products).toBe(1);
        expect(snap.prices).toBe(1);
      });

      it('NDJSON line missing _object throws AppError', async () => {
        const lines = [
          '{"_object":"customer","email":"a@b.co"}',
          '{"email":"c@d.co"}',
        ].join('\n');
        const filePath = await writeTemp('bundle_bad.ndjson', lines);
        await expect(importJson(filePath)).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining('_object') as unknown as string,
        });
      });

      it('NDJSON with malformed JSON on any line throws AppError', async () => {
        const lines = [
          '{"_object":"customer","email":"a@b.co"}',
          'not-valid-json-at-all',
        ].join('\n');
        const filePath = await writeTemp('bad.ndjson', lines);
        await expect(importJson(filePath)).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining('NDJSON') as unknown as string,
        });
      });
    });

    describe('mock-only guard — importJson', () => {
      it('throws in LIVE mode before any read', async () => {
        _setStripeModeForTest('live');
        const bundle = { customers: [{ email: 'a@b.co' }] };
        const filePath = await writeTemp('live.json', JSON.stringify(bundle));
        const result = await importJson(filePath);
        expect(result.success).toBe(false);
        expect(result.errors[0]!.message).toMatch(/Seeding forbidden/);
      });
    });
  },
);

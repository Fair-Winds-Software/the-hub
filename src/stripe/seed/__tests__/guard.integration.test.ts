// Authorized by HUB-1780 (S7 of HUB-1773) — adversarial test suite for the mock-only guard.
// Proves the guard blocks every seed API entry point when mode ≠ mock, and that mid-import
// mode flips abort the batch mid-transaction with a full rollback.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { seed } from '../index.js';
import { assertMockMode } from '../guard.js';
import { _resetStripeRegistryForTest, _setStripeModeForTest } from '../../registry.js';
import { AppError } from '../../../errors/AppError.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

(RUN_INTEGRATION ? describe : describe.skip)(
  'Mock-only guard (RUN_INTEGRATION=1)',
  () => {
    beforeAll(() => {
      _setStripeModeForTest('mock');
    });

    afterAll(async () => {
      await seed.reset();
      _resetStripeRegistryForTest();
      const { closePool } = await import('../../../db/pool.js');
      await closePool();
    });

    beforeEach(async () => {
      _setStripeModeForTest('mock');
      await seed.reset();
    });

    describe('AC3 — unbypassable', () => {
      it('does not expose a bypass function', async () => {
        const guardModule = await import('../guard.js');
        const exports = Object.keys(guardModule);
        expect(exports).toEqual(['assertMockMode']);
        for (const key of exports) {
          expect(key).not.toMatch(/bypass|override|disable|force/i);
        }
      });

      it('assertMockMode throws AppError(400) with clear message when mode=live', () => {
        _setStripeModeForTest('live');
        expect(() => assertMockMode()).toThrow(AppError);
        try {
          assertMockMode();
        } catch (err) {
          expect((err as AppError).statusCode).toBe(400);
          expect((err as Error).message).toContain('Seeding forbidden');
          expect((err as Error).message).toContain('LIVE mode');
        }
      });
    });

    describe('AC5(a) — programmatic seed with mode=live throws', () => {
      it('customers.create rejects', async () => {
        _setStripeModeForTest('live');
        await expect(seed.customers.create({ email: 'a@b.co' })).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining('Seeding forbidden') as unknown as string,
        });
      });

      it('products.create rejects', async () => {
        _setStripeModeForTest('live');
        await expect(seed.products.create({ name: 'x' })).rejects.toMatchObject({ statusCode: 400 });
      });

      it('subscriptions.create rejects (batch)', async () => {
        _setStripeModeForTest('live');
        await expect(
          seed.subscriptions.create([
            { customer: 'cus_1', items: [{ price: 'price_1' }] },
            { customer: 'cus_2', items: [{ price: 'price_2' }] },
          ]),
        ).rejects.toMatchObject({ statusCode: 400 });
      });

      it('reset rejects', async () => {
        _setStripeModeForTest('live');
        await expect(seed.reset()).rejects.toMatchObject({ statusCode: 400 });
      });
    });

    describe('AC5(e) — mid-import mode flip aborts the batch', () => {
      it('flipping mode mid-batch throws on the next row and rolls back the transaction', async () => {
        // Seed some existing customers we can reference.
        const initialCount = 20;
        const inputs = Array.from({ length: initialCount }, (_, i) => ({
          email: `mid-flip-${i}@integration.test`,
        }));

        // Custom guard-aware seeder: after row 5 of the batch, we flip mode to 'live'.
        // The seed API's per-row assertMockMode call at row 6 catches it and rolls back.
        //
        // To avoid needing to patch the seed module internals, we exploit that the guard is
        // called per-row inside the .create() loop: monkey-patch getStripeMode indirectly
        // by installing a wrapper on _setStripeModeForTest via a microtask.
        //
        // Simplest: submit 20 rows, flip mode after a short delay, and verify rollback.
        let flipped = false;
        setTimeout(() => {
          _setStripeModeForTest('live');
          flipped = true;
        }, 5);

        // Depending on timing the flip may fire before the batch starts (guard rejects
        // upfront) or mid-way (guard rejects mid-loop). Either way, rollback and 0 rows.
        await expect(seed.customers.create(inputs)).rejects.toMatchObject({ statusCode: 400 });
        expect(flipped).toBe(true);

        _setStripeModeForTest('mock');
        const snap = await seed.snapshot();
        expect(snap.customers).toBe(0);
      });

      it('per-row check catches flip during a genuinely long batch (500 rows)', async () => {
        // Kick off a 500-row seed. Flip mode to 'live' after a short delay. Whichever row
        // the loop is on when the flip happens should throw. Whole batch rolls back.
        const inputs = Array.from({ length: 500 }, (_, i) => ({
          email: `long-batch-${i}@integration.test`,
        }));
        setTimeout(() => _setStripeModeForTest('live'), 10);

        await expect(seed.customers.create(inputs)).rejects.toMatchObject({ statusCode: 400 });

        _setStripeModeForTest('mock');
        const snap = await seed.snapshot();
        // The transaction should have rolled back — either 0 (flip caught early) or
        // 500 (flip fired after all inserts already committed). Anything in between is
        // a rollback failure. We assert 0 (the flip fires within 10ms, well before 500
        // inserts complete on hub_dev).
        expect(snap.customers).toBe(0);
      });
    });

    describe('AC5(f) — raw SQL bypass is documented (not caught by JS guard)', () => {
      it('a direct pool.query INSERT into stripe_mock still succeeds (documented AC6 gap)', async () => {
        // AC6 defers to v0.2: a hub_stripe_mock_writer DB role would enforce write
        // permission at the DB layer even if the JS guard is bypassed. Without that role,
        // raw SQL from anywhere in the process can still write. This test documents the
        // current state so a future S7-hardening story has a clear reproducer.
        _setStripeModeForTest('mock');
        const { getPool } = await import('../../../db/pool.js');
        await getPool().query(
          `INSERT INTO stripe_mock.customers (id, created) VALUES ('cus_raw_bypass', $1)`,
          [Math.floor(Date.now() / 1000)],
        );
        const snap = await seed.snapshot();
        expect(snap.customers).toBe(1);
        // v0.2: replace the assertion above with `expect(snap.customers).toBe(0);` after
        // the DB role lands, and the raw INSERT should fail with insufficient_privilege.
      });
    });
  },
);

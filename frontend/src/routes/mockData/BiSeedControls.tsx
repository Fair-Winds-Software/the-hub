// Seed / wipe synthetic BI rollups so the Dashboard tiles + per-product BI
// drill-ins have data to render during a demo tour, without needing real
// products to push events through /admin/bi/metrics.
import { useState } from 'react';
import { apiClient } from '../../lib/api';

const SEED_PATH = '/api/v1/admin/bi/mock-rollups';

interface SeedResult {
  products_touched: number;
  rollups_upserted: number;
  days_seeded: number;
}

interface WipeResult {
  deleted: number;
}

export function BiSeedControls(): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSeed(): Promise<void> {
    setBusy(true);
    setError(null);
    setLastMessage(null);
    try {
      const result = await apiClient.post<SeedResult>(SEED_PATH, {
        product_limit: 10,
        days: 30,
      });
      setLastMessage(
        `Seeded ${result.rollups_upserted.toLocaleString()} rollup rows across ${result.products_touched} products (${result.days_seeded} days of history).`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleWipe(): Promise<void> {
    if (!window.confirm('Wipe all BI rollups (mrr / dau / churn / customers / health)?')) {
      return;
    }
    setBusy(true);
    setError(null);
    setLastMessage(null);
    try {
      const result = await apiClient.delete<WipeResult>(SEED_PATH);
      setLastMessage(`Deleted ${result.deleted.toLocaleString()} rollup rows.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="bi-seed-controls"
      aria-label="BI rollup seeder"
      className="flex flex-col gap-3 rounded-md border border-sailcloth/40 bg-white p-4"
    >
      <div>
        <h2 className="font-heading text-lg text-primary-navy">BI Metrics preset</h2>
        <p className="font-body text-sm text-deep-charcoal/70">
          Seed 30 days of synthetic MRR / DAU / churn / active-customers rollups across
          the first 10 products so the Dashboard tiles + per-product BI drill-ins light
          up. Idempotent — re-running overwrites the same rows. Wipe removes every
          rollup for those metrics.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSeed()}
          disabled={busy}
          data-testid="bi-seed-apply"
          className="rounded-md bg-primary-navy px-3 py-2 text-sm text-sailcloth hover:bg-primary-navy/90 disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Apply preset'}
        </button>
        <button
          type="button"
          onClick={() => void handleWipe()}
          disabled={busy}
          data-testid="bi-seed-wipe"
          className="rounded-md border border-ironwake/40 px-3 py-2 text-sm text-ironwake hover:bg-ironwake/5 disabled:opacity-50"
        >
          Wipe rollups
        </button>
      </div>
      {lastMessage && (
        <p data-testid="bi-seed-message" className="text-sm text-deep-charcoal/80">
          {lastMessage}
        </p>
      )}
      {error && (
        <p role="alert" data-testid="bi-seed-error" className="text-sm text-ironwake">
          {error}
        </p>
      )}
    </section>
  );
}

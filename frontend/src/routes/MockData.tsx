// Authorized by HUB-1799 (S3 of HUB-1784) — Mock Data admin panel shell. Renders the
// page heading + subhead, connection picker (Stripe-only today, driven off
// GET /api/v1/admin/connections for future-proofing), mode-aware enable/disable,
// snapshot row-counts grid, and empty slots for <SeedControls /> (S4) and
// <DeleteAllControls /> (S5).
//
// Data lifted here so the S4/S5 slot components consume the SAME snapshot fetch cadence
// (avoids two independent polls). Slots receive a `snapshot` prop + a `refresh` callback
// so a successful seed or delete refreshes the counts in-place without a page reload.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../lib/api';

const PAGE_TITLE = 'Mock Data | HUB Console';
const CONNECTIONS_LIST_PATH = '/api/v1/admin/connections';
const STRIPE_STATUS_PATH = '/api/v1/admin/connections/stripe/status';
const STRIPE_SNAPSHOT_PATH = '/api/v1/admin/connections/stripe/seed/snapshot';

type Mode = 'live' | 'mock';

interface ConnectionListItem {
  name: string;
  mode: Mode;
}

interface ConnectionsListResponse {
  connections: ConnectionListItem[];
}

interface ConnectionStatusResponse {
  name?: string;
  mode: Mode;
  health: 'ok' | 'degraded' | 'down';
}

export type SeedSnapshot = Record<string, number>;

interface SnapshotResponse {
  counts: SeedSnapshot;
}

interface Props {
  /** For test injection — production usage relies on the default apiClient. */
  fetchers?: {
    listConnections?: () => Promise<ConnectionsListResponse>;
    stripeStatus?: () => Promise<ConnectionStatusResponse>;
    stripeSnapshot?: () => Promise<SnapshotResponse>;
  };
}

// Empty-slot placeholders. S4/S5 replace these by exporting their own components; the
// shell passes them the snapshot + refresh callback so counts and post-op refreshes
// stay coherent across the panel.
function SeedControlsSlot({ snapshot: _snapshot, refresh: _refresh }: { snapshot: SeedSnapshot; refresh: () => void }): React.ReactElement {
  return (
    <section
      data-testid="mock-data-seed-slot"
      className="rounded-md border border-dashed border-sailcloth/40 p-4 text-sm text-deep-charcoal/60"
    >
      Seed controls will render here (S4).
    </section>
  );
}

function DeleteAllControlsSlot({ snapshot: _snapshot, refresh: _refresh }: { snapshot: SeedSnapshot; refresh: () => void }): React.ReactElement {
  return (
    <section
      data-testid="mock-data-delete-slot"
      className="rounded-md border border-dashed border-sailcloth/40 p-4 text-sm text-deep-charcoal/60"
    >
      Delete-all controls will render here (S5).
    </section>
  );
}

export default function MockData({ fetchers }: Props = {}): React.ReactElement {
  if (typeof document !== 'undefined' && document.title !== PAGE_TITLE) {
    document.title = PAGE_TITLE;
  }

  const effectiveFetchers = useMemo(
    () => ({
      listConnections:
        fetchers?.listConnections ?? (() => apiClient.get<ConnectionsListResponse>(CONNECTIONS_LIST_PATH)),
      stripeStatus:
        fetchers?.stripeStatus ?? (() => apiClient.get<ConnectionStatusResponse>(STRIPE_STATUS_PATH)),
      stripeSnapshot:
        fetchers?.stripeSnapshot ?? (() => apiClient.get<SnapshotResponse>(STRIPE_SNAPSHOT_PATH)),
    }),
    [fetchers],
  );

  const [connections, setConnections] = useState<ConnectionListItem[] | null>(null);
  const [selectedConnection, setSelectedConnection] = useState<string>('stripe');
  const [mode, setMode] = useState<Mode | null>(null);
  const [snapshot, setSnapshot] = useState<SeedSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshSnapshot = useCallback(async () => {
    try {
      const res = await effectiveFetchers.stripeSnapshot();
      setSnapshot(res.counts);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [effectiveFetchers]);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [list, status] = await Promise.all([
          effectiveFetchers.listConnections(),
          effectiveFetchers.stripeStatus(),
        ]);
        if (cancelled) return;
        setConnections(list.connections);
        setMode(status.mode);
        // Snapshot loads unconditionally — safe in either mode.
        const snap = await effectiveFetchers.stripeSnapshot();
        if (cancelled) return;
        setSnapshot(snap.counts);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [effectiveFetchers]);

  if (error && !mode) {
    return (
      <div
        id="main-content"
        data-testid="mock-data-page"
        className="flex flex-col gap-4"
      >
        <h1 className="font-heading text-2xl text-primary-navy">Mock Data</h1>
        <p role="alert" className="text-danger">
          Failed to load Mock Data panel: {error}
        </p>
      </div>
    );
  }

  if (!mode || !snapshot) {
    return (
      <div
        id="main-content"
        data-testid="mock-data-page"
        className="flex flex-col gap-4"
      >
        <h1 className="font-heading text-2xl text-primary-navy">Mock Data</h1>
        <p className="font-body text-sm text-deep-charcoal/70">Loading Mock Data panel…</p>
      </div>
    );
  }

  const disabled = mode === 'live';

  return (
    <div
      id="main-content"
      data-testid="mock-data-page"
      data-connection-mode={mode}
      className="flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-primary-navy">Mock Data</h1>
        <p className="font-body text-sm text-deep-charcoal/70">
          Prompt-driven and preset seeding for the mock store, plus a delete-all control.
          Available while the selected connection is in MOCK mode; the LIVE-mode
          disable is a UI reflection — the backend mock-only guard is the real check.
        </p>
      </header>

      {/* Connection picker — future-proofed but Stripe-only in v1. */}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-body text-deep-charcoal/70">Connection</span>
        <select
          data-testid="mock-data-connection-picker"
          value={selectedConnection}
          onChange={(e) => setSelectedConnection(e.target.value)}
          className="w-64 rounded-md border border-sailcloth/50 px-3 py-2"
        >
          {(connections ?? []).map((c) => (
            <option key={c.name} value={c.name} disabled={c.name !== 'stripe'}>
              {c.name} — {c.mode}
              {c.name !== 'stripe' ? ' (seeding not implemented yet)' : ''}
            </option>
          ))}
        </select>
      </label>

      {disabled ? (
        <section
          role="alert"
          data-testid="mock-data-live-disabled"
          className="rounded-md border border-amber-400 bg-amber-50 p-4 text-sm text-amber-900"
        >
          Seeding is unavailable while Stripe is in LIVE mode. Flip the connection to
          MOCK in Connections to enable.
        </section>
      ) : (
        <>
          <section data-testid="mock-data-snapshot" aria-label="Mock store snapshot">
            <h2 className="mb-2 font-heading text-lg text-primary-navy">Current mock store</h2>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {Object.entries(snapshot).map(([facet, count]) => (
                <li
                  key={facet}
                  data-testid={`mock-data-snapshot-${facet}`}
                  className="rounded-md border border-sailcloth/30 bg-white px-3 py-2"
                >
                  <div className="text-xs uppercase tracking-wide text-deep-charcoal/60">{facet}</div>
                  <div className="text-lg font-semibold text-primary-navy">{count}</div>
                </li>
              ))}
            </ul>
          </section>

          <SeedControlsSlot snapshot={snapshot} refresh={() => void refreshSnapshot()} />
          <DeleteAllControlsSlot snapshot={snapshot} refresh={() => void refreshSnapshot()} />
        </>
      )}
    </div>
  );
}

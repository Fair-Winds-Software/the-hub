// Authorized by HUB-1795 (S6 of HUB-1783) — Connections admin panel. Lists every
// registered external connection from GET /api/v1/admin/connections and renders a
// <ConnectionStatus name={c.name} /> card per row. New connections registered on the
// backend appear automatically on the next 30s poll (or immediate refetch after a
// mode flip, see ConnectionStatus.onSuccess).
//
// This panel is intentionally boring: the interesting behavior (3-state indicator,
// mode toggle, poll, down-streak banner) lives inside <ConnectionStatus />. This
// route just fetches the list and lays them out.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../lib/api';
import { ConnectionStatus } from '../components/ConnectionStatus';

const PAGE_TITLE = 'Connections | HUB Console';
const LIST_PATH = '/api/v1/admin/connections';

interface RegisteredConnection {
  name: string;
  mode: 'live' | 'mock';
}

interface ListResponse {
  connections: RegisteredConnection[];
}

interface Props {
  /** For test injection — production usage relies on the default apiClient GET. */
  listFetcher?: () => Promise<ListResponse>;
}

export default function Connections({ listFetcher }: Props = {}): React.ReactElement {
  if (typeof document !== 'undefined' && document.title !== PAGE_TITLE) {
    document.title = PAGE_TITLE;
  }

  const effectiveFetcher = useMemo(
    () => listFetcher ?? (() => apiClient.get<ListResponse>(LIST_PATH)),
    [listFetcher],
  );

  const [connections, setConnections] = useState<RegisteredConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const next = await effectiveFetcher();
      setConnections(next.connections);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [effectiveFetcher]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  if (error && !connections) {
    return (
      <div
        id="main-content"
        data-testid="connections-page"
        className="flex flex-col gap-4"
      >
        <h1
          data-testid="connections-heading"
          className="font-heading text-2xl text-primary-navy"
        >
          Connections
        </h1>
        <p role="alert" className="text-danger">
          Failed to load connections: {error}
        </p>
      </div>
    );
  }

  if (!connections) {
    return (
      <div
        id="main-content"
        data-testid="connections-page"
        className="flex flex-col gap-4"
      >
        <h1
          data-testid="connections-heading"
          className="font-heading text-2xl text-primary-navy"
        >
          Connections
        </h1>
        <p className="font-body text-sm text-deep-charcoal/70">
          Loading connections…
        </p>
      </div>
    );
  }

  return (
    <div
      id="main-content"
      data-testid="connections-page"
      className="flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1
          data-testid="connections-heading"
          className="font-heading text-2xl text-primary-navy"
        >
          Connections
        </h1>
        <p className="font-body text-sm text-deep-charcoal/70">
          External-app integrations. Toggle mode per connection; the indicator
          reflects live health when running in LIVE mode.
        </p>
      </header>

      {connections.length === 0 ? (
        <p
          data-testid="connections-empty"
          className="font-body text-sm text-deep-charcoal/70"
        >
          No connections are registered yet.
        </p>
      ) : (
        <ul
          data-testid="connections-list"
          className="flex flex-col gap-3"
          aria-label="Registered connections"
        >
          {connections.map((c) => (
            <li
              key={c.name}
              data-testid={`connections-item-${c.name}`}
              className="rounded-md border border-sailcloth/30 bg-white px-4 py-3"
            >
              <ConnectionStatus name={c.name} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

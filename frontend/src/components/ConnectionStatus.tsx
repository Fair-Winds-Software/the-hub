// Authorized by HUB-1782 (S9 of HUB-1773) — 3-state connection status indicator + mode
// toggle. Distinguishes states by SHAPE (accessibility) not color alone:
//   LIVE + ok       → solid filled dot        (green)
//   MOCK            → dashed outlined dot     (gray)
//   LIVE + degraded → warning triangle        (amber)
//   LIVE + down     → warning triangle        (red)
// Authorized by HUB-1795 (S6 of HUB-1783) — generalized from StripeConnectionStatus to
// ConnectionStatus + `name` prop. Backend routes are the generic /connections/:name/*
// endpoints from HUB-1793 (S4). Same 3 visual states, same ARIA labels (label prefix is
// derived from `label` prop with a Title-Case fallback of `name`), same 30s poll, same
// 2-consecutive-down banner.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../lib/api';

const POLL_INTERVAL_MS = 30_000;

export type Mode = 'live' | 'mock';
export type Health = 'ok' | 'degraded' | 'down';

export interface ConnectionStatusPayload {
  name: string;
  mode: Mode;
  health: Health;
  reason?: string;
  checked_at: string;
  latency_ms: number;
}

interface Props {
  /** Registered connection name (matches the backend route param, e.g. 'stripe', 'ga'). */
  name: string;
  /** Human-facing label. Defaults to Title-Case of `name`. */
  label?: string;
  /** For test injection — production usage should omit and rely on the default fetcher. */
  fetcher?: () => Promise<ConnectionStatusPayload>;
  /** For test injection — production usage relies on the default apiClient PUT. */
  onFlip?: (mode: Mode) => Promise<void>;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Shape components ────────────────────────────────────────────────────────────
// Rendered as inline SVG so shape is intrinsic to the DOM rather than color/background.

function SolidDot() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="5" fill="#22c55e" stroke="#166534" strokeWidth="1" />
    </svg>
  );
}

function DashedDot() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="5" fill="none" stroke="#6b7280" strokeWidth="1.5" strokeDasharray="2,1.5" />
    </svg>
  );
}

function WarningTriangle({ variant }: { variant: 'degraded' | 'down' }) {
  const fill = variant === 'degraded' ? '#f59e0b' : '#ef4444';
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 1 L13 12 L1 12 Z" fill={fill} stroke="#7f1d1d" strokeWidth="0.75" />
      <path d="M7 5 L7 9" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7" cy="10.5" r="0.75" fill="white" />
    </svg>
  );
}

// ── Indicator ───────────────────────────────────────────────────────────────────

interface IndicatorProps {
  status: ConnectionStatusPayload;
  label: string;
}
function StatusIndicator({ status, label }: IndicatorProps) {
  let shape: React.ReactNode;
  let aria: string;
  if (status.mode === 'mock') {
    shape = <DashedDot />;
    aria = `${label}: mock`;
  } else if (status.health === 'ok') {
    shape = <SolidDot />;
    aria = `${label}: live, healthy`;
  } else {
    shape = <WarningTriangle variant={status.health} />;
    aria = `${label}: live, ${status.health}${status.reason ? ` — ${status.reason}` : ''}`;
  }
  return (
    <span
      role="status"
      aria-label={aria}
      title={status.reason && status.health !== 'ok' ? status.reason : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '13px',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {shape}
      <span>{label}: {status.mode === 'mock' ? 'mock' : `live · ${status.health}`}</span>
    </span>
  );
}

// ── Mode toggle ─────────────────────────────────────────────────────────────────

interface ToggleProps {
  label: string;
  currentMode: Mode;
  onFlip: (mode: Mode) => Promise<void>;
  onSuccess: () => void;
  disabled?: boolean;
}
function ModeToggle({ label, currentMode, onFlip, onSuccess, disabled }: ToggleProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const flip = useCallback(
    async (target: Mode) => {
      if (target === currentMode || busy || disabled) return;
      setBusy(true);
      setErr(null);
      try {
        await onFlip(target);
        onSuccess();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [currentMode, busy, disabled, onFlip, onSuccess],
  );
  const buttonStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px',
    fontSize: '12px',
    background: active ? '#111827' : '#ffffff',
    color: active ? '#ffffff' : '#111827',
    border: '1px solid #d1d5db',
    borderRadius: 0,
    cursor: busy || disabled ? 'not-allowed' : 'pointer',
    opacity: busy || disabled ? 0.6 : 1,
  });
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
      <span role="group" aria-label={`${label} connection mode`}>
        <button
          type="button"
          onClick={() => void flip('live')}
          aria-pressed={currentMode === 'live'}
          disabled={busy || disabled}
          style={{ ...buttonStyle(currentMode === 'live'), borderTopLeftRadius: 4, borderBottomLeftRadius: 4 }}
        >
          LIVE
        </button>
        <button
          type="button"
          onClick={() => void flip('mock')}
          aria-pressed={currentMode === 'mock'}
          disabled={busy || disabled}
          style={{ ...buttonStyle(currentMode === 'mock'), borderTopRightRadius: 4, borderBottomRightRadius: 4, borderLeft: 'none' }}
        >
          MOCK
        </button>
      </span>
      {err && <span role="alert" style={{ fontSize: '12px', color: '#ef4444' }}>{err}</span>}
    </span>
  );
}

// ── ConnectionStatus ────────────────────────────────────────────────────────────

export function ConnectionStatus(props: Props) {
  const { name, fetcher, onFlip } = props;
  const label = props.label ?? titleCase(name);

  const defaultFetcher = useCallback(
    (): Promise<ConnectionStatusPayload> => apiClient.get<ConnectionStatusPayload>(`/api/v1/admin/connections/${name}/status`),
    [name],
  );
  const defaultFlip = useCallback(
    async (mode: Mode): Promise<void> => {
      await apiClient.put<{ mode: Mode }>(`/api/v1/admin/connections/${name}/mode`, { mode });
    },
    [name],
  );

  const effectiveFetcher = fetcher ?? defaultFetcher;
  const effectiveFlip = onFlip ?? defaultFlip;

  const [status, setStatus] = useState<ConnectionStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downStreak, setDownStreak] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refetch = useCallback(async () => {
    try {
      const next = await effectiveFetcher();
      setStatus(next);
      setError(null);
      setDownStreak((n) => (next.mode === 'live' && next.health === 'down' ? n + 1 : 0));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [effectiveFetcher]);

  useEffect(() => {
    void refetch();
    intervalRef.current = setInterval(() => {
      void refetch();
    }, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refetch]);

  if (error && !status) {
    return (
      <span role="alert" style={{ color: '#ef4444', fontSize: '12px' }}>
        {label} status unavailable: {error}
      </span>
    );
  }
  if (!status) {
    return <span style={{ color: '#6b7280', fontSize: '12px' }}>Loading {label} status…</span>;
  }

  const banner = downStreak >= 2 && status.mode === 'live' && status.health === 'down' ? (
    <div
      role="alert"
      style={{
        background: '#fef2f2',
        border: '1px solid #ef4444',
        color: '#7f1d1d',
        padding: '6px 10px',
        fontSize: '13px',
        marginBottom: '8px',
      }}
    >
      {label} LIVE connection is down: {status.reason ?? 'unknown reason'}
    </div>
  ) : null;

  return (
    <div style={{ display: 'inline-block' }}>
      {banner}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <StatusIndicator status={status} label={label} />
        <ModeToggle label={label} currentMode={status.mode} onFlip={effectiveFlip} onSuccess={() => void refetch()} />
      </div>
    </div>
  );
}

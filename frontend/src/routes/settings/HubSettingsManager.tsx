// Authorized by HUB-1664 (E-FE-6 S5) — HUB Settings editor at
// /console/settings/hub. Fetches every stored setting via GET
// /api/v1/admin/settings, groups them by 'known catalog key' vs 'unknown
// key', renders a type-aware control per known key (number / boolean /
// string / JSON) and a raw JSON textarea for unknown keys per FR-011.
// Save issues PUT /api/v1/admin/settings with { key, value }; the BE
// validates known-key types (HUB-1660) and passes unknown keys through.
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. FE catalog mirror: no BE endpoint exposes the shared catalog so
//      the FE at src/lib/settingsCatalog.ts mirrors the BE v0.1 list by
//      hand. HUB-1545 tech debt candidate: expose the BE catalog at
//      /api/v1/admin/settings/catalog so the FE fetches instead of
//      mirroring.
//
//   2. 'Recent changes to this setting' mini-feed omitted: the existing
//      audit-log GET endpoint accepts entity_types[] but has no
//      entity_key filter (operatorConsoleService.getAuditLog params), so
//      per-key filtering isn't possible without a BE extension. Story's
//      rollback UX intent partially preserved via inline error surfacing;
//      full mini-feed is HUB-1545 tech debt.
//
//   3. Toast + audit-log deep-link: HUB-1616's audit explorer already
//      accepts ?eventId=<id>; but the PUT response does not surface the
//      audit event id (writeAuditEntry is fire-and-forget). Toast
//      confirms the save without the deep-link; documented as HUB-1545
//      tech debt.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../../lib/api';
import {
  getCatalogEntry,
  SETTINGS_CATALOG,
  type SettingsCatalogEntry,
  type SettingsValueType,
} from '../../lib/settingsCatalog';

const SETTINGS_PATH = '/api/v1/admin/settings';
const PAGE_TITLE = 'HUB Settings | Settings | HUB Console';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

interface SettingsResponse {
  settings: Record<string, JsonValue>;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; values: Record<string, JsonValue> };

interface EditorState {
  key: string;
  entry: SettingsCatalogEntry | undefined;
  raw: string;
  serverValue: JsonValue | undefined;
  dirty: boolean;
  saving: boolean;
  saveMessage: string | null;
  errorMessage: string | null;
}

function stringifyForEditor(value: unknown, type: SettingsValueType | 'unknown'): string {
  if (value === undefined) return '';
  if (type === 'json' || type === 'unknown') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '';
    }
  }
  if (type === 'boolean') return value === true ? 'true' : 'false';
  return String(value);
}

function parseFromEditor(
  raw: string,
  type: SettingsValueType | 'unknown',
): { ok: true; value: JsonValue } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (type === 'boolean') {
    if (trimmed === 'true') return { ok: true, value: true };
    if (trimmed === 'false') return { ok: true, value: false };
    return { ok: false, error: 'Value must be true or false.' };
  }
  if (type === 'number') {
    if (trimmed.length === 0) return { ok: false, error: 'Value is required.' };
    const n = Number(trimmed);
    if (Number.isNaN(n)) return { ok: false, error: 'Value must be a number.' };
    return { ok: true, value: n };
  }
  if (type === 'string') {
    return { ok: true, value: trimmed };
  }
  // json + unknown → JSON.parse
  if (trimmed.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(trimmed) as JsonValue };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid JSON';
    return { ok: false, error: `Invalid JSON: ${message}` };
  }
}

interface KeyEditorProps {
  state: EditorState;
  onRawChange: (raw: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}

function KeyEditor({ state, onRawChange, onSave, onDiscard }: KeyEditorProps): React.ReactElement {
  const type: SettingsValueType | 'unknown' = state.entry?.type ?? 'unknown';
  const isKnown = !!state.entry;

  return (
    <li
      data-testid={`hub-settings-row-${state.key}`}
      className="flex flex-col gap-2 rounded-md border border-deep-charcoal/15 bg-sailcloth p-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <label
            htmlFor={`hub-settings-input-${state.key}`}
            className="font-heading text-base text-primary-navy"
          >
            {state.key}
          </label>
          {state.entry ? (
            <p
              data-testid={`hub-settings-help-${state.key}`}
              className="text-xs font-body text-deep-charcoal/60"
            >
              {state.entry.description}
            </p>
          ) : (
            <p
              data-testid={`hub-settings-help-unknown-${state.key}`}
              className="text-xs font-body text-accent-brass"
            >
              Unknown key — edit as raw JSON. Add a catalog entry to unlock
              type-aware editing.
            </p>
          )}
        </div>
        <span
          data-testid={`hub-settings-type-${state.key}`}
          className="inline-flex items-center rounded-full bg-deep-charcoal/10 px-2 py-0.5 text-xs font-body text-deep-charcoal/70"
        >
          {isKnown ? type : 'unknown'}
        </span>
      </div>

      {type === 'boolean' ? (
        <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
          <input
            id={`hub-settings-input-${state.key}`}
            data-testid={`hub-settings-input-${state.key}`}
            type="checkbox"
            checked={state.raw === 'true'}
            onChange={(e) => onRawChange(e.target.checked ? 'true' : 'false')}
          />
          {state.raw === 'true' ? 'true' : 'false'}
        </label>
      ) : type === 'number' ? (
        <input
          id={`hub-settings-input-${state.key}`}
          data-testid={`hub-settings-input-${state.key}`}
          type="number"
          step="any"
          value={state.raw}
          onChange={(e) => onRawChange(e.target.value)}
          className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
        />
      ) : type === 'string' ? (
        <input
          id={`hub-settings-input-${state.key}`}
          data-testid={`hub-settings-input-${state.key}`}
          type="text"
          value={state.raw}
          onChange={(e) => onRawChange(e.target.value)}
          className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
        />
      ) : (
        <textarea
          id={`hub-settings-input-${state.key}`}
          data-testid={`hub-settings-input-${state.key}`}
          value={state.raw}
          rows={6}
          onChange={(e) => onRawChange(e.target.value)}
          className="rounded border border-deep-charcoal/20 p-2 font-mono text-xs text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
        />
      )}

      {state.errorMessage && (
        <p
          data-testid={`hub-settings-error-${state.key}`}
          className="text-xs text-ironwake"
        >
          {state.errorMessage}
        </p>
      )}

      {state.saveMessage && (
        <p
          role="status"
          data-testid={`hub-settings-save-message-${state.key}`}
          className="text-xs text-seafoam"
        >
          {state.saveMessage}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`hub-settings-save-${state.key}`}
          onClick={onSave}
          disabled={!state.dirty || state.saving}
          className="rounded bg-primary-navy px-3 py-1 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          {state.saving ? 'Saving…' : 'Save'}
        </button>
        {state.dirty && (
          <button
            type="button"
            data-testid={`hub-settings-discard-${state.key}`}
            onClick={onDiscard}
            className="rounded border border-deep-charcoal/20 px-3 py-1 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Discard
          </button>
        )}
      </div>
    </li>
  );
}

export default function HubSettingsManager(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [editors, setEditors] = useState<Record<string, EditorState>>({});

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const seedEditors = useCallback(
    (serverValues: Record<string, JsonValue>) => {
      // Union of known catalog keys + keys returned by the server. Known
      // keys that the server has never stored still render with their
      // catalog default so the operator can 'save' the default to seed.
      const keys = new Set<string>(SETTINGS_CATALOG.map((e) => e.key));
      for (const k of Object.keys(serverValues)) keys.add(k);
      const next: Record<string, EditorState> = {};
      for (const key of keys) {
        const entry = getCatalogEntry(key);
        const serverValue = serverValues[key];
        const initial =
          serverValue !== undefined
            ? serverValue
            : entry
              ? (entry.default as JsonValue)
              : undefined;
        next[key] = {
          key,
          entry,
          raw: stringifyForEditor(initial, entry?.type ?? 'unknown'),
          serverValue,
          dirty: false,
          saving: false,
          saveMessage: null,
          errorMessage: null,
        };
      }
      setEditors(next);
    },
    [],
  );

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const res = await apiClient.get<SettingsResponse>(SETTINGS_PATH);
      const values = res.settings ?? {};
      seedEditors(values);
      setState({ kind: 'ready', values });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load settings';
      setState({ kind: 'error', message });
    }
  }, [seedEditors]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchEditor = useCallback(
    (key: string, patch: Partial<EditorState>) => {
      setEditors((prev) => {
        if (!prev[key]) return prev;
        return { ...prev, [key]: { ...prev[key], ...patch } };
      });
    },
    [],
  );

  const handleRawChange = useCallback(
    (key: string, raw: string) => {
      patchEditor(key, {
        raw,
        dirty: true,
        errorMessage: null,
        saveMessage: null,
      });
    },
    [patchEditor],
  );

  const handleSave = useCallback(
    async (key: string): Promise<void> => {
      const editor = editors[key];
      if (!editor) return;
      const parsed = parseFromEditor(
        editor.raw,
        editor.entry?.type ?? 'unknown',
      );
      if (!parsed.ok) {
        patchEditor(key, { errorMessage: parsed.error });
        return;
      }
      patchEditor(key, {
        saving: true,
        errorMessage: null,
        saveMessage: null,
      });
      try {
        await apiClient.put(SETTINGS_PATH, { key, value: parsed.value });
        patchEditor(key, {
          saving: false,
          dirty: false,
          serverValue: parsed.value,
          saveMessage: `${key} updated.`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Save failed.';
        patchEditor(key, { saving: false, errorMessage: message });
      }
    },
    [editors, patchEditor],
  );

  const handleDiscard = useCallback(
    (key: string) => {
      const editor = editors[key];
      if (!editor) return;
      const initial =
        editor.serverValue !== undefined
          ? editor.serverValue
          : editor.entry
            ? (editor.entry.default as JsonValue)
            : undefined;
      patchEditor(key, {
        raw: stringifyForEditor(initial, editor.entry?.type ?? 'unknown'),
        dirty: false,
        errorMessage: null,
        saveMessage: null,
      });
    },
    [editors, patchEditor],
  );

  const sortedKeys = useMemo(
    () =>
      Object.keys(editors).sort((a, b) => {
        const aKnown = !!editors[a]!.entry;
        const bKnown = !!editors[b]!.entry;
        if (aKnown !== bKnown) return aKnown ? -1 : 1;
        return a.localeCompare(b);
      }),
    [editors],
  );

  if (state.kind === 'loading') {
    return (
      <div id="main-content" data-testid="hub-settings-page">
        <div
          data-testid="hub-settings-skeleton"
          className="h-32 animate-pulse rounded-md bg-deep-charcoal/5"
        />
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div
        id="main-content"
        role="alert"
        data-testid="hub-settings-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load HUB settings.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="hub-settings-retry"
          onClick={() => void load()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div id="main-content" data-testid="hub-settings-page" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-primary-navy">HUB Settings</h1>
        <p className="text-sm font-body text-deep-charcoal/70">
          Well-known HUB configuration. Known keys render type-aware controls;
          unknown keys fall back to a raw JSON textarea.
        </p>
      </header>
      <ul data-testid="hub-settings-list" className="flex flex-col gap-3">
        {sortedKeys.map((key) => (
          <KeyEditor
            key={key}
            state={editors[key]!}
            onRawChange={(raw) => handleRawChange(key, raw)}
            onSave={() => void handleSave(key)}
            onDiscard={() => handleDiscard(key)}
          />
        ))}
      </ul>
    </div>
  );
}

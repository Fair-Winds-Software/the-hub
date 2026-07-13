// Authorized by HUB-1800 (S4 of HUB-1784) — SeedControls slot for the MockData admin panel.
// Two tabs (Prompt / Preset), Add-vs-Replace radio, submit → POST /seed/prompt or
// /seed/preset. On success renders per-facet counts; on 400 with validation errors,
// renders the error message inline. Replace mode + non-empty snapshot triggers a
// ConfirmDestructive gate before the request fires.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../../lib/api';
import { ConfirmDestructive } from '../../components/ConfirmDestructive';

const PROMPT_PATH = '/api/v1/admin/connections/stripe/seed/prompt';
const PRESET_PATH = '/api/v1/admin/connections/stripe/seed/preset';
const PRESETS_LIST_PATH = '/api/v1/admin/connections/stripe/seed/presets';

const PROMPT_MAX = 4000;
const PROMPT_PLACEHOLDER =
  'Example: 500 customers, 30% with an active discount, mix of active and past_due subscriptions.';

type Mode = 'add' | 'replace';
type Tab = 'prompt' | 'preset';

interface Preset {
  id: string;
  label: string;
  description: string;
}

interface PresetsListResponse {
  presets: Preset[];
}

interface SeedResult {
  plan_summary: Record<string, number>;
  errors: Array<{ facet: string; index: number; message: string }>;
}

export interface SeedControlsProps {
  /** Current mock-store snapshot from the parent (S3 shell). */
  snapshot: Record<string, number>;
  /** Callback the parent supplies so the panel refreshes counts post-seed. */
  refresh: () => void;
  /** For tests — override the presets fetcher. */
  presetsFetcher?: () => Promise<PresetsListResponse>;
  /** For tests — override the prompt-seed POST. */
  onPromptSeed?: (body: { prompt: string; mode: Mode }) => Promise<SeedResult>;
  /** For tests — override the preset-seed POST. */
  onPresetSeed?: (body: { preset_id: string; mode: Mode }) => Promise<SeedResult>;
}

function snapshotIsEmpty(s: Record<string, number>): boolean {
  return Object.values(s).every((n) => n === 0);
}

export function SeedControls({
  snapshot,
  refresh,
  presetsFetcher,
  onPromptSeed,
  onPresetSeed,
}: SeedControlsProps): React.ReactElement {
  const effective = useMemo(
    () => ({
      presets: presetsFetcher ?? (() => apiClient.get<PresetsListResponse>(PRESETS_LIST_PATH)),
      prompt:
        onPromptSeed ??
        ((body: { prompt: string; mode: Mode }) => apiClient.post<SeedResult>(PROMPT_PATH, body)),
      preset:
        onPresetSeed ??
        ((body: { preset_id: string; mode: Mode }) => apiClient.post<SeedResult>(PRESET_PATH, body)),
    }),
    [presetsFetcher, onPromptSeed, onPresetSeed],
  );

  const [tab, setTab] = useState<Tab>('prompt');
  const [mode, setMode] = useState<Mode>('add');
  const [prompt, setPrompt] = useState('');
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SeedResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await effective.presets();
        if (cancelled) return;
        setPresets(res.presets);
        setSelectedPresetId((prev) => prev || res.presets[0]?.id || '');
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effective]);

  const runRequest = useCallback(async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const res =
        tab === 'prompt'
          ? await effective.prompt({ prompt: prompt.trim(), mode })
          : await effective.preset({ preset_id: selectedPresetId, mode });
      setResult(res);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [tab, effective, prompt, mode, selectedPresetId, refresh]);

  const requiresReplaceConfirm = mode === 'replace' && !snapshotIsEmpty(snapshot);
  const canSubmit =
    !busy &&
    ((tab === 'prompt' && prompt.trim().length >= 5) ||
      (tab === 'preset' && selectedPresetId.length > 0));

  const tabClass = (active: boolean): string =>
    `px-3 py-1.5 text-sm border-b-2 ${
      active
        ? 'border-primary-navy text-primary-navy font-semibold'
        : 'border-transparent text-deep-charcoal/60 hover:text-primary-navy'
    }`;

  const selectedPreset = presets?.find((p) => p.id === selectedPresetId) ?? null;

  return (
    <section
      data-testid="mock-data-seed-controls"
      aria-label="Seed mock data"
      className="rounded-md border border-sailcloth/40 bg-white p-4"
    >
      <h2 className="mb-3 font-heading text-lg text-primary-navy">Seed mock data</h2>

      <div role="tablist" className="mb-3 flex gap-2 border-b border-sailcloth/30">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'prompt'}
          data-testid="seed-tab-prompt"
          className={tabClass(tab === 'prompt')}
          onClick={() => setTab('prompt')}
        >
          Prompt
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'preset'}
          data-testid="seed-tab-preset"
          className={tabClass(tab === 'preset')}
          onClick={() => setTab('preset')}
        >
          Preset
        </button>
      </div>

      {tab === 'prompt' ? (
        <label className="flex flex-col gap-1">
          <span className="text-sm text-deep-charcoal/70">Describe what to seed</span>
          <textarea
            data-testid="seed-prompt-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, PROMPT_MAX))}
            placeholder={PROMPT_PLACEHOLDER}
            rows={4}
            className="rounded-md border border-sailcloth/50 px-3 py-2 font-body text-sm"
          />
          <span className="text-xs text-deep-charcoal/50" data-testid="seed-prompt-counter">
            {prompt.length} / {PROMPT_MAX}
          </span>
        </label>
      ) : (
        <label className="flex flex-col gap-1">
          <span className="text-sm text-deep-charcoal/70">Preset</span>
          <select
            data-testid="seed-preset-picker"
            value={selectedPresetId}
            onChange={(e) => setSelectedPresetId(e.target.value)}
            className="rounded-md border border-sailcloth/50 px-3 py-2"
          >
            {(presets ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {selectedPreset ? (
            <span data-testid="seed-preset-description" className="text-xs text-deep-charcoal/60">
              {selectedPreset.description}
            </span>
          ) : null}
        </label>
      )}

      <fieldset className="mt-3">
        <legend className="text-sm text-deep-charcoal/70">Mode</legend>
        <label className="mr-4 inline-flex items-center gap-1 text-sm">
          <input
            type="radio"
            name="seed-mode"
            value="add"
            checked={mode === 'add'}
            onChange={() => setMode('add')}
            data-testid="seed-mode-add"
          />
          Add to existing
        </label>
        <label className="inline-flex items-center gap-1 text-sm">
          <input
            type="radio"
            name="seed-mode"
            value="replace"
            checked={mode === 'replace'}
            onChange={() => setMode('replace')}
            data-testid="seed-mode-replace"
          />
          Replace (wipe first)
        </label>
      </fieldset>

      <div className="mt-3">
        {requiresReplaceConfirm ? (
          <ConfirmDestructive
            title="Replace mock data?"
            body="Replace mode wipes existing mock rows first, then seeds. This cannot be undone."
            confirmLabel="Yes, replace and seed"
            onConfirm={runRequest}
            trigger={(open) => (
              <button
                type="button"
                disabled={!canSubmit}
                data-testid="seed-submit"
                onClick={open}
                className="rounded-md bg-primary-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                Seed
              </button>
            )}
          />
        ) : (
          <button
            type="button"
            disabled={!canSubmit}
            data-testid="seed-submit"
            onClick={() => void runRequest()}
            className="rounded-md bg-primary-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'Seeding…' : 'Seed'}
          </button>
        )}
      </div>

      <div aria-live="polite" className="mt-3">
        {result ? (
          <div data-testid="seed-result" className="rounded-md border border-emerald-400 bg-emerald-50 p-3 text-sm text-emerald-900">
            <p className="mb-2 font-semibold">Seeded successfully.</p>
            <ul className="grid grid-cols-2 gap-1 sm:grid-cols-4">
              {Object.entries(result.plan_summary).map(([facet, count]) => (
                <li key={facet} data-testid={`seed-result-${facet}`}>
                  {facet}: <span className="font-semibold">{count}</span>
                </li>
              ))}
            </ul>
            {result.errors.length > 0 ? (
              <ul data-testid="seed-result-errors" className="mt-2 list-disc pl-4 text-xs text-red-800">
                {result.errors.map((err, i) => (
                  <li key={`${err.facet}-${err.index}-${i}`}>
                    <strong>{err.facet}</strong> [row {err.index}]: {err.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p role="alert" data-testid="seed-error" className="rounded-md border border-red-400 bg-red-50 p-3 text-sm text-red-900">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

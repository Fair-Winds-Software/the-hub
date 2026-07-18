// CopyablePromptPanel — sits inside the credential-reveal blocks (Register + Rotate).
// Consumer supplies (productId, clientId, clientSecret). Operator picks retrofit vs
// greenfield, then this component fetches the Claude Code prompt from
// POST /admin/onboarding/:productId/prompt, verifies the server-supplied SHA-256
// checksum matches a client-side re-hash of the received bytes (defense-in-depth
// against network tampering), renders the prompt in a readonly textarea, and offers
// a Copy button.
//
// codebase_state selector (retrofit | greenfield) is per HUB integration docs at
// docs/hub-integration/{RETROFIT,GREENFIELD}.md — the backend picks the right
// template. Toggling the choice clears the previously-fetched prompt so the
// operator sees they need to refetch.
//
// Checksum verification is optional-strict: mismatch → do NOT render the prompt;
// show an error banner instead.
import { useCallback, useMemo, useState } from 'react';
import { apiClient } from '../../lib/api';
import { useToastStore } from '../../stores/toastStore';

type CodebaseState = 'greenfield' | 'retrofit';

interface PromptResult {
  prompt: string;
  checksum: string;
  codebase_state?: CodebaseState;
}

interface FetchBody {
  client_id: string;
  client_secret: string;
  hub_url?: string;
  codebase_state: CodebaseState;
}

interface Props {
  productId: string;
  clientId: string;
  clientSecret: string;
  hubUrl?: string;
  /** Test injection — override the fetcher to skip network. */
  fetcher?: (body: FetchBody) => Promise<PromptResult>;
  /** Test injection — override navigator.clipboard.writeText. */
  copyToClipboard?: (text: string) => Promise<void>;
}

async function sha256Hex(input: string): Promise<string | null> {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') return null;
  const enc = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function CopyablePromptPanel({
  productId,
  clientId,
  clientSecret,
  hubUrl,
  fetcher,
  copyToClipboard,
}: Props): React.ReactElement {
  const addToast = useToastStore((s) => s.addToast);

  const effectiveFetcher = useMemo(
    () =>
      fetcher ??
      ((body: FetchBody) =>
        apiClient.post<PromptResult>(
          `/api/v1/admin/onboarding/${productId}/prompt`,
          body,
        )),
    [fetcher, productId],
  );

  const effectiveCopy = useMemo(
    () =>
      copyToClipboard ??
      (async (text: string) => {
        if (typeof navigator === 'undefined' || !navigator.clipboard) {
          throw new Error('clipboard API unavailable');
        }
        await navigator.clipboard.writeText(text);
      }),
    [copyToClipboard],
  );

  const [codebaseState, setCodebaseState] = useState<CodebaseState>('greenfield');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PromptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checksumOk, setChecksumOk] = useState<boolean | null>(null);

  const handleCodebaseChange = (next: CodebaseState): void => {
    setCodebaseState(next);
    // Clear stale prompt/error so the operator sees they need to refetch.
    setResult(null);
    setError(null);
    setChecksumOk(null);
  };

  const fetchPrompt = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setChecksumOk(null);
    try {
      const res = await effectiveFetcher({
        client_id: clientId,
        client_secret: clientSecret,
        ...(hubUrl ? { hub_url: hubUrl } : {}),
        codebase_state: codebaseState,
      });
      const clientHash = await sha256Hex(res.prompt);
      if (clientHash === null) {
        // crypto.subtle unavailable — degrade gracefully.
        // eslint-disable-next-line no-console
        console.warn('crypto.subtle unavailable — skipping checksum verification');
        setResult(res);
        setChecksumOk(null);
        return;
      }
      if (clientHash !== res.checksum) {
        setError(
          `Checksum mismatch: client=${clientHash.slice(0, 8)}… server=${res.checksum.slice(0, 8)}…`,
        );
        setChecksumOk(false);
        return;
      }
      setResult(res);
      setChecksumOk(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [effectiveFetcher, clientId, clientSecret, hubUrl, codebaseState]);

  const copy = useCallback(async () => {
    if (!result) return;
    try {
      await effectiveCopy(result.prompt);
      addToast({ variant: 'success', message: 'Prompt copied to clipboard.' });
    } catch (e) {
      setError(`Copy failed: ${(e as Error).message}`);
    }
  }, [effectiveCopy, result, addToast]);

  const renderedTemplate = result?.codebase_state ?? codebaseState;

  return (
    <section
      data-testid="onboarding-prompt-panel"
      aria-label="Claude Code onboarding prompt"
      className="mt-3 rounded-md border border-sailcloth/40 bg-white p-3"
    >
      <fieldset
        data-testid="onboarding-prompt-codebase-state"
        className="mb-3 flex flex-col gap-1 border-0 p-0"
      >
        <legend className="text-xs font-semibold text-deep-charcoal/70">
          Target codebase
        </legend>
        <div className="flex flex-wrap gap-3 text-xs">
          <label className="inline-flex items-center gap-1">
            <input
              type="radio"
              name={`codebase-state-${productId}`}
              value="greenfield"
              checked={codebaseState === 'greenfield'}
              onChange={() => handleCodebaseChange('greenfield')}
              data-testid="onboarding-prompt-codebase-greenfield"
            />
            <span>
              <strong>Greenfield</strong> — fresh LaunchKit scaffold
            </span>
          </label>
          <label className="inline-flex items-center gap-1">
            <input
              type="radio"
              name={`codebase-state-${productId}`}
              value="retrofit"
              checked={codebaseState === 'retrofit'}
              onChange={() => handleCodebaseChange('retrofit')}
              data-testid="onboarding-prompt-codebase-retrofit"
            />
            <span>
              <strong>Retrofit</strong> — existing codebase with hand-rolled code
            </span>
          </label>
        </div>
      </fieldset>

      {!result && !error ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-deep-charcoal/70">
            Get a copy-ready Claude Code prompt to scaffold the SDK integration in
            the target codebase.
          </p>
          <button
            type="button"
            data-testid="onboarding-prompt-fetch"
            disabled={busy}
            onClick={() => void fetchPrompt()}
            className="rounded-md border border-primary-navy px-3 py-1 text-xs font-semibold text-primary-navy disabled:opacity-50"
          >
            {busy ? 'Loading…' : 'Get Claude Code prompt'}
          </button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" data-testid="onboarding-prompt-error" className="text-sm text-red-800">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span
              data-testid="onboarding-prompt-checksum-status"
              className={`text-xs ${checksumOk ? 'text-emerald-700' : 'text-deep-charcoal/60'}`}
            >
              {checksumOk === true
                ? `✓ Checksum verified (${result.checksum.slice(0, 8)}…) · ${renderedTemplate}`
                : checksumOk === false
                  ? `✗ Checksum mismatch`
                  : `Checksum verification skipped · ${renderedTemplate}`}
            </span>
            <button
              type="button"
              data-testid="onboarding-prompt-copy"
              onClick={() => void copy()}
              className="rounded-md bg-primary-navy px-3 py-1 text-xs font-semibold text-white"
            >
              Copy to clipboard
            </button>
          </div>
          <textarea
            data-testid="onboarding-prompt-textarea"
            readOnly
            value={result.prompt}
            rows={10}
            className="w-full rounded-md border border-sailcloth/30 bg-sailcloth/10 p-2 font-mono text-xs"
          />
        </div>
      ) : null}
    </section>
  );
}

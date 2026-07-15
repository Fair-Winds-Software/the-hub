// Authorized by HUB-1823 (S6 of HUB-1787) — CopyablePromptPanel tests.
// Covers: fetch button → prompt render, checksum match rendering, checksum mismatch
// error path, copy-to-clipboard toast, fetch failure surfacing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CopyablePromptPanel } from '../CopyablePromptPanel';
import { useToastStore } from '../../../stores/toastStore';

const SAMPLE_PROMPT = '# Wire this codebase to HUB — ContentHelm\n\nHUB_CLIENT_ID=test\n';

async function computeSampleChecksum(text: string): Promise<string> {
  const enc = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

beforeEach(() => {
  useToastStore.getState().clearAll();
});

afterEach(() => {
  cleanup();
});

describe('CopyablePromptPanel — happy path', () => {
  it('fetches on button click, verifies checksum match, renders textarea', async () => {
    const goodChecksum = await computeSampleChecksum(SAMPLE_PROMPT);
    const fetcher = vi.fn().mockResolvedValue({ prompt: SAMPLE_PROMPT, checksum: goodChecksum });
    render(
      <CopyablePromptPanel
        productId="p-1"
        clientId="c-id"
        clientSecret="c-secret"
        fetcher={fetcher}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-prompt-fetch'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-prompt-textarea')).toBeInTheDocument();
    });
    expect(
      (screen.getByTestId('onboarding-prompt-textarea') as HTMLTextAreaElement).value,
    ).toBe(SAMPLE_PROMPT);
    expect(screen.getByTestId('onboarding-prompt-checksum-status').textContent).toContain(
      'Checksum verified',
    );
    expect(fetcher).toHaveBeenCalledWith({ client_id: 'c-id', client_secret: 'c-secret' });
  });

  it('copy button calls the copy function + fires success toast', async () => {
    const goodChecksum = await computeSampleChecksum(SAMPLE_PROMPT);
    const fetcher = vi.fn().mockResolvedValue({ prompt: SAMPLE_PROMPT, checksum: goodChecksum });
    const copyToClipboard = vi.fn().mockResolvedValue(undefined);
    render(
      <CopyablePromptPanel
        productId="p-1"
        clientId="c-id"
        clientSecret="c-secret"
        fetcher={fetcher}
        copyToClipboard={copyToClipboard}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-prompt-fetch'));
    });
    await waitFor(() => screen.getByTestId('onboarding-prompt-copy'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-prompt-copy'));
    });
    expect(copyToClipboard).toHaveBeenCalledWith(SAMPLE_PROMPT);
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.message.includes('copied'))).toBe(true);
  });
});

describe('CopyablePromptPanel — checksum mismatch', () => {
  it('does NOT render the textarea; shows a role=alert error', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      prompt: SAMPLE_PROMPT,
      checksum: 'x'.repeat(64), // wrong checksum
    });
    render(
      <CopyablePromptPanel
        productId="p-1"
        clientId="c-id"
        clientSecret="c-secret"
        fetcher={fetcher}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-prompt-fetch'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-prompt-error').textContent).toContain(
        'Checksum mismatch',
      );
    });
    expect(screen.queryByTestId('onboarding-prompt-textarea')).not.toBeInTheDocument();
  });
});

describe('CopyablePromptPanel — fetch failure', () => {
  it('surfaces backend error in role=alert; textarea not rendered', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('403 super_admin required'));
    render(
      <CopyablePromptPanel
        productId="p-1"
        clientId="c-id"
        clientSecret="c-secret"
        fetcher={fetcher}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-prompt-fetch'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-prompt-error').textContent).toContain(
        '403 super_admin required',
      );
    });
    expect(screen.queryByTestId('onboarding-prompt-textarea')).not.toBeInTheDocument();
  });
});

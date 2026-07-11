// Authorized by HUB-1797 (S1 of HUB-1784) — unit tests for the Anthropic LLM client.
// Uses vi.stubGlobal('fetch', ...) so no network is touched.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicLlmClient, buildDefaultLlmClient } from '../llmClient.js';
import { AppError } from '../../errors/AppError.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env['ANTHROPIC_API_KEY'];
});

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })) as unknown as typeof fetch,
  );
}

describe('AnthropicLlmClient.complete', () => {
  it('concatenates all text content blocks and returns usage/model', async () => {
    stubFetch(200, {
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'World' },
        { type: 'thinking', text: '(ignored)' },
      ],
      usage: { input_tokens: 12, output_tokens: 34 },
      model: 'claude-haiku-4-5-20251001',
    });
    const client = new AnthropicLlmClient('test-key');
    const result = await client.complete({
      system: 'system',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.text).toBe('Hello World');
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 34 });
    expect(result.model).toBe('claude-haiku-4-5-20251001');
  });

  it('maps 401 → AppError(502) auth failure', async () => {
    stubFetch(401, {});
    const client = new AnthropicLlmClient('bad-key');
    await expect(
      client.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('auth failure') });
  });

  it('maps 429 → AppError(503) rate limit', async () => {
    stubFetch(429, {});
    const client = new AnthropicLlmClient('k');
    await expect(
      client.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining('rate limited') });
  });

  it('maps 5xx → AppError(502) upstream', async () => {
    stubFetch(503, {});
    const client = new AnthropicLlmClient('k');
    await expect(
      client.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('upstream error') });
  });

  it('maps empty content array → AppError(502) no text', async () => {
    stubFetch(200, { content: [], usage: { input_tokens: 1, output_tokens: 0 }, model: 'm' });
    const client = new AnthropicLlmClient('k');
    await expect(
      client.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('no text') });
  });

  it('sends x-api-key + anthropic-version + JSON body', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {}, model: 'm' }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const client = new AnthropicLlmClient('secret-key');
    await client.complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('secret-key');
    expect(init.headers['anthropic-version']).toBeDefined();
    const body = JSON.parse(init.body);
    expect(body.system).toBe('sys');
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hi' });
  });
});

describe('buildDefaultLlmClient', () => {
  it('throws AppError(503) when ANTHROPIC_API_KEY is unset', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    expect(() => buildDefaultLlmClient()).toThrow(AppError);
    try {
      buildDefaultLlmClient();
    } catch (err) {
      expect((err as AppError).statusCode).toBe(503);
      expect((err as Error).message).toContain('ANTHROPIC_API_KEY');
    }
  });

  it('returns an AnthropicLlmClient when the key is set', () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    const client = buildDefaultLlmClient();
    expect(client).toBeInstanceOf(AnthropicLlmClient);
  });
});

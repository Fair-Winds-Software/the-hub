// Authorized by HUB-1797 (S1 of HUB-1784) — thin Anthropic messages client for HUB's
// first LLM integration (prompt-driven mock-data seeding). Deliberately minimal — no SDK
// dependency, just a fetch call against Anthropic's REST API. Kept behind an interface so
// tests inject a synthetic client and the route handler stays testable without hitting
// the real API.
//
// Model selection: claude-haiku-4-5 for cost/latency (seed prompts are small and the response
// is bounded JSON). Callers can override via the model parameter if a task warrants Sonnet.
//
// Errors are mapped to AppError with useful status codes:
//   401 upstream → 502 (server misconfig, not a client problem)
//   429 upstream → 503 (retry-later)
//   5xx upstream → 502 (upstream degraded)
//   invalid JSON body → 502 (SDK contract broken)
// The service layer (seedPromptService) further translates Zod parse failures on the
// content into AppError(400) since that IS a client-visible signal.
import { AppError } from '../errors/AppError.js';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmCompletionRequest {
  system: string;
  messages: LlmMessage[];
  model?: string;
  max_tokens?: number;
  temperature?: number;
}

export interface LlmCompletionResponse {
  /** The concatenated text of all `text` content blocks returned by the model. */
  text: string;
  /** Reported by Anthropic — used for logging/audit. */
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  model: string;
}

export interface LlmClient {
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse>;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponseBody {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

export class AnthropicLlmClient implements LlmClient {
  constructor(private readonly apiKey: string, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(ANTHROPIC_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: req.model ?? DEFAULT_MODEL,
          max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
          system: req.system,
          messages: req.messages,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        }),
        signal: controller.signal,
      });
      if (res.status === 401) throw new AppError(502, 'LLM auth failure (check ANTHROPIC_API_KEY)');
      if (res.status === 429) throw new AppError(503, 'LLM rate limited — try again shortly');
      if (res.status >= 500) throw new AppError(502, `LLM upstream error (${res.status})`);
      if (!res.ok) throw new AppError(502, `LLM request failed (${res.status})`);
      const body = (await res.json()) as AnthropicResponseBody;
      const text = (body.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('');
      if (!text) throw new AppError(502, 'LLM response contained no text content');
      return {
        text,
        usage: {
          input_tokens: body.usage?.input_tokens ?? 0,
          output_tokens: body.usage?.output_tokens ?? 0,
        },
        model: body.model ?? DEFAULT_MODEL,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new AppError(504, `LLM request timed out after ${this.timeoutMs}ms`);
      }
      throw new AppError(502, `LLM request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Read ANTHROPIC_API_KEY from env and build the default client. Callers that inject a
 * stub for tests do NOT call this — they construct their own LlmClient impl.
 */
export function buildDefaultLlmClient(): AnthropicLlmClient {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key) {
    throw new AppError(
      503,
      'LLM client unavailable — ANTHROPIC_API_KEY not set. This endpoint requires an Anthropic API key.',
    );
  }
  return new AnthropicLlmClient(key);
}

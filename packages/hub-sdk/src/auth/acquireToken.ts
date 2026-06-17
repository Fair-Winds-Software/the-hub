// Authorized by HUB-893 — token acquisition via POST /api/v1/auth/token; AbortController timeout; HubAuthError on failure

import { HubAuthError } from '../errors.js';

export async function acquireToken(
  hubUrl: string,
  clientId: string,
  clientSecret: string,
  timeoutMs: number,
): Promise<{ token: string; expiresAt: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${hubUrl}/api/v1/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new HubAuthError('Token acquisition failed', response.status);
    }
    const { access_token, expires_in } = await response.json() as {
      access_token: string;
      expires_in: number;
    };
    return { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
  } finally {
    clearTimeout(timer);
  }
}

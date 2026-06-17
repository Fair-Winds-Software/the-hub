// Authorized by HUB-880 — HubClient class; HubClientConfig interface; constructor; connect()
// Authorized by HUB-894 — transparent token refresh; threshold check; single shared refresh promise
// Authorized by HUB-895 — 401 auto-retry; single re-auth attempt; HubAuthError on second 401

import { acquireToken } from './auth/acquireToken.js';
import { HubAuthError } from './errors.js';

export interface HubClientConfig {
  clientId: string;
  clientSecret: string;
  hubUrl: string;
  timeoutMs?: number;
  tokenRefreshThresholdMs?: number;
}

export class HubClient {
  private readonly config: Required<HubClientConfig>;
  private token: string | null = null;
  private tokenExpiry: number | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(config: HubClientConfig) {
    if (!config.clientId) throw new TypeError('clientId is required');
    if (!config.clientSecret) throw new TypeError('clientSecret is required');
    if (!config.hubUrl) throw new TypeError('hubUrl is required');
    this.config = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      hubUrl: config.hubUrl,
      timeoutMs: config.timeoutMs ?? 10000,
      tokenRefreshThresholdMs: config.tokenRefreshThresholdMs ?? 60000,
    };
  }

  async connect(): Promise<void> {
    await this.ensureFreshToken();
  }

  private async ensureFreshToken(): Promise<void> {
    if (
      this.token !== null &&
      this.tokenExpiry !== null &&
      Date.now() < this.tokenExpiry - this.config.tokenRefreshThresholdMs
    ) {
      return;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = acquireToken(
        this.config.hubUrl,
        this.config.clientId,
        this.config.clientSecret,
        this.config.timeoutMs,
      ).then(({ token, expiresAt }) => {
        this.token = token;
        this.tokenExpiry = expiresAt;
      }).finally(() => {
        this.refreshPromise = null;
      });
    }
    await this.refreshPromise;
  }

  private async requestWithRetry(
    requestFn: (token: string) => Promise<Response>,
  ): Promise<Response> {
    await this.ensureFreshToken();
    let response = await requestFn(this.token!);
    if (response.status === 401) {
      this.token = null;
      this.tokenExpiry = null;
      this.refreshPromise = null;
      await this.ensureFreshToken();
      response = await requestFn(this.token!);
      if (response.status === 401) {
        throw new HubAuthError('Authentication failed after retry', 401);
      }
    }
    return response;
  }
}

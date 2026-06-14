// Authorized by HUB-174 — Stripe SDK singleton; shared client with fail-fast startup validation
import Stripe from 'stripe';
import logger from '../lib/logger.js';

const STRIPE_API_VERSION = '2026-05-27.dahlia' as const;

let _client: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!_client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      logger.fatal('STRIPE_SECRET_KEY missing — cannot start');
      process.exit(1);
    }
    _client = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
  }
  return _client;
}

export function validateStripeEnv(): void {
  if (!process.env.STRIPE_SECRET_KEY) {
    logger.fatal('STRIPE_SECRET_KEY missing — cannot start');
    process.exit(1);
  }
}

// Exposed for testing only — resets the singleton so tests can control env
export function _resetStripeClient(): void {
  _client = null;
}

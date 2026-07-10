// Authorized by HUB-174 — Stripe SDK singleton; shared client with fail-fast startup validation
// Authorized by HUB-188 — validateStripeEnv() extended to check STRIPE_WEBHOOK_SIGNING_SECRET
// Authorized by HUB-413 — getStripe() throws AppError(500); stripeIdempotencyKey(); mapStripeError()
// Authorized by HUB-1776 (S3 of HUB-1773) — export withStripeTimeout as a shared helper so
// LiveStripeAdapter consolidates it and the 5 local copies in service files can be removed
// during the S8 call-site migration.
import Stripe from 'stripe';
import logger from '../lib/logger.js';
import { AppError } from '../errors/AppError.js';

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
  if (!process.env.STRIPE_WEBHOOK_SIGNING_SECRET) {
    logger.fatal('STRIPE_WEBHOOK_SIGNING_SECRET missing — cannot start');
    process.exit(1);
  }
}

// Exposed for testing only — resets the singleton so tests can control env
export function _resetStripeClient(): void {
  _client = null;
}

// Testable variant of getStripeClient: throws AppError(500) instead of calling process.exit.
// Use this in service-layer code where callers can catch and handle the error.
export function getStripe(): Stripe {
  if (!_client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new AppError(500, 'STRIPE_SECRET_KEY missing');
    }
    _client = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
  }
  return _client;
}

// Builds a deterministic Stripe idempotency key from ordered parts.
// Stripe accepts keys up to 255 chars; sliced for safety.
export function stripeIdempotencyKey(...parts: string[]): string {
  return parts.join(':').slice(0, 255);
}

// HUB-1776 (S3): shared 5s timeout wrapper. Consolidates the 5 identical local copies in
// addOnService, creditService, planCatalogService, discountService, and planChangeService.
// Rejects with a plain Error (not AppError) — mapStripeError classifies it downstream.
export async function withStripeTimeout<T>(fn: () => Promise<T>, ms = 5000): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Stripe API call timed out after ${ms}ms`)), ms),
  );
  return Promise.race([fn(), timeout]);
}

// Maps a Stripe SDK error to an AppError with appropriate HTTP status code.
// Non-Stripe errors are re-thrown unchanged.
export function mapStripeError(err: unknown): never {
  if (err instanceof Stripe.errors.StripeCardError) {
    throw new AppError(402, err.message);
  }
  if (err instanceof Stripe.errors.StripeInvalidRequestError) {
    throw new AppError(400, err.message);
  }
  if (err instanceof Stripe.errors.StripeAuthenticationError) {
    throw new AppError(500, err.message);
  }
  if (err instanceof Stripe.errors.StripeRateLimitError) {
    throw new AppError(429, err.message);
  }
  if (err instanceof Stripe.errors.StripeError) {
    throw new AppError(502, err.message);
  }
  throw err;
}

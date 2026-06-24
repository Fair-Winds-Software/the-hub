// Authorized by HUB-1573 — verify error class hierarchy + name fields + instanceof contracts
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  PermissionDeniedError,
  ServerError,
  SessionExpiredError,
} from '../errors';

describe('errors (HUB-1573)', () => {
  it('ApiError is an Error with status + message', () => {
    const e = new ApiError(418, "I'm a teapot");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(418);
    expect(e.message).toBe("I'm a teapot");
    expect(e.name).toBe('ApiError');
  });

  it('SessionExpiredError extends ApiError + has correct name', () => {
    const e = new SessionExpiredError(401);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toBeInstanceOf(SessionExpiredError);
    expect(e.name).toBe('SessionExpiredError');
    expect(e.status).toBe(401);
  });

  it('PermissionDeniedError extends ApiError + has correct name', () => {
    const e = new PermissionDeniedError(403);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toBeInstanceOf(PermissionDeniedError);
    expect(e.name).toBe('PermissionDeniedError');
    expect(e.status).toBe(403);
  });

  it('ServerError extends ApiError + has correct name', () => {
    const e = new ServerError(500);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toBeInstanceOf(ServerError);
    expect(e.name).toBe('ServerError');
    expect(e.status).toBe(500);
  });
});

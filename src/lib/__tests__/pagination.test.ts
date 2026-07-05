// Authorized by HUB-1385 (E-CMP-WAVE4 S2 sub-task HUB-1395) — pagination helper unit tests.
import { describe, it, expect } from 'vitest';
import { parsePagination, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../pagination.js';

describe('parsePagination', () => {
  it('returns defaults on empty query', () => {
    expect(parsePagination({})).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      limit: DEFAULT_PAGE_SIZE,
      offset: 0,
    });
  });

  it('returns defaults on undefined query', () => {
    expect(parsePagination(undefined)).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      limit: DEFAULT_PAGE_SIZE,
      offset: 0,
    });
  });

  it('coerces string page/pageSize (Express + Fastify pass strings)', () => {
    expect(parsePagination({ page: '3', pageSize: '25' })).toEqual({
      page: 3,
      pageSize: 25,
      limit: 25,
      offset: 50,
    });
  });

  it('clamps pageSize to MAX_PAGE_SIZE', () => {
    const r = parsePagination({ pageSize: '10000' });
    expect(r.pageSize).toBe(MAX_PAGE_SIZE);
    expect(r.limit).toBe(MAX_PAGE_SIZE);
  });

  it('falls back to default page for non-numeric input', () => {
    expect(parsePagination({ page: 'abc', pageSize: 'def' })).toMatchObject({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  it('falls back to default for zero / negative values', () => {
    expect(parsePagination({ page: '0', pageSize: '-5' })).toMatchObject({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  it('computes offset correctly for page > 1', () => {
    expect(parsePagination({ page: '4', pageSize: '20' }).offset).toBe(60);
  });
});

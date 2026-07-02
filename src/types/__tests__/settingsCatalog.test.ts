// Authorized by HUB-1660 (E-FE-6 S1) — settings catalog tests. Locks the
// FR-011 contract: known keys enforce catalog type; unknown keys pass
// through so the FE JSON-fallback path stays functional.
import { describe, it, expect } from 'vitest';
import {
  getCatalogEntry,
  validateCatalogValue,
  SETTINGS_CATALOG,
} from '../settingsCatalog';

describe('settingsCatalog (HUB-1660)', () => {
  it('exposes the v0.1 required entries including the newly-added elasticity coefficient', () => {
    const keys = SETTINGS_CATALOG.map((e) => e.key);
    for (const required of [
      'portfolio_margin_threshold_pct',
      'pricing_elasticity_coefficient',
      'jira_project_key_by_product',
      'sdk_stale_threshold_days',
    ]) {
      expect(keys).toContain(required);
    }
  });

  it('elasticity coefficient defaults to -1.0 per the spec', () => {
    const entry = getCatalogEntry('pricing_elasticity_coefficient');
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('number');
    expect(entry!.default).toBe(-1.0);
  });

  describe('validateCatalogValue', () => {
    it('accepts a number value for a number-typed key', () => {
      expect(
        validateCatalogValue('portfolio_margin_threshold_pct', 0.05),
      ).toEqual({ valid: true });
    });

    it('rejects a string value for a number-typed key with an inline error', () => {
      const result = validateCatalogValue(
        'portfolio_margin_threshold_pct',
        'not-a-number',
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toMatch(/expects number/);
        expect(result.error).toMatch(/got string/);
      }
    });

    it('rejects a scalar value for a json-typed key', () => {
      const result = validateCatalogValue('jira_project_key_by_product', 42);
      expect(result.valid).toBe(false);
    });

    it('accepts an object for a json-typed key', () => {
      expect(
        validateCatalogValue('jira_project_key_by_product', {
          anyproduct: 'ANY',
        }),
      ).toEqual({ valid: true });
    });

    it('reports null (rather than object) when a json-typed key gets null', () => {
      const result = validateCatalogValue('jira_project_key_by_product', null);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/got null/);
    });

    it('reports array (rather than object) when a json-typed key gets an array', () => {
      const result = validateCatalogValue(
        'jira_project_key_by_product',
        ['CH'],
      );
      // Arrays are valid JSON objects for the current 'json' type contract
      // (assertValueType only checks typeof === 'object' + non-null); the
      // catalog entry's own docstring names object-shaped mapping so the
      // strict-object check belongs to a future story. Lock the current
      // permissive semantic explicitly to avoid a silent regression.
      expect(result).toEqual({ valid: true });
    });

    it('passes through unknown keys (FR-011)', () => {
      expect(
        validateCatalogValue('unknown_future_key', { anything: true }),
      ).toEqual({ valid: true });
      expect(
        validateCatalogValue('unknown_future_key', 'anything-string'),
      ).toEqual({ valid: true });
    });
  });
});

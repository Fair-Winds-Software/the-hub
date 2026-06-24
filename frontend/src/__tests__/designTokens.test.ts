// Authorized by HUB-1571 — unit tests asserting design-tokens SoT values + Tailwind config consumes from SoT (AC#1, #4, #5)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tokens, generateCssCustomProperties } from '../design-tokens';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('design-tokens (HUB-1571)', () => {
  it('AC#1 + D-HUB-SCOPE-026: exposes the 7 named Maverick Launch colors with locked hex values', () => {
    expect(tokens.colors).toMatchObject({
      'primary-navy': '#1C2A44',
      'accent-brass': '#A67813',
      'secondary-blue': '#5A799E',
      'sailcloth': '#F7F5EF',
      'deep-charcoal': '#4E4C4C',
      'seafoam': '#6DA47F',
      'ironwake': '#771A1A',
    });
  });

  it('D-HUB-SCOPE-026: exposes the 3 named font families (Cinzel headings, Libre Franklin body, Garamond quotes)', () => {
    expect(tokens.fontFamily.heading[0]).toBe('Cinzel');
    expect(tokens.fontFamily.body[0]).toBe('Libre Franklin');
    expect(tokens.fontFamily.quote[0]).toBe('Garamond');
  });

  it('AC#4: generateCssCustomProperties emits one --color-* var per named color', () => {
    const css = generateCssCustomProperties();
    expect(css).toContain('--color-primary-navy: #1C2A44');
    expect(css).toContain('--color-accent-brass: #A67813');
    expect(css).toContain('--color-secondary-blue: #5A799E');
    expect(css).toContain('--color-sailcloth: #F7F5EF');
    expect(css).toContain('--color-deep-charcoal: #4E4C4C');
    expect(css).toContain('--color-seafoam: #6DA47F');
    expect(css).toContain('--color-ironwake: #771A1A');
  });

  it('AC#5: tailwind.config.ts contains no inline hex literals — sources from design-tokens module', () => {
    const configSource = readFileSync(
      path.resolve(__dirname, '../../tailwind.config.ts'),
      'utf8',
    );
    // No inline hex codes anywhere in the config — every color must come from the imported tokens module.
    const hexLiteralRegex = /#[0-9a-fA-F]{3,8}\b/g;
    const hexMatches = configSource.match(hexLiteralRegex) ?? [];
    expect(hexMatches).toEqual([]);
    // Must import from design-tokens.
    expect(configSource).toContain("from './src/design-tokens'");
  });
});

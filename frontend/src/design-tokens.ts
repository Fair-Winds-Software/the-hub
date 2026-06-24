// Authorized by HUB-1571 — TS adapter loading tokens.json + exposing typed values for Tailwind config + CSS custom-property generation
// Single SoT per AC#5: tailwind.config.ts and any other consumer must import from this module, never inline values.
import tokensJson from './styles/tokens.json' with { type: 'json' };

export interface DesignTokens {
  colors: Record<string, string>;
  fontFamily: Record<string, readonly string[]>;
  borderRadius: Record<string, string>;
  boxShadow: Record<string, string>;
  spacing: Record<string, string>;
}

// Strip metadata keys (anything starting with underscore) before exporting.
function withoutMetadata<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out as T;
}

export const tokens: DesignTokens = {
  colors: withoutMetadata(tokensJson.colors),
  fontFamily: withoutMetadata(tokensJson.fontFamily) as Record<string, readonly string[]>,
  borderRadius: withoutMetadata(tokensJson.borderRadius),
  boxShadow: withoutMetadata(tokensJson.boxShadow),
  spacing: withoutMetadata(tokensJson.spacing),
};

/**
 * Generates the CSS `:root { --color-*: ... }` block consumed by index.css
 * so non-Tailwind primitives can read tokens via `var(--color-primary-navy)` (AC#4).
 */
export function generateCssCustomProperties(): string {
  const lines: string[] = [':root {'];
  for (const [name, value] of Object.entries(tokens.colors)) {
    lines.push(`  --color-${name}: ${value};`);
  }
  for (const [name, value] of Object.entries(tokens.borderRadius)) {
    lines.push(`  --radius-${name}: ${value};`);
  }
  lines.push('}');
  return lines.join('\n');
}

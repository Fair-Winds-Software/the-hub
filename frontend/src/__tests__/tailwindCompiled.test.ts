// Authorized by HUB-1571 — compile Tailwind programmatically + assert the 7 hex codes + Cinzel/Libre Franklin appear in compiled output
// Replaces R1 fragile jsdom getComputedStyle approach (rationale in Implementation Summary).
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { describe, expect, it } from 'vitest';
import tailwindConfig from '../../tailwind.config';

const PROBE_HTML = `
<html>
  <body class="bg-sailcloth text-deep-charcoal font-body">
    <h1 class="font-heading text-primary-navy">Heading</h1>
    <button class="bg-primary-navy text-sailcloth hover:bg-accent-brass">CTA</button>
    <p class="text-secondary-blue">Secondary</p>
    <span class="text-seafoam">Success</span>
    <span class="text-ironwake">Danger</span>
    <em class="font-quote">Quoted</em>
  </body>
</html>
`;

async function compileTailwind(html: string): Promise<string> {
  const cssInput = '@tailwind base; @tailwind components; @tailwind utilities;';
  const result = await postcss([
    tailwindcss({ ...tailwindConfig, content: [{ raw: html, extension: 'html' }] }),
    autoprefixer(),
  ]).process(cssInput, { from: undefined });
  return result.css;
}

describe('Tailwind compiled output (HUB-1571)', () => {
  it('AC#1 + R1: emits the 7 locked Maverick Launch colors when classes are used (rgb() form with Tailwind opacity slots)', async () => {
    const css = await compileTailwind(PROBE_HTML);
    // Tailwind v3 compiles hex colors into `rgb(<r> <g> <b> / var(--tw-*-opacity, 1))` form
    // to support utility opacity modifiers. Assert the rgb triplets, not the source hex.
    expect(css).toContain('rgb(28 42 68'); // primary-navy = #1C2A44
    expect(css).toContain('rgb(166 120 19'); // accent-brass = #A67813
    expect(css).toContain('rgb(90 121 158'); // secondary-blue = #5A799E
    expect(css).toContain('rgb(247 245 239'); // sailcloth = #F7F5EF
    expect(css).toContain('rgb(78 76 76'); // deep-charcoal = #4E4C4C
    expect(css).toContain('rgb(109 164 127'); // seafoam = #6DA47F
    expect(css).toContain('rgb(119 26 26'); // ironwake = #771A1A
  });

  it('R1: emits Cinzel + Libre Franklin + Garamond font-family declarations when font classes are used', async () => {
    const css = await compileTailwind(PROBE_HTML);
    expect(css).toContain('Cinzel');
    expect(css).toContain('Libre Franklin');
    expect(css).toContain('Garamond');
  });

  it('AC#2: emits no dark: variants', async () => {
    const css = await compileTailwind(PROBE_HTML);
    expect(css).not.toMatch(/\.dark\\:/);
  });
});

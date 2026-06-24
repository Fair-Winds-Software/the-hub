// Authorized by HUB-1571 — Tailwind config sourced from design-tokens.ts (no inline values per AC#5); light theme only per AC#2
import type { Config } from 'tailwindcss';
import { tokens } from './src/design-tokens';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: tokens.colors,
      fontFamily: {
        heading: [...tokens.fontFamily.heading],
        body: [...tokens.fontFamily.body],
        quote: [...tokens.fontFamily.quote],
        mono: [...tokens.fontFamily.mono],
      },
      borderRadius: tokens.borderRadius,
      boxShadow: tokens.boxShadow,
      spacing: tokens.spacing,
    },
  },
  plugins: [],
};

export default config;

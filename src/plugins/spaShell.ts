// Authorized by HUB-1570 — Fastify SPA-shell middleware + static serve config (S1b of HUB-1555)
// Gated on NODE_ENV !== 'development' per D-HUB-SCOPE-025 (Vite owns SPA shell in dev; Fastify owns prod).
// Registers @fastify/static for frontend/dist/, @fastify/compress for text assets, and a setNotFoundHandler
// that returns index.html for non-/api/* GETs while preserving 404 for non-GET methods.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';
import type { FastifyPluginAsync } from 'fastify';

export interface SpaShellOptions {
  /**
   * Absolute path to the built SPA dist directory.
   * Defaults to `<cwd>/frontend/dist`. Tests override this with a fixture path.
   */
  distPath?: string;
  /**
   * Paths (or path-prefixes) that the SPA-shell fallback must NOT touch.
   * The fallback returns index.html only when the request path is NOT in this list
   * (and starts with none of the prefixes), and the method is GET.
   */
  operationalWhitelist?: string[];
}

const DEFAULT_OPERATIONAL_WHITELIST = ['/health', '/ready', '/metrics', '/api/'];

function isOperationalPath(url: string, whitelist: string[]): boolean {
  for (const entry of whitelist) {
    if (entry.endsWith('/')) {
      if (url === entry.slice(0, -1) || url.startsWith(entry)) return true;
    } else if (url === entry || url.startsWith(`${entry}/`) || url.startsWith(`${entry}?`)) {
      return true;
    }
  }
  return false;
}

const spaShellPlugin: FastifyPluginAsync<SpaShellOptions> = async (fastify, opts) => {
  if (process.env.NODE_ENV === 'development') {
    fastify.log.info('spaShell: skipped (NODE_ENV=development; Vite owns SPA shell)');
    return;
  }
  // In test mode, skip unless an explicit distPath is provided (opt-in for the integration test).
  // Other backend tests that compose buildApp() don't have frontend/dist/ built and should not
  // require it; the production behavior (fail-fast on missing dist) is still enforced when
  // NODE_ENV is 'production' / 'staging' / etc.
  if (process.env.NODE_ENV === 'test' && !opts.distPath) {
    fastify.log.info('spaShell: skipped (NODE_ENV=test without explicit distPath)');
    return;
  }

  const distPath = opts.distPath ?? path.resolve(process.cwd(), 'frontend/dist');
  const indexHtmlPath = path.join(distPath, 'index.html');
  const operationalWhitelist = opts.operationalWhitelist ?? DEFAULT_OPERATIONAL_WHITELIST;

  const indexHtmlContents = readFileSync(indexHtmlPath, 'utf8');

  await fastify.register(fastifyCompress, {
    encodings: ['br', 'gzip'],
    threshold: 1024,
  });

  await fastify.register(fastifyStatic, {
    root: distPath,
    prefix: '/',
    index: false,
    list: false,
    // Disable @fastify/static's default Cache-Control so setHeaders is authoritative.
    cacheControl: false,
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  });

  fastify.setNotFoundHandler((request, reply) => {
    if (request.method !== 'GET') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not Found' } });
    }
    if (isOperationalPath(request.url, operationalWhitelist)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not Found' } });
    }
    return reply.code(200).type('text/html').header('Cache-Control', 'no-cache').send(indexHtmlContents);
  });
};

export default fp(spaShellPlugin, { name: 'spa-shell' });

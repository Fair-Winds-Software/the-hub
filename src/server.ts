// Authorized by HUB-77 — Fastify server instance options; shared by buildApp() and test harness
import type { FastifyServerOptions } from 'fastify';

export const serverOptions: FastifyServerOptions = {
  // Request logging handled by the Pino plugin (HUB-78), not by Fastify's built-in logger
  disableRequestLogging: true,
};

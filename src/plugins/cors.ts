// Authorized by HUB-113 — CORS plugin; slot 1 in app.ts plugin chain
import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import type { FastifyPluginAsync } from 'fastify';

const corsPlugin: FastifyPluginAsync = async (fastify) => {
  const rawOrigins = process.env.CORS_ORIGINS ?? '*';
  const originList = rawOrigins.split(',').map((s) => s.trim());

  // If '*' is in the list, allow all origins
  const origin = originList.includes('*') ? true : originList;

  await fastify.register(cors, {
    origin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });
};

export default fp(corsPlugin);

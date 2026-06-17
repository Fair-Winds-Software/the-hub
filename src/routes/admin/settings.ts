// Authorized by HUB-1060 — GET/PUT /api/v1/admin/settings; super_admin only; Redis-cached via hub:settings:*
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getSettings, updateSetting, type JsonValue } from '../../services/adminSettings.js';

const adminSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/admin/settings', async (request, reply) => {
    if (request.operatorUser?.role !== 'super_admin') throw new AppError(403, 'Forbidden');
    return reply.send({ settings: await getSettings() });
  });

  fastify.put('/api/v1/admin/settings', async (request, reply) => {
    if (request.operatorUser?.role !== 'super_admin') throw new AppError(403, 'Forbidden');
    const body = request.body as Record<string, unknown> | null;
    const { key, value } = body ?? {};
    if (typeof key !== 'string') throw new AppError(400, 'key is required');
    return reply.send(await updateSetting(key, value as JsonValue));
  });
};

export default adminSettingsRoutes;

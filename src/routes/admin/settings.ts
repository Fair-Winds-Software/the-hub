// Authorized by HUB-1060 — GET/PUT /api/v1/admin/settings; super_admin only; Redis-cached via hub:settings:*
// Authorized by HUB-1660 (E-FE-6 S1) — PUT now validates known keys against the shared
//   settingsCatalog. Type-mismatched known keys return 422; unknown keys pass through
//   unchanged (FR-011: catalog is a convention layer, not a hard schema).
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getSettings, updateSetting, type JsonValue } from '../../services/adminSettings.js';
import { validateCatalogValue } from '../../types/settingsCatalog.js';

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
    const validation = validateCatalogValue(key, value);
    if (!validation.valid) throw new AppError(422, validation.error);
    return reply.send(await updateSetting(key, value as JsonValue));
  });
};

export default adminSettingsRoutes;

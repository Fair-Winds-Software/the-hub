// Authorized by HUB-1698 (E-BE-1 S21) — 3 new GET endpoints under /api/v1/admin/sdk-versions/*
// that power E-FE-10 (HUB-1560): distribution chart, product breakdown table, deprecation
// impact widget. All super_admin-only — product_admin gets 403. Inline RBAC check at each
// handler entry (matches HUB-1596 / HUB-1697 pattern; no preHandler plugin needed).
//
// Registered under the operatorRbacHook-protected scope by plugins/adminRoutes.ts, so the
// hook has already populated request.operatorUser before these handlers run.
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import {
  getDistribution,
  getProductBreakdown,
  getImpactPreview,
} from '../../services/sdkVersionAnalyticsService.js';

const SDK_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function requireSuperAdmin(role: string | undefined): void {
  if (role !== 'super_admin') throw new AppError(403, 'Forbidden');
}

function requireSdkName(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string' || !SDK_NAME_RE.test(raw)) {
    throw new AppError(400, 'INVALID_SDK_NAME: sdkName must match ^[a-z][a-z0-9-]*$');
  }
  return raw;
}

function requireSemverVersion(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string' || !SEMVER_RE.test(raw)) {
    throw new AppError(400, 'INVALID_VERSION: version must match MAJOR.MINOR.PATCH');
  }
  return raw;
}

const adminSdkVersionsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/admin/sdk-versions/distribution', async (request, reply) => {
    requireSuperAdmin(request.operatorUser?.role);
    const q = request.query as Record<string, string | undefined>;
    const sdkName = requireSdkName(q.sdkName);
    const data = await getDistribution(sdkName);
    return reply.status(200).send({ sdkName, distribution: data });
  });

  fastify.get('/api/v1/admin/sdk-versions/products', async (request, reply) => {
    requireSuperAdmin(request.operatorUser?.role);
    const q = request.query as Record<string, string | undefined>;
    const sdkName = requireSdkName(q.sdkName);
    const data = await getProductBreakdown(sdkName);
    return reply.status(200).send({ sdkName, products: data });
  });

  fastify.get('/api/v1/admin/sdk-versions/impact', async (request, reply) => {
    requireSuperAdmin(request.operatorUser?.role);
    const q = request.query as Record<string, string | undefined>;
    const sdkName = requireSdkName(q.sdkName);
    const version = requireSemverVersion(q.version);
    const data = await getImpactPreview(sdkName, version);
    return reply.status(200).send({ sdkName, deprecatedVersion: version, ...data });
  });
};

export default adminSdkVersionsRoutes;

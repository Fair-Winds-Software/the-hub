// Authorized by HUB-1508 — POST /api/v1/portal/auth/login; bcrypt verify; 60-min tenant_user JWT
import type { FastifyPluginAsync } from 'fastify';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getPool } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';

const PORTAL_JWT_TTL = 3600;

const portalAuthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/api/v1/portal/auth/login', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const email = body?.email;
    const password = body?.password;
    const tenantId = body?.tenant_id;

    if (typeof email !== 'string' || !email) throw new AppError(400, 'email is required');
    if (typeof password !== 'string' || !password) throw new AppError(400, 'password is required');
    if (typeof tenantId !== 'string' || !tenantId) throw new AppError(400, 'tenant_id is required');

    const pool = getPool();
    const DUMMY_HASH = await bcrypt.hash('__hub_portal_dummy__', 12);

    const { rows } = await pool.query<{ id: string; password_hash: string; active: boolean }>(
      `SELECT id, password_hash, active FROM tenant_users WHERE email = $1 AND tenant_id = $2`,
      [email, tenantId],
    );

    const row = rows[0];
    const valid = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);

    if (!row || !valid || !row.active) {
      throw new AppError(401, 'Invalid credentials');
    }

    const secret = process.env.PORTAL_JWT_SECRET!;
    const accessToken = jwt.sign(
      { tenant_user_id: row.id, tenant_id: tenantId, role: 'tenant_user' },
      secret,
      { expiresIn: PORTAL_JWT_TTL },
    );

    return reply.send({ accessToken, expiresIn: PORTAL_JWT_TTL });
  });
};

export default portalAuthRoutes;

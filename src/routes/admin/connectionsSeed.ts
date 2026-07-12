// Authorized by HUB-1797 (S1 of HUB-1784) — POST /api/v1/admin/connections/:name/seed/prompt.
// Accepts a free-text prompt + mode ('add' | 'replace'), calls the LLM to translate the
// prompt into a validated SeedPlan, then executes the plan against the mock store via the
// existing S5 seeding façade. RBAC: super_admin only. Mock-mode guard at every entry.
//
// LLM invocation model: option (a) per Epic HUB-1784 — HUB backend calls Anthropic directly.
// The LlmClient is injected via a fastify decorator so integration tests can substitute a
// deterministic stub; production reads the default client (which uses ANTHROPIC_API_KEY).
//
// Authorized by HUB-1798 (S2 of HUB-1784) — added:
//   GET  /api/v1/admin/connections/:name/seed/presets  → list of preset descriptors
//   POST /api/v1/admin/connections/:name/seed/preset   → run a preset by id
//   DELETE /api/v1/admin/connections/:name/seed        → wipe the mock store
// All three share the same mock-only guards and audit-trail contract as /prompt.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { runSeedPrompt, runSeedPlan } from '../../services/seedPromptService.js';
import { buildDefaultLlmClient, type LlmClient } from '../../services/llmClient.js';
import { writeAuditEntry } from '../../services/auditLogService.js';
import { getPreset, listPresets } from '../../services/seedPresets.js';
import { assertMockMode } from '../../stripe/seed/guard.js';
import { seed } from '../../stripe/seed/index.js';

// The mock-store operations are unscoped by tenant, so audit rows use a stable synthetic
// tenant_id ('system') — matches the pattern used by other operator-level actions in HUB.
const AUDIT_TENANT_ID = 'system';
const AUDIT_TABLE = 'stripe_mock';

interface OperatorAuth {
  operator_id?: string;
  role?: string;
}

function operatorFromRequest(req: FastifyRequest): OperatorAuth {
  return (req as unknown as { operator?: OperatorAuth }).operator ?? {};
}

interface PromptBody {
  prompt: string;
  mode: 'add' | 'replace';
}

interface PresetBody {
  preset_id: string;
  mode: 'add' | 'replace';
}

function assertStripeName(name: string): void {
  if (name !== 'stripe') {
    throw new AppError(404, `Seeding is not implemented for connection '${name}'`);
  }
}

/**
 * Fastify plugin. Exposes a `llmClient` decorator hook: if the app has set
 * `fastify.decorate('llmClient', client)` before this plugin registers, that client is
 * used; otherwise the default (Anthropic) client is built on first request.
 */
const adminConnectionsSeedRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { name: string }; Body: PromptBody }>(
    '/api/v1/admin/connections/:name/seed/prompt',
    async (req, reply) => {
      const { name } = req.params;
      assertStripeName(name);
      const body = (req.body ?? {}) as Partial<PromptBody>;
      if (typeof body.prompt !== 'string') {
        throw new AppError(400, 'prompt (string) is required');
      }
      if (body.mode !== 'add' && body.mode !== 'replace') {
        throw new AppError(400, "mode must be 'add' or 'replace'");
      }

      const injected = (fastify as unknown as { llmClient?: LlmClient }).llmClient;
      const client: LlmClient = injected ?? buildDefaultLlmClient();

      const result = await runSeedPrompt({
        prompt: body.prompt,
        mode: body.mode,
        client,
      });

      const op = operatorFromRequest(req);
      const rowsCreated = Object.values(result.plan_summary).reduce((a, b) => a + b, 0);
      await writeAuditEntry({
        tenant_id: AUDIT_TENANT_ID,
        actor_id: op.operator_id ?? null,
        actor_type: 'operator',
        operation: 'INSERT',
        table_name: AUDIT_TABLE,
        new_values: {
          action: 'connection.seed.prompt',
          connection: name,
          mode: body.mode,
          prompt: body.prompt,
          rows_created: rowsCreated,
          errors: result.errors.length,
        },
      });

      return reply.status(200).send(result);
    },
  );

  // ── HUB-1798 (S2 of HUB-1784) — preset list, preset run, delete-all ─────────

  fastify.get<{ Params: { name: string } }>(
    '/api/v1/admin/connections/:name/seed/presets',
    async (req) => {
      assertStripeName(req.params.name);
      return { presets: listPresets() };
    },
  );

  fastify.post<{ Params: { name: string }; Body: PresetBody }>(
    '/api/v1/admin/connections/:name/seed/preset',
    async (req, reply) => {
      const { name } = req.params;
      assertStripeName(name);
      const body = (req.body ?? {}) as Partial<PresetBody>;
      if (typeof body.preset_id !== 'string' || body.preset_id.length === 0) {
        throw new AppError(400, 'preset_id (string) is required');
      }
      if (body.mode !== 'add' && body.mode !== 'replace') {
        throw new AppError(400, "mode must be 'add' or 'replace'");
      }
      const preset = getPreset(body.preset_id);
      if (!preset) {
        throw new AppError(400, `Unknown preset_id: ${body.preset_id}`);
      }

      const plan = preset.build();
      const result = await runSeedPlan(plan, body.mode);

      const op = operatorFromRequest(req);
      const rowsCreated = Object.values(result.plan_summary).reduce((a, b) => a + b, 0);
      await writeAuditEntry({
        tenant_id: AUDIT_TENANT_ID,
        actor_id: op.operator_id ?? null,
        actor_type: 'operator',
        operation: 'INSERT',
        table_name: AUDIT_TABLE,
        new_values: {
          action: 'connection.seed.preset',
          connection: name,
          mode: body.mode,
          preset_id: body.preset_id,
          rows_created: rowsCreated,
          errors: result.errors.length,
        },
      });

      return reply.status(200).send(result);
    },
  );

  fastify.delete<{ Params: { name: string } }>(
    '/api/v1/admin/connections/:name/seed',
    async (req, reply) => {
      const { name } = req.params;
      assertStripeName(name);
      // Guard first — a forged LIVE-mode call must not read the snapshot either.
      assertMockMode();
      // Snapshot before reset so we can report accurate rows_deleted.
      const pre = await seed.snapshot();
      const rowsDeleted = Object.values(pre).reduce((a, b) => a + Number(b), 0);
      await seed.reset();

      const op = operatorFromRequest(req);
      await writeAuditEntry({
        tenant_id: AUDIT_TENANT_ID,
        actor_id: op.operator_id ?? null,
        actor_type: 'operator',
        operation: 'DELETE',
        table_name: AUDIT_TABLE,
        new_values: {
          action: 'connection.seed.reset',
          connection: name,
          rows_deleted: rowsDeleted,
        },
      });

      return reply.status(200).send({ rows_deleted: rowsDeleted });
    },
  );
};

export default adminConnectionsSeedRoutes;

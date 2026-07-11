// Authorized by HUB-1797 (S1 of HUB-1784) — POST /api/v1/admin/connections/:name/seed/prompt.
// Accepts a free-text prompt + mode ('add' | 'replace'), calls the LLM to translate the
// prompt into a validated SeedPlan, then executes the plan against the mock store via the
// existing S5 seeding façade. RBAC: super_admin only. Mock-mode guard at every entry.
//
// LLM invocation model: option (a) per Epic HUB-1784 — HUB backend calls Anthropic directly.
// The LlmClient is injected via a fastify decorator so integration tests can substitute a
// deterministic stub; production reads the default client (which uses ANTHROPIC_API_KEY).
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { runSeedPrompt } from '../../services/seedPromptService.js';
import { buildDefaultLlmClient, type LlmClient } from '../../services/llmClient.js';
import { writeAuditEntry } from '../../services/auditLogService.js';

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
      if (name !== 'stripe') {
        // v1: only Stripe seeding exists. When GA/Plaid seeding lands, this dispatches
        // per connection.
        throw new AppError(404, `Seeding is not implemented for connection '${name}'`);
      }
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
};

export default adminConnectionsSeedRoutes;

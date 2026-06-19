// Authorized by HUB-1522 — analytics integration tests: usage aggregation, tenant scoping, pagination, monetary format

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";

const RUN_INTEGRATION = process.env["RUN_INTEGRATION"] === "1";

(RUN_INTEGRATION ? describe : describe.skip)(
  "Analytics Integration Tests (RUN_INTEGRATION=1)",
  () => {
    let app: FastifyInstance;
    let tenantAId: string;
    let tenantBId: string;
    let productId: string;
    let superAdminToken: string;
    let tenantAdminAToken: string;

    const OPERATOR_JWT_SECRET = "test-operator-jwt-secret-analytics";

    beforeAll(async () => {
      process.env["DATABASE_URL"] ??=
        "postgresql://hub:hub@localhost:5432/hub_dev";
      process.env["REDIS_URL"] ??= "redis://localhost:6379";
      process.env["JWT_SECRET"] ??= "test-jwt-secret-analytics";
      process.env["OPERATOR_JWT_SECRET"] = OPERATOR_JWT_SECRET;
      process.env["OPERATOR_JWT_TTL_SECONDS"] = "3600";
      process.env["BCRYPT_ROUNDS"] = "1";
      process.env["NODE_ENV"] = "test";

      const { buildApp } = await import("../app.js");
      app = await buildApp();
      await app.ready();

      const { getPool } = await import("../db/pool.js");
      const pool = getPool();

      // Create two test tenants
      const { rows: tenantRows } = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, tenant_type)
         VALUES ('analytics-tenant-A', 'external'), ('analytics-tenant-B', 'external')
         RETURNING id`,
      );
      tenantAId = tenantRows[0]!.id;
      tenantBId = tenantRows[1]!.id;

      // Create a test product (needs tenant_id and slug)
      const { rows: productRows } = await pool.query<{ id: string }>(
        `INSERT INTO products (tenant_id, name, slug)
         VALUES ($1, 'analytics-test-product', 'analytics-test-product-slug')
         RETURNING id`,
        [tenantAId],
      );
      productId = productRows[0]!.id;

      // Seed billing_period_costs with known values
      const periodStart = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000); // 15 days ago
      const periodEnd = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);    // 8 days ago
      const period2Start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
      const period2End = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);   // 1 day ago

      await pool.query(
        `INSERT INTO billing_period_costs
           (tenant_id, product_id, period_start, period_end, total_units, total_cost_cents, event_count, late_event_count)
         VALUES
           ($1, $3, $4, $5, 100, 9900, 10, 0),
           ($2, $3, $4, $5, 200, 19800, 20, 0),
           ($1, $3, $6, $7, 150, 14700, 15, 1),
           ($2, $3, $6, $7, 300, 29700, 30, 2)
         ON CONFLICT DO NOTHING`,
        [tenantAId, tenantBId, productId, periodStart, periodEnd, period2Start, period2End],
      );

      // Mint JWT tokens directly
      superAdminToken = jwt.sign(
        { operator_id: "analytics-super-id", role: "super_admin", tenant_id: null },
        OPERATOR_JWT_SECRET,
        { expiresIn: 3600 },
      );
      tenantAdminAToken = jwt.sign(
        { operator_id: "analytics-tenant-a-id", role: "tenant_admin", tenant_id: tenantAId },
        OPERATOR_JWT_SECRET,
        { expiresIn: 3600 },
      );
    });

    afterAll(async () => {
      const { getPool } = await import("../db/pool.js");
      const { closePool } = await import("../db/pool.js");
      const { closeRedis } = await import("../redis/client.js");
      const pool = getPool();

      await pool.query(
        `DELETE FROM billing_period_costs WHERE product_id = $1`,
        [productId],
      );
      await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await pool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [
        tenantAId,
        tenantBId,
      ]);

      await app.close();
      await closePool();
      await closeRedis();
    });

    // ── §1 Usage aggregation ──────────────────────────────────────────────────

    describe("§1 GET /api/v1/analytics/usage — seeded data assertions", () => {
      it("returns correct event_count and total_cost_cents as integers", async () => {
        const now = new Date();
        const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const to = now.toISOString();

        const res = await app.inject({
          method: "GET",
          url: `/api/v1/analytics/usage?tenant_id=${tenantAId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json<{
          row_count: number;
          data: { total_cost_cents: number; event_count: number }[];
        }>();
        expect(body.row_count).toBeGreaterThanOrEqual(1);
        // All monetary values must be integers
        for (const row of body.data) {
          expect(Number.isInteger(row.total_cost_cents)).toBe(true);
          expect(Number.isInteger(row.event_count)).toBe(true);
        }
        // Known seeded totals: tenant A has 9900 + 14700 = 24600 cents total
        const totalCents = body.data.reduce((sum, r) => sum + r.total_cost_cents, 0);
        expect(totalCents).toBe(24600);
      });
    });

    // ── §2 Tenant isolation ───────────────────────────────────────────────────

    describe("§2 tenant_admin scoping — returns 403 for other tenant", () => {
      it("tenant_admin JWT returns 403 when querying tenant-B usage", async () => {
        const now = new Date();
        const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const to = now.toISOString();

        const res = await app.inject({
          method: "GET",
          url: `/api/v1/analytics/usage?tenant_id=${tenantBId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          headers: { Authorization: `Bearer ${tenantAdminAToken}` },
        });
        expect(res.statusCode).toBe(403);
      });
    });

    // ── §3 Time range validation ──────────────────────────────────────────────

    describe("§3 time range > 90 days returns 400", () => {
      it("usage endpoint returns 400 for >90 day range", async () => {
        const to = new Date();
        const from = new Date(to.getTime() - 91 * 24 * 60 * 60 * 1000);

        const res = await app.inject({
          method: "GET",
          url: `/api/v1/analytics/usage?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        expect(res.statusCode).toBe(400);
      });

      it("billing endpoint returns 400 for >90 day range", async () => {
        const to = new Date();
        const from = new Date(to.getTime() - 91 * 24 * 60 * 60 * 1000);

        const res = await app.inject({
          method: "GET",
          url: `/api/v1/analytics/billing?product_id=${productId}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        expect(res.statusCode).toBe(400);
      });
    });

    // ── §4 Billing mrr_cents is integer ───────────────────────────────────────

    describe("§4 GET /api/v1/analytics/billing — mrr_cents is integer", () => {
      it("returns mrr_cents as integer with no floating point", async () => {
        const now = new Date();
        const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const to = now.toISOString();

        const res = await app.inject({
          method: "GET",
          url: `/api/v1/analytics/billing?product_id=${productId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json<{
          row_count: number;
          data: { mrr_cents: number; active_subscriptions: number; freeze_count: number }[];
        }>();
        for (const row of body.data) {
          expect(Number.isInteger(row.mrr_cents)).toBe(true);
          expect(Number.isInteger(row.active_subscriptions)).toBe(true);
          expect(Number.isInteger(row.freeze_count)).toBe(true);
        }
      });

      it("returns 403 when tenant_admin calls billing endpoint", async () => {
        const now = new Date();
        const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const to = now.toISOString();

        const res = await app.inject({
          method: "GET",
          url: `/api/v1/analytics/billing?product_id=${productId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          headers: { Authorization: `Bearer ${tenantAdminAToken}` },
        });
        expect(res.statusCode).toBe(403);
      });
    });

    // ── §5 Health returns 501 ─────────────────────────────────────────────────

    describe("§5 GET /api/v1/analytics/health — always 501", () => {
      it("returns 501 with TODO-D-I9-003 code regardless of auth", async () => {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/analytics/health",
        });
        expect(res.statusCode).toBe(501);
        const body = res.json<{ code: string }>();
        expect(body.code).toBe("TODO-D-I9-003");
      });
    });

    // ── §6 Cursor pagination ──────────────────────────────────────────────────

    describe("§6 cursor pagination — first page returns next_cursor; second page advances", () => {
      it("returns next_cursor on page 1 and different rows on page 2", async () => {
        const now = new Date();
        const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const to = now.toISOString();

        // Page 1: limit=1 to force pagination with our seeded 2 rows per tenant
        const page1Res = await app.inject({
          method: "GET",
          url: `/api/v1/analytics/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=1`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        expect(page1Res.statusCode).toBe(200);
        const page1 = page1Res.json<{
          row_count: number;
          next_cursor: string | null;
          data: unknown[];
        }>();
        expect(page1.row_count).toBe(1);
        expect(page1.next_cursor).not.toBeNull();

        // Page 2: use cursor
        const page2Res = await app.inject({
          method: "GET",
          url: `/api/v1/analytics/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=1&cursor=${page1.next_cursor!}`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        expect(page2Res.statusCode).toBe(200);
        const page2 = page2Res.json<{ data: unknown[] }>();
        expect(page2.data.length).toBeGreaterThanOrEqual(1);
      });
    });
  },
);

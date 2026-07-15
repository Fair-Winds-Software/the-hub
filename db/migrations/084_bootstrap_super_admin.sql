-- Authorized by out-of-the-box launch prep — seeds a DEV-ONLY super_admin so a fresh
-- `docker-compose up + npm run migrate + npm start` produces a system an operator can
-- actually log in to via the Console (`/console/login`).
--
-- Before this migration, the only operator INSERTs anywhere in the repo were inside test
-- fixtures (`src/__tests__/operatorAuth.integration.test.ts`); a fresh boot had no way in.
--
-- DEV credentials (both plaintext and hash committed intentionally so every dev sees the
-- same first-run password — this is a well-known fixture, not a secret):
--
--   email:    sammy@fairwindssoftware.com
--   password: hub-dev-password
--
-- Hash generated locally with:
--   node -e "console.log(require('bcryptjs').hashSync('hub-dev-password', 12))"
-- Cost 12 matches the app's REFRESH_BCRYPT_COST + the dummy-hash cost in
-- `src/services/operatorAuth.ts` — no timing-attack surface delta.
--
-- Prod override: this migration is idempotent (INSERT ... ON CONFLICT DO NOTHING). Before
-- deploying to prod, either:
--   (a) INSERT the real super_admin ahead of migrate run (this migration then no-ops), OR
--   (b) rotate the password in `operator_accounts` after first boot and consider deleting
--       this seed row entirely.
--
-- The bootstrap operator is scoped to the Maverick Launch internal tenant seeded in
-- migration 001 (id 00000000-0000-0000-0000-000000000001).

INSERT INTO operator_accounts (email, password_hash, role, tenant_id, active)
VALUES (
  'sammy@fairwindssoftware.com',
  '$2b$12$EOXeTbtuxbC1eracEPNLHuopFYubp3wza3rgDQdFHjCnl2i98oCR2',
  'super_admin',
  '00000000-0000-0000-0000-000000000001',
  true
)
ON CONFLICT (email) DO NOTHING;

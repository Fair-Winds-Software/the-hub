-- Authorized by HUB-4.1 L1 fix — add DEFAULT gen_random_uuid() to the three core-platform tables
--   created in 001 (tenants, products, product_registrations).
--
--   Why: 001 declared `id UUID PRIMARY KEY` with no default. Every subsequent table (002+) used
--   `DEFAULT gen_random_uuid()`. Production services.tenants.ts works around the gap by passing
--   `gen_random_uuid()` explicitly; some integration tests assumed the default existed and broke
--   with `null value in column "id" violates not-null constraint` (cascade across ~8 test files).
--
--   This migration aligns the original tables with the rest of the schema. It is non-destructive:
--   existing rows keep their ids; the default only fires on INSERTs that omit id.

ALTER TABLE tenants               ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE products              ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE product_registrations ALTER COLUMN id SET DEFAULT gen_random_uuid();

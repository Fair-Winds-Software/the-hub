-- Authorized by HUB-1423 (E-CMP-WAVE4b S2, HUB-871) — seed a portfolio-scoped product
-- so signals emitted by the vendor/cloud/policy CRUD API have a valid product_id UUID
-- to reference in compliance_signal_evidence.
--
-- Design rationale: unlike device/HR registers which store an operator-supplied product
-- slug per row, the vendor/cloud/policy registers are portfolio-level. Rather than
-- extending emitGrcSignal to accept a nullable product OR making
-- compliance_signal_evidence.product_id nullable (a much wider blast radius), we seed a
-- single `hub-portfolio` product under the Maverick Launch tenant and route all
-- Wave 4b GRC signals through it.
--
-- The seed row is idempotent (ON CONFLICT DO NOTHING on the slug UNIQUE).

INSERT INTO products (id, tenant_id, name, slug, active)
SELECT
  '00000000-0000-0000-0000-0000000000ff'::uuid,
  t.id,
  'HUB Portfolio',
  'hub-portfolio',
  true
  FROM tenants t
 WHERE t.name = 'Maverick Launch' AND t.tenant_type = 'internal'
 ON CONFLICT (slug) DO NOTHING;

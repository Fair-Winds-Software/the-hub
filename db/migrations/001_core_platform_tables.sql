-- Authorized by HUB-50 — tenants, products, product_registrations DDL + seed

CREATE TABLE tenants (
  id          UUID        PRIMARY KEY,
  name        TEXT        NOT NULL,
  tenant_type TEXT        NOT NULL CHECK (tenant_type IN ('external', 'internal')),
  status      TEXT        DEFAULT 'active',
  settings    JSONB       DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  delta_data  JSONB
);

CREATE TABLE products (
  id          UUID        PRIMARY KEY,
  tenant_id   UUID        NOT NULL REFERENCES tenants(id),
  name        TEXT        NOT NULL,
  slug        TEXT        UNIQUE NOT NULL,
  status      TEXT        DEFAULT 'active',
  metadata    JSONB       DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  delta_data  JSONB
);

CREATE TABLE product_registrations (
  id                 UUID PRIMARY KEY,
  product_id         UUID NOT NULL REFERENCES products(id),
  client_id          UUID UNIQUE NOT NULL,
  client_secret_hash TEXT NOT NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  delta_data         JSONB
);

-- FK indexes (unique constraints already create indexes for slug and client_id)
CREATE INDEX idx_products_tenant_id ON products(tenant_id);
CREATE INDEX idx_product_registrations_product_id ON product_registrations(product_id);

-- Seed: Maverick Launch internal umbrella tenant
-- UUID '00000000-0000-0000-0000-000000000001' matches MAVERICK_LAUNCH_TENANT_ID constant
INSERT INTO tenants (id, name, tenant_type)
VALUES ('00000000-0000-0000-0000-000000000001', 'Maverick Launch', 'internal')
ON CONFLICT DO NOTHING;

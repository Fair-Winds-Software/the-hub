-- Authorized by HUB-1086 — active boolean on tenants; UNIQUE(name, tenant_type)
-- Authorized by HUB-1103 — active boolean on products; UNIQUE(tenant_id, name)

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE products ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_name_type_unique'
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_name_type_unique UNIQUE (name, tenant_type);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_tenant_name_unique'
  ) THEN
    ALTER TABLE products ADD CONSTRAINT products_tenant_name_unique UNIQUE (tenant_id, name);
  END IF;
END $$;

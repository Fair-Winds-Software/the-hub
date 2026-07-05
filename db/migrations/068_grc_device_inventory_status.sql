-- Authorized by HUB-1385 (E-CMP-WAVE4 S2, HUB-870) — extend device_inventory with the
-- soft-delete columns required by DELETE /api/v1/admin/grc/devices/:id (AC 4). HUB-1384
-- shipped device_inventory without a status column; this migration adds it as an
-- ALTER so downstream soft-delete semantics can be implemented in the CRUD API without
-- retro-editing 067.
--
-- Defaults: status='active' for all existing rows; decommissioned_at remains NULL until
-- an operator soft-deletes. CHECK on status is a two-value enum for the current lifecycle.

ALTER TABLE device_inventory
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS decommissioned_at TIMESTAMPTZ;

ALTER TABLE device_inventory
  DROP CONSTRAINT IF EXISTS device_inventory_status_check;

ALTER TABLE device_inventory
  ADD CONSTRAINT device_inventory_status_check
  CHECK (status IN ('active', 'decommissioned'));

CREATE INDEX IF NOT EXISTS idx_device_inventory_status ON device_inventory(status);

-- Authorized by HUB-815 — workflow_hooks and workflow_hook_executions tables; delta tracking; wildcard NULL tenant/product support
CREATE TABLE IF NOT EXISTS workflow_hooks (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID        REFERENCES tenants(id)  ON DELETE CASCADE,
  product_id           UUID        REFERENCES products(id) ON DELETE CASCADE,
  trigger_event_type   TEXT        NOT NULL,
  action_type          TEXT        NOT NULL DEFAULT 'webhook',
  action_config        JSONB       NOT NULL,
  enabled              BOOLEAN     NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  delta_data           JSONB
);

CREATE TABLE IF NOT EXISTS workflow_hook_executions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hook_id         UUID        NOT NULL REFERENCES workflow_hooks(id) ON DELETE CASCADE,
  alert_event_id  UUID        REFERENCES alert_events(id),
  status          TEXT        NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  status_code     INT,
  duration_ms     INT,
  error           TEXT,
  attempted_at    TIMESTAMPTZ DEFAULT NOW(),
  delta_data      JSONB
);

CREATE INDEX IF NOT EXISTS idx_workflow_hooks_trigger_event_type ON workflow_hooks(trigger_event_type);
CREATE INDEX IF NOT EXISTS idx_workflow_hook_executions_hook_id  ON workflow_hook_executions(hook_id);

CREATE TRIGGER universal_delta_tracker_workflow_hooks
  BEFORE INSERT OR UPDATE ON workflow_hooks
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

CREATE TRIGGER universal_delta_tracker_workflow_hook_executions
  BEFORE INSERT OR UPDATE ON workflow_hook_executions
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

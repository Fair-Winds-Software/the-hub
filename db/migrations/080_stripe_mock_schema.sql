-- Authorized by HUB-1777 (S4 of HUB-1773) — dedicated `stripe_mock` schema holding
-- IMPORTANT: triggers use AFTER INSERT OR UPDATE OR DELETE, NOT BEFORE. The
-- universal_delta_tracker() function returns NULL on TG_OP='INSERT' (no matching
-- branch), and a BEFORE trigger returning NULL tells Postgres to SILENTLY DROP
-- the row. Migration 077 fixed the same pattern on workflow_hooks after it burned
-- HUB-1771. Following the same AFTER pattern here up front.
-- Stripe-shaped fixtures that MockStripeAdapter reads and writes. Separate schema
-- (not table-name-prefix in public) is a physical guard: even if the S7 mock-only
-- guard is bypassed via a coding error, HUB code paths targeting `stripe_customers`,
-- `stripe_subscriptions` etc. in `public` won't accidentally touch mock data.
--
-- IDs are VARCHAR (not UUID) because Stripe uses prefixed short IDs (cus_*, sub_*,
-- in_*, price_*, prod_*, coup_*, di_*, sub_sched_*, cbtxn_*, evt_*, si_*, il_*).
-- Timestamps are BIGINT unix-epoch-seconds per Stripe convention (created columns),
-- with `created_at` TIMESTAMPTZ added on the row for local audit / delta_data timing.
--
-- delta_data JSONB + universal_delta_tracker on every table so mock mutations show
-- up in the same delta_log stream as real HUB data.

CREATE SCHEMA IF NOT EXISTS stripe_mock;

-- ── customers ────────────────────────────────────────────────────────────────────
CREATE TABLE stripe_mock.customers (
  id              VARCHAR PRIMARY KEY,
  created         BIGINT NOT NULL,
  email           TEXT,
  name            TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  livemode        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data      JSONB
);
CREATE INDEX idx_stripe_mock_customers_created ON stripe_mock.customers(created DESC, id DESC);
CREATE TRIGGER universal_delta_tracker_stripe_mock_customers
  AFTER INSERT OR UPDATE OR DELETE ON stripe_mock.customers
  FOR EACH ROW EXECUTE FUNCTION public.universal_delta_tracker();

-- ── products ─────────────────────────────────────────────────────────────────────
CREATE TABLE stripe_mock.products (
  id              VARCHAR PRIMARY KEY,
  created         BIGINT NOT NULL,
  name            TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT true,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data      JSONB
);
CREATE INDEX idx_stripe_mock_products_created ON stripe_mock.products(created DESC, id DESC);
CREATE TRIGGER universal_delta_tracker_stripe_mock_products
  AFTER INSERT OR UPDATE OR DELETE ON stripe_mock.products
  FOR EACH ROW EXECUTE FUNCTION public.universal_delta_tracker();

-- ── prices ───────────────────────────────────────────────────────────────────────
CREATE TABLE stripe_mock.prices (
  id                  VARCHAR PRIMARY KEY,
  created             BIGINT NOT NULL,
  product             VARCHAR NOT NULL REFERENCES stripe_mock.products(id) ON DELETE CASCADE,
  unit_amount         BIGINT,
  currency            VARCHAR(3) NOT NULL,
  active              BOOLEAN NOT NULL DEFAULT true,
  recurring_interval  TEXT CHECK (recurring_interval IN ('day', 'week', 'month', 'year')),
  recurring_interval_count INT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data          JSONB
);
CREATE INDEX idx_stripe_mock_prices_created ON stripe_mock.prices(created DESC, id DESC);
CREATE INDEX idx_stripe_mock_prices_product ON stripe_mock.prices(product);
CREATE TRIGGER universal_delta_tracker_stripe_mock_prices
  AFTER INSERT OR UPDATE OR DELETE ON stripe_mock.prices
  FOR EACH ROW EXECUTE FUNCTION public.universal_delta_tracker();

-- ── coupons ──────────────────────────────────────────────────────────────────────
CREATE TABLE stripe_mock.coupons (
  id                  VARCHAR PRIMARY KEY,
  created             BIGINT NOT NULL,
  name                TEXT,
  percent_off         NUMERIC(5, 2),
  amount_off          BIGINT,
  currency            VARCHAR(3),
  duration            TEXT NOT NULL CHECK (duration IN ('forever', 'once', 'repeating')),
  duration_in_months  INT,
  valid               BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data          JSONB
);
CREATE INDEX idx_stripe_mock_coupons_created ON stripe_mock.coupons(created DESC, id DESC);
CREATE TRIGGER universal_delta_tracker_stripe_mock_coupons
  AFTER INSERT OR UPDATE OR DELETE ON stripe_mock.coupons
  FOR EACH ROW EXECUTE FUNCTION public.universal_delta_tracker();

-- ── subscriptions ────────────────────────────────────────────────────────────────
-- Subscription-level fields; items are stored as JSONB to keep the schema tight
-- (mock doesn't need to model the full subscription_items table separately).
CREATE TABLE stripe_mock.subscriptions (
  id                      VARCHAR PRIMARY KEY,
  created                 BIGINT NOT NULL,
  customer                VARCHAR NOT NULL REFERENCES stripe_mock.customers(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL CHECK (status IN (
                            'incomplete', 'incomplete_expired', 'trialing', 'active',
                            'past_due', 'canceled', 'unpaid', 'paused'
                          )),
  current_period_start    BIGINT NOT NULL,
  current_period_end      BIGINT NOT NULL,
  cancel_at_period_end    BOOLEAN NOT NULL DEFAULT false,
  canceled_at             BIGINT,
  items                   JSONB NOT NULL,
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  livemode                BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data              JSONB
);
CREATE INDEX idx_stripe_mock_subscriptions_created ON stripe_mock.subscriptions(created DESC, id DESC);
CREATE INDEX idx_stripe_mock_subscriptions_customer ON stripe_mock.subscriptions(customer);
CREATE INDEX idx_stripe_mock_subscriptions_status ON stripe_mock.subscriptions(status);
CREATE TRIGGER universal_delta_tracker_stripe_mock_subscriptions
  AFTER INSERT OR UPDATE OR DELETE ON stripe_mock.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.universal_delta_tracker();

-- ── subscription_schedules ───────────────────────────────────────────────────────
CREATE TABLE stripe_mock.subscription_schedules (
  id                  VARCHAR PRIMARY KEY,
  created             BIGINT NOT NULL,
  customer            VARCHAR NOT NULL REFERENCES stripe_mock.customers(id) ON DELETE CASCADE,
  subscription        VARCHAR REFERENCES stripe_mock.subscriptions(id) ON DELETE SET NULL,
  status              TEXT NOT NULL CHECK (status IN (
                        'not_started', 'active', 'completed', 'released', 'canceled'
                      )),
  phases              JSONB NOT NULL,
  current_phase_start BIGINT,
  current_phase_end   BIGINT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data          JSONB
);
CREATE INDEX idx_stripe_mock_sub_sched_created ON stripe_mock.subscription_schedules(created DESC, id DESC);
CREATE INDEX idx_stripe_mock_sub_sched_customer ON stripe_mock.subscription_schedules(customer);
CREATE TRIGGER universal_delta_tracker_stripe_mock_subscription_schedules
  AFTER INSERT OR UPDATE OR DELETE ON stripe_mock.subscription_schedules
  FOR EACH ROW EXECUTE FUNCTION public.universal_delta_tracker();

-- ── invoices ─────────────────────────────────────────────────────────────────────
-- Lines are JSONB; parent is JSONB to preserve the Dahlia parent envelope shape.
CREATE TABLE stripe_mock.invoices (
  id              VARCHAR PRIMARY KEY,
  created         BIGINT NOT NULL,
  customer        VARCHAR NOT NULL REFERENCES stripe_mock.customers(id) ON DELETE CASCADE,
  parent          JSONB,
  status          TEXT CHECK (status IN ('draft', 'open', 'paid', 'uncollectible', 'void')),
  amount_due      BIGINT NOT NULL,
  amount_paid     BIGINT NOT NULL DEFAULT 0,
  currency        VARCHAR(3) NOT NULL,
  period_start    BIGINT NOT NULL,
  period_end      BIGINT NOT NULL,
  invoice_pdf     TEXT,
  lines           JSONB NOT NULL DEFAULT '{"object": "list", "data": [], "has_more": false}'::jsonb,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data      JSONB
);
CREATE INDEX idx_stripe_mock_invoices_created ON stripe_mock.invoices(created DESC, id DESC);
CREATE INDEX idx_stripe_mock_invoices_customer ON stripe_mock.invoices(customer);
CREATE INDEX idx_stripe_mock_invoices_status ON stripe_mock.invoices(status);
CREATE TRIGGER universal_delta_tracker_stripe_mock_invoices
  AFTER INSERT OR UPDATE OR DELETE ON stripe_mock.invoices
  FOR EACH ROW EXECUTE FUNCTION public.universal_delta_tracker();

-- ── discounts ────────────────────────────────────────────────────────────────────
-- Coupon is embedded as JSONB to match Stripe's nested-object return shape.
CREATE TABLE stripe_mock.discounts (
  id              VARCHAR PRIMARY KEY,
  coupon_id       VARCHAR NOT NULL REFERENCES stripe_mock.coupons(id) ON DELETE RESTRICT,
  customer        VARCHAR REFERENCES stripe_mock.customers(id) ON DELETE CASCADE,
  subscription    VARCHAR REFERENCES stripe_mock.subscriptions(id) ON DELETE SET NULL,
  start           BIGINT NOT NULL,
  "end"           BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data      JSONB
);
CREATE INDEX idx_stripe_mock_discounts_customer ON stripe_mock.discounts(customer);
CREATE TRIGGER universal_delta_tracker_stripe_mock_discounts
  AFTER INSERT OR UPDATE OR DELETE ON stripe_mock.discounts
  FOR EACH ROW EXECUTE FUNCTION public.universal_delta_tracker();

-- ── balance_transactions ─────────────────────────────────────────────────────────
CREATE TABLE stripe_mock.balance_transactions (
  id              VARCHAR PRIMARY KEY,
  created         BIGINT NOT NULL,
  customer        VARCHAR NOT NULL REFERENCES stripe_mock.customers(id) ON DELETE CASCADE,
  amount          BIGINT NOT NULL,
  currency        VARCHAR(3) NOT NULL,
  description     TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data      JSONB
);
CREATE INDEX idx_stripe_mock_balance_txn_customer ON stripe_mock.balance_transactions(customer);
CREATE TRIGGER universal_delta_tracker_stripe_mock_balance_transactions
  AFTER INSERT OR UPDATE OR DELETE ON stripe_mock.balance_transactions
  FOR EACH ROW EXECUTE FUNCTION public.universal_delta_tracker();

-- ── events ───────────────────────────────────────────────────────────────────────
-- Every mock mutation that maps to a HUB-handled event type writes here so
-- integration tests can inspect the event stream mock emitted.
CREATE TABLE stripe_mock.events (
  id              VARCHAR PRIMARY KEY,
  type            TEXT NOT NULL,
  api_version     TEXT NOT NULL,
  created         BIGINT NOT NULL,
  livemode        BOOLEAN NOT NULL DEFAULT false,
  data            JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data      JSONB
);
CREATE INDEX idx_stripe_mock_events_created ON stripe_mock.events(created DESC, id DESC);
CREATE INDEX idx_stripe_mock_events_type ON stripe_mock.events(type);
CREATE TRIGGER universal_delta_tracker_stripe_mock_events
  AFTER INSERT OR UPDATE OR DELETE ON stripe_mock.events
  FOR EACH ROW EXECUTE FUNCTION public.universal_delta_tracker();

-- ── idempotency_keys ─────────────────────────────────────────────────────────────
-- Stripe SDK's idempotencyKey semantics: repeat calls within 24h with the same key
-- return the original response. Mock mirrors this by hashing (key, method) into
-- a stored response JSONB. TTL cleanup runs at read time (delete-if-expired then
-- lookup).
CREATE TABLE stripe_mock.idempotency_keys (
  key             VARCHAR PRIMARY KEY,
  method          TEXT NOT NULL,
  response        JSONB NOT NULL,
  created         BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_stripe_mock_idem_created ON stripe_mock.idempotency_keys(created);

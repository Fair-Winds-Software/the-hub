-- Authorized by HUB-112 — operators table; operator authentication for admin panel access

CREATE TABLE operators (
  operator_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL CHECK (role IN ('operator', 'admin')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_operators_username ON operators(username);

# Stripe Mock Fixtures — CSV & JSON Format

Authorized by HUB-1779 (S6 of HUB-1773).

The importers under `src/stripe/seed/importers.ts` load fixture data into the
`stripe_mock.*` schema via the S5 programmatic seed API. Both entry points share
the same validate-then-insert path, the same mock-only guard, and the same
all-or-nothing transactional semantics — the only difference is the file format.

## Object types

| CSV filename | Seed facet |
|---|---|
| `customers.csv` | `seed.customers.create` |
| `products.csv` | `seed.products.create` |
| `prices.csv` | `seed.prices.create` |
| `coupons.csv` | `seed.coupons.create` |
| `subscriptions.csv` | `seed.subscriptions.create` |
| `invoices.csv` | `seed.invoices.create` |
| `discounts.csv` | `seed.discounts.create` |
| `balance_transactions.csv` | `seed.balanceTransactions.create` |

## CSV format

- **Header row required.** Column names must match the seed input schema field
  names (see `src/stripe/seed/index.ts` — `CustomerInput`, `SubscriptionInput`,
  etc.). Snake_case, matching Stripe's API convention.
- **Empty cells** are treated as "unset" — Zod applies defaults or nullable/optional
  semantics. An empty cell in a REQUIRED column is a validation error.
- **Numeric columns** (`created`, `unit_amount`, `amount_due`, timestamps, etc.)
  are coerced to numbers. Non-numeric values in numeric columns fail validation.
- **Boolean columns** (`active`, `cancel_at_period_end`, etc.) accept the literal
  strings `true` / `false` only. Any other value fails validation.
- **JSON columns** — `metadata` and (for subscriptions) `items` — expect a valid
  JSON string cell:
  - `metadata`: `{"tenant_id":"a-b-c","tier":"pro"}`
  - `items`: `[{"price":"price_1","quantity":1}]`
- **Timestamps** are unix epoch seconds (Stripe convention).
- **ID columns** wire relationships: `subscriptions.csv` has a `customer` column
  referencing an existing `customers.id`. FK integrity is enforced at import
  time; orphan references fail with a clear per-row error and roll back the
  entire load.

### Example customers.csv

```csv
id,email,name,metadata
cus_demo_alice,alice@example.com,Alice,{"tenant_id":"t1"}
cus_demo_bob,bob@example.com,,{"tenant_id":"t2"}
```

### Example subscriptions.csv

```csv
id,customer,status,items,metadata
sub_demo_alice,cus_demo_alice,active,"[{""price"":""price_pro_monthly""}]",{}
```

Note the double-double-quotes escaping inside the CSV-quoted `items` cell — this
is standard CSV escaping.

## JSON format

Two variants are accepted by `importJson()`:

### Single-file bundle

One JSON object with per-object-type arrays:

```json
{
  "customers": [
    { "id": "cus_demo_alice", "email": "alice@example.com" },
    { "id": "cus_demo_bob", "email": "bob@example.com" }
  ],
  "products": [
    { "id": "prod_pro", "name": "Pro" }
  ],
  "prices": [
    { "id": "price_pro_monthly", "product": "prod_pro", "unit_amount": 2000, "currency": "usd" }
  ],
  "subscriptions": [
    { "customer": "cus_demo_alice", "items": [{ "price": "price_pro_monthly" }] }
  ]
}
```

The importer inserts groups in FK-safe order:
`customers → products → coupons → prices → subscriptions → invoices → discounts → balance_transactions`.

### NDJSON

One JSON object per line, each carrying an `_object` discriminator naming the
target facet:

```
{"_object":"customer","id":"cus_demo_alice","email":"alice@example.com"}
{"_object":"customer","id":"cus_demo_bob","email":"bob@example.com"}
{"_object":"product","id":"prod_pro","name":"Pro"}
{"_object":"price","id":"price_pro_monthly","product":"prod_pro","unit_amount":2000,"currency":"usd"}
{"_object":"subscription","customer":"cus_demo_alice","items":[{"price":"price_pro_monthly"}]}
```

NDJSON is grouped by `_object` and inserted in the same FK-safe order as the
single-file bundle. Lines without `_object` fail validation.

## Semantics

- **All-or-nothing.** On any per-row validation OR FK failure, the whole load
  rolls back and the caller sees `success: false` with per-row errors. No
  partial writes.
- **Mock-only guard.** Every import routes through the S7 guard — importing in
  LIVE mode throws `AppError(400)` before any read.
- **Idempotency.** Provide explicit `id` values to make re-runs deterministic
  (helpful for CI-generated fixtures). Auto-generated IDs (Stripe-style
  `cus_<24-hex>`) are used when `id` is absent.

## When to use each format

- **CSV** — hand-editable in spreadsheets; each object type lives in its own
  file. Best for BE-team fixtures where a spreadsheet workflow is preferred.
- **Single-file JSON** — one file to check into git; easy to review as a diff.
  Best for E2E fixtures where multiple object types stay in sync.
- **NDJSON** — streaming-friendly. Best when fixtures come from another tool
  (log capture, event stream export, etc.).

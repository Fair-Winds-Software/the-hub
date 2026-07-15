// Authorized by HUB-1822 (S5 of HUB-1787) — Onboarding wizard page.
// Two-tab layout:
//   Register — form to register a new product; on success reveals the one-time
//              credentials (client_id + client_secret) in a copy-friendly panel.
//   Manage   — pick a tenant → pick a product → Rotate credential or Revoke.
// super_admin only (RBAC enforced on the backend endpoints; frontend guard added
// via the App.tsx GuardedRoute so non-super_admins are redirected).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../lib/api';
import { ConfirmDestructive } from '../components/ConfirmDestructive';
import { useToastStore } from '../stores/toastStore';

const PAGE_TITLE = 'Onboarding | HUB Console';
const TENANTS_PATH = '/api/v1/admin/tenants';
const REGISTER_PATH = '/api/v1/admin/onboarding/register';

type Tab = 'register' | 'manage';

interface Tenant {
  id: string;
  name: string;
}

interface TenantsResponse {
  tenants?: Tenant[];
}

interface RegisterBody {
  tenant_id: string;
  name: string;
  slug: string;
  product_type?: string;
}

interface RegisterResult {
  product_id: string;
  slug: string;
  name: string;
  client_id: string;
  client_secret: string;
}

interface Product {
  id: string;
  name: string;
  slug?: string;
}

interface ProductsResponse {
  products?: Product[];
}

interface RotateResult {
  product_id: string;
  slug: string;
  client_id: string;
  client_secret: string;
}

interface RevokeResult {
  product_id: string;
  slug: string;
  active: false;
  effective_hard_revoke_at: string;
}

interface Fetchers {
  listTenants?: () => Promise<TenantsResponse>;
  registerProduct?: (body: RegisterBody) => Promise<RegisterResult>;
  listProducts?: (tenantId: string) => Promise<ProductsResponse>;
  rotateCredential?: (productId: string, reason?: string) => Promise<RotateResult>;
  revokeProduct?: (productId: string, reason?: string) => Promise<RevokeResult>;
}

interface Props {
  fetchers?: Fetchers;
}

const PRODUCT_TYPES = ['saas', 'internal_only', 'workbench', 'ai_service'] as const;

export default function Onboarding({ fetchers }: Props = {}): React.ReactElement {
  if (typeof document !== 'undefined' && document.title !== PAGE_TITLE) {
    document.title = PAGE_TITLE;
  }

  const eff = useMemo<Required<Fetchers>>(
    () => ({
      listTenants:
        fetchers?.listTenants ?? (() => apiClient.get<TenantsResponse>(TENANTS_PATH)),
      registerProduct:
        fetchers?.registerProduct ??
        ((body: RegisterBody) => apiClient.post<RegisterResult>(REGISTER_PATH, body)),
      listProducts:
        fetchers?.listProducts ??
        ((tenantId: string) =>
          apiClient.get<ProductsResponse>(
            `/api/v1/admin/tenants/${tenantId}/products`,
          )),
      rotateCredential:
        fetchers?.rotateCredential ??
        ((productId: string, reason?: string) =>
          apiClient.post<RotateResult>(
            `/api/v1/admin/onboarding/${productId}/rotate-credential`,
            reason ? { reason } : {},
          )),
      revokeProduct:
        fetchers?.revokeProduct ??
        ((productId: string, reason?: string) =>
          apiClient.post<RevokeResult>(
            `/api/v1/admin/onboarding/${productId}/revoke`,
            reason ? { reason } : {},
          )),
    }),
    [fetchers],
  );

  const addToast = useToastStore((s) => s.addToast);
  const [tab, setTab] = useState<Tab>('register');
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await eff.listTenants();
        setTenants(res.tenants ?? []);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [eff]);

  return (
    <div id="main-content" data-testid="onboarding-page" className="flex flex-col gap-6">
      <header>
        <h1 className="font-heading text-2xl text-primary-navy">Onboarding</h1>
        <p className="font-body text-sm text-deep-charcoal/70">
          Register a new internal application with HUB, or manage credentials for
          existing products.
        </p>
      </header>

      <div role="tablist" className="flex gap-2 border-b border-sailcloth/30">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'register'}
          data-testid="onboarding-tab-register"
          onClick={() => setTab('register')}
          className={tabButtonClass(tab === 'register')}
        >
          Register new
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'manage'}
          data-testid="onboarding-tab-manage"
          onClick={() => setTab('manage')}
          className={tabButtonClass(tab === 'manage')}
        >
          Manage existing
        </button>
      </div>

      {error ? (
        <p role="alert" data-testid="onboarding-page-error" className="text-danger">
          {error}
        </p>
      ) : null}

      {tab === 'register' ? (
        <RegisterPanel
          tenants={tenants ?? []}
          registerFn={eff.registerProduct}
          onSuccess={() =>
            addToast({ variant: 'success', message: 'Product registered.' })
          }
        />
      ) : (
        <ManagePanel
          tenants={tenants ?? []}
          listProducts={eff.listProducts}
          rotateFn={eff.rotateCredential}
          revokeFn={eff.revokeProduct}
        />
      )}
    </div>
  );
}

function tabButtonClass(active: boolean): string {
  return `px-3 py-1.5 text-sm border-b-2 ${
    active
      ? 'border-primary-navy text-primary-navy font-semibold'
      : 'border-transparent text-deep-charcoal/60 hover:text-primary-navy'
  }`;
}

// ── Register panel ────────────────────────────────────────────────────────────

function RegisterPanel(props: {
  tenants: Tenant[];
  registerFn: (body: RegisterBody) => Promise<RegisterResult>;
  onSuccess: () => void;
}): React.ReactElement {
  const [tenantId, setTenantId] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [slug, setSlug] = useState<string>('');
  const [productType, setProductType] = useState<string>('saas');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RegisterResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit =
    !busy && tenantId.length > 0 && name.trim().length >= 2 && /^[a-z][a-z0-9-]+$/.test(slug);

  const submit = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await props.registerFn({
        tenant_id: tenantId,
        name: name.trim(),
        slug,
        product_type: productType,
      });
      setResult(res);
      props.onSuccess();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [tenantId, name, slug, productType, props]);

  return (
    <section
      data-testid="onboarding-register-panel"
      aria-label="Register a new product"
      className="rounded-md border border-sailcloth/40 bg-white p-4 flex flex-col gap-3"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-deep-charcoal/70">Tenant</span>
        <select
          data-testid="onboarding-tenant-picker"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          className="rounded-md border border-sailcloth/50 px-3 py-2"
        >
          <option value="">Select tenant…</option>
          {props.tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-deep-charcoal/70">Product name</span>
        <input
          type="text"
          data-testid="onboarding-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-sailcloth/50 px-3 py-2"
          placeholder="e.g. ContentHelm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-deep-charcoal/70">Slug (kebab-case, unique)</span>
        <input
          type="text"
          data-testid="onboarding-slug-input"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          className="rounded-md border border-sailcloth/50 px-3 py-2"
          placeholder="e.g. contenthelm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-deep-charcoal/70">Product type</span>
        <select
          data-testid="onboarding-product-type-picker"
          value={productType}
          onChange={(e) => setProductType(e.target.value)}
          className="rounded-md border border-sailcloth/50 px-3 py-2"
        >
          {PRODUCT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <div>
        <button
          type="button"
          data-testid="onboarding-register-submit"
          disabled={!canSubmit}
          onClick={() => void submit()}
          className="rounded-md bg-primary-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Registering…' : 'Register product'}
        </button>
      </div>

      {err ? (
        <p role="alert" data-testid="onboarding-register-error" className="text-sm text-red-800">
          {err}
        </p>
      ) : null}

      {result ? (
        <CredentialReveal result={result} onDismiss={() => setResult(null)} />
      ) : null}
    </section>
  );
}

// ── One-time credential reveal ────────────────────────────────────────────────

function CredentialReveal(props: {
  result: RegisterResult;
  onDismiss: () => void;
}): React.ReactElement {
  return (
    <section
      role="alertdialog"
      data-testid="onboarding-credential-reveal"
      aria-label="One-time credential reveal"
      className="rounded-md border border-emerald-400 bg-emerald-50 p-3 text-sm text-emerald-900"
    >
      <p className="mb-2 font-semibold">
        Product <code>{props.result.slug}</code> registered. Copy the credentials below
        — the secret will not be shown again.
      </p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className="font-semibold">product_id</dt>
        <dd data-testid="onboarding-reveal-product-id">
          <code>{props.result.product_id}</code>
        </dd>
        <dt className="font-semibold">client_id</dt>
        <dd data-testid="onboarding-reveal-client-id">
          <code>{props.result.client_id}</code>
        </dd>
        <dt className="font-semibold">client_secret</dt>
        <dd data-testid="onboarding-reveal-client-secret">
          <code>{props.result.client_secret}</code>
        </dd>
      </dl>
      <p className="mt-2 text-xs text-emerald-800">
        Store these in the target app's <code>.env.local</code>. Do NOT commit to git.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          data-testid="onboarding-reveal-dismiss"
          onClick={props.onDismiss}
          className="rounded-md border border-emerald-700 bg-white px-3 py-1 text-xs font-semibold text-emerald-900"
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}

// ── Manage-existing panel ────────────────────────────────────────────────────

function ManagePanel(props: {
  tenants: Tenant[];
  listProducts: (tenantId: string) => Promise<ProductsResponse>;
  rotateFn: (productId: string, reason?: string) => Promise<RotateResult>;
  revokeFn: (productId: string, reason?: string) => Promise<RevokeResult>;
}): React.ReactElement {
  const addToast = useToastStore((s) => s.addToast);
  const [tenantId, setTenantId] = useState<string>('');
  const [products, setProducts] = useState<Product[] | null>(null);
  const [rotateResult, setRotateResult] = useState<RotateResult | null>(null);
  const [revokeResult, setRevokeResult] = useState<RevokeResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) {
      setProducts(null);
      return;
    }
    void (async () => {
      try {
        const res = await props.listProducts(tenantId);
        setProducts(res.products ?? []);
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
  }, [tenantId, props]);

  return (
    <section
      data-testid="onboarding-manage-panel"
      aria-label="Manage existing products"
      className="rounded-md border border-sailcloth/40 bg-white p-4 flex flex-col gap-3"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-deep-charcoal/70">Tenant</span>
        <select
          data-testid="onboarding-manage-tenant-picker"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          className="rounded-md border border-sailcloth/50 px-3 py-2"
        >
          <option value="">Select tenant…</option>
          {props.tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      {products && products.length === 0 ? (
        <p data-testid="onboarding-manage-empty" className="text-sm text-deep-charcoal/60">
          This tenant has no registered products yet.
        </p>
      ) : null}

      {products && products.length > 0 ? (
        <ul data-testid="onboarding-products-list" className="flex flex-col gap-2">
          {products.map((p) => (
            <li
              key={p.id}
              data-testid={`onboarding-product-item-${p.id}`}
              className="flex items-center justify-between rounded-md border border-sailcloth/30 px-3 py-2 text-sm"
            >
              <div>
                <div className="font-semibold">{p.name}</div>
                <div className="text-xs text-deep-charcoal/60">
                  <code>{p.slug ?? p.id}</code>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid={`onboarding-rotate-${p.id}`}
                  onClick={async () => {
                    try {
                      const res = await props.rotateFn(p.id);
                      setRotateResult(res);
                      addToast({
                        variant: 'success',
                        message: `Rotated credential for ${p.slug ?? p.id}.`,
                      });
                    } catch (e) {
                      setErr((e as Error).message);
                    }
                  }}
                  className="rounded-md border border-primary-navy px-3 py-1 text-xs font-semibold text-primary-navy hover:bg-primary-navy/10"
                >
                  Rotate credential
                </button>
                <ConfirmDestructive
                  title="Revoke product?"
                  body={`Revoking '${p.slug ?? p.id}' immediately blocks new JWTs. Existing JWTs expire within 15 min.`}
                  confirmLabel="Yes, revoke"
                  requirePhrase="REVOKE"
                  onConfirm={async () => {
                    try {
                      const res = await props.revokeFn(p.id);
                      setRevokeResult(res);
                      addToast({
                        variant: 'success',
                        message: `Revoked ${p.slug ?? p.id}.`,
                      });
                    } catch (e) {
                      setErr((e as Error).message);
                      throw e;
                    }
                  }}
                  trigger={(open) => (
                    <button
                      type="button"
                      data-testid={`onboarding-revoke-${p.id}`}
                      onClick={open}
                      className="rounded-md border border-red-600 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
                    >
                      Revoke
                    </button>
                  )}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {rotateResult ? (
        <section
          role="alertdialog"
          data-testid="onboarding-rotate-reveal"
          className="rounded-md border border-emerald-400 bg-emerald-50 p-3 text-sm text-emerald-900"
        >
          <p className="font-semibold">
            New credential for <code>{rotateResult.slug}</code>. Copy now — this
            value will not be shown again. The old secret has already been invalidated.
          </p>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
            <dt className="font-semibold">client_id</dt>
            <dd><code>{rotateResult.client_id}</code></dd>
            <dt className="font-semibold">client_secret</dt>
            <dd data-testid="onboarding-rotate-secret"><code>{rotateResult.client_secret}</code></dd>
          </dl>
          <button
            type="button"
            data-testid="onboarding-rotate-dismiss"
            onClick={() => setRotateResult(null)}
            className="mt-2 rounded-md border border-emerald-700 bg-white px-3 py-1 text-xs font-semibold text-emerald-900"
          >
            Dismiss
          </button>
        </section>
      ) : null}

      {revokeResult ? (
        <p
          role="alert"
          data-testid="onboarding-revoke-confirmation"
          className="rounded-md border border-red-400 bg-red-50 p-3 text-sm text-red-900"
        >
          Revoked <code>{revokeResult.slug}</code>. Outstanding JWTs expire by{' '}
          {new Date(revokeResult.effective_hard_revoke_at).toLocaleString()}.
        </p>
      ) : null}

      {err ? (
        <p role="alert" data-testid="onboarding-manage-error" className="text-sm text-red-800">
          {err}
        </p>
      ) : null}
    </section>
  );
}

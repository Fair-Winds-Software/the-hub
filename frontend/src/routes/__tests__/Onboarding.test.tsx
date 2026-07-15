// Authorized by HUB-1822 (S5 of HUB-1787) — Onboarding wizard tests.
// Covers: tab switching, register flow with one-time credential reveal, submit
// validation, manage-existing rotation flow, revoke flow with phrase gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Onboarding from '../Onboarding';
import { useToastStore } from '../../stores/toastStore';

const TENANT_A = '00000000-0000-4000-8000-00000000eeaa';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000aaa';

function makeFetchers(overrides: Partial<React.ComponentProps<typeof Onboarding>['fetchers']> = {}) {
  return {
    listTenants: vi.fn().mockResolvedValue({
      tenants: [{ id: TENANT_A, name: 'Maverick Launch' }],
    }),
    registerProduct: vi.fn().mockResolvedValue({
      product_id: PRODUCT_ID,
      slug: 'contenthelm',
      name: 'ContentHelm',
      client_id: 'test-client-id',
      client_secret: 'test-secret',
    }),
    listProducts: vi.fn().mockResolvedValue({
      products: [
        { id: PRODUCT_ID, name: 'ContentHelm', slug: 'contenthelm' },
      ],
    }),
    rotateCredential: vi.fn().mockResolvedValue({
      product_id: PRODUCT_ID,
      slug: 'contenthelm',
      client_id: 'test-client-id',
      client_secret: 'rotated-secret',
    }),
    revokeProduct: vi.fn().mockResolvedValue({
      product_id: PRODUCT_ID,
      slug: 'contenthelm',
      active: false as const,
      effective_hard_revoke_at: '2026-07-15T21:00:00Z',
    }),
    ...overrides,
  };
}

beforeEach(() => {
  useToastStore.getState().clearAll();
});

afterEach(() => {
  cleanup();
});

describe('Onboarding — tab switching', () => {
  it('starts on the Register tab', async () => {
    const fetchers = makeFetchers();
    render(<Onboarding fetchers={fetchers} />);
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-register-panel')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('onboarding-manage-panel')).not.toBeInTheDocument();
  });

  it('switches to the Manage tab on click', async () => {
    const fetchers = makeFetchers();
    render(<Onboarding fetchers={fetchers} />);
    fireEvent.click(screen.getByTestId('onboarding-tab-manage'));
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-manage-panel')).toBeInTheDocument();
    });
  });
});

describe('Onboarding — register flow', () => {
  it('submit disabled until tenant + name + valid slug are entered', async () => {
    const fetchers = makeFetchers();
    render(<Onboarding fetchers={fetchers} />);
    await waitFor(() => screen.getByTestId('onboarding-register-panel'));
    const submit = screen.getByTestId('onboarding-register-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // Wait for tenants list to load so the select can be populated.
    await waitFor(() => {
      const picker = screen.getByTestId('onboarding-tenant-picker') as HTMLSelectElement;
      expect(picker.querySelectorAll('option').length).toBeGreaterThan(1);
    });

    fireEvent.change(screen.getByTestId('onboarding-tenant-picker'), {
      target: { value: TENANT_A },
    });
    fireEvent.change(screen.getByTestId('onboarding-name-input'), {
      target: { value: 'ContentHelm' },
    });
    fireEvent.change(screen.getByTestId('onboarding-slug-input'), {
      target: { value: 'contenthelm' },
    });
    expect((screen.getByTestId('onboarding-register-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('happy path: submits + shows one-time credential reveal', async () => {
    const fetchers = makeFetchers();
    render(<Onboarding fetchers={fetchers} />);
    await waitFor(() => {
      const picker = screen.getByTestId('onboarding-tenant-picker') as HTMLSelectElement;
      expect(picker.querySelectorAll('option').length).toBeGreaterThan(1);
    });
    fireEvent.change(screen.getByTestId('onboarding-tenant-picker'), {
      target: { value: TENANT_A },
    });
    fireEvent.change(screen.getByTestId('onboarding-name-input'), {
      target: { value: 'ContentHelm' },
    });
    fireEvent.change(screen.getByTestId('onboarding-slug-input'), {
      target: { value: 'contenthelm' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-register-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-credential-reveal')).toBeInTheDocument();
    });
    expect(fetchers.registerProduct).toHaveBeenCalledWith({
      tenant_id: TENANT_A,
      name: 'ContentHelm',
      slug: 'contenthelm',
      product_type: 'saas',
    });
    expect(screen.getByTestId('onboarding-reveal-client-secret').textContent).toContain(
      'test-secret',
    );
  });

  it('surfaces backend error in role=alert', async () => {
    const fetchers = makeFetchers({
      registerProduct: vi.fn().mockRejectedValue(new Error('slug already registered')),
    });
    render(<Onboarding fetchers={fetchers} />);
    await waitFor(() => {
      const picker = screen.getByTestId('onboarding-tenant-picker') as HTMLSelectElement;
      expect(picker.querySelectorAll('option').length).toBeGreaterThan(1);
    });
    fireEvent.change(screen.getByTestId('onboarding-tenant-picker'), {
      target: { value: TENANT_A },
    });
    fireEvent.change(screen.getByTestId('onboarding-name-input'), {
      target: { value: 'Existing' },
    });
    fireEvent.change(screen.getByTestId('onboarding-slug-input'), {
      target: { value: 'existing-slug' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-register-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-register-error').textContent).toContain(
        'slug already registered',
      );
    });
  });
});

describe('Onboarding — manage-existing flow', () => {
  it('picks a tenant → renders products list → rotate reveals new secret', async () => {
    const fetchers = makeFetchers();
    render(<Onboarding fetchers={fetchers} />);
    fireEvent.click(screen.getByTestId('onboarding-tab-manage'));
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-manage-tenant-picker')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('onboarding-manage-tenant-picker'), {
      target: { value: TENANT_A },
    });
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-products-list')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(`onboarding-rotate-${PRODUCT_ID}`));
    });
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-rotate-secret').textContent).toContain(
        'rotated-secret',
      );
    });
    expect(fetchers.rotateCredential).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it('revoke opens ConfirmDestructive; confirm requires typing REVOKE; then fires', async () => {
    const fetchers = makeFetchers();
    render(<Onboarding fetchers={fetchers} />);
    fireEvent.click(screen.getByTestId('onboarding-tab-manage'));
    await waitFor(() => screen.getByTestId('onboarding-manage-tenant-picker'));
    fireEvent.change(screen.getByTestId('onboarding-manage-tenant-picker'), {
      target: { value: TENANT_A },
    });
    await waitFor(() => screen.getByTestId(`onboarding-revoke-${PRODUCT_ID}`));
    fireEvent.click(screen.getByTestId(`onboarding-revoke-${PRODUCT_ID}`));
    await screen.findByRole('alertdialog');
    const confirmBtn = screen.getByRole('button', { name: /yes, revoke/i });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
    const phraseInput = await screen.findByRole('textbox');
    fireEvent.change(phraseInput, { target: { value: 'REVOKE' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /yes, revoke/i }));
    });
    await waitFor(() => {
      expect(fetchers.revokeProduct).toHaveBeenCalledWith(PRODUCT_ID);
    });
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-revoke-confirmation').textContent).toContain(
        'contenthelm',
      );
    });
  });

  it('empty tenant → empty state', async () => {
    const fetchers = makeFetchers({
      listProducts: vi.fn().mockResolvedValue({ products: [] }),
    });
    render(<Onboarding fetchers={fetchers} />);
    fireEvent.click(screen.getByTestId('onboarding-tab-manage'));
    await waitFor(() => screen.getByTestId('onboarding-manage-tenant-picker'));
    fireEvent.change(screen.getByTestId('onboarding-manage-tenant-picker'), {
      target: { value: TENANT_A },
    });
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-manage-empty')).toBeInTheDocument();
    });
  });
});

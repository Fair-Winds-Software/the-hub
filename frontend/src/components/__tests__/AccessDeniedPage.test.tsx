// Authorized by HUB-1609 (E-FE-3 S9) — AccessDeniedPage tests. Covers role=alert
// announcement, resource label render, back-link href + label customization,
// focus-on-mount behavior, and axe-core a11y.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter } from 'react-router-dom';
import { AccessDeniedPage } from '../AccessDeniedPage';

afterEach(() => {
  cleanup();
});

function renderPage(props: Partial<React.ComponentProps<typeof AccessDeniedPage>> = {}) {
  return render(
    <MemoryRouter>
      <AccessDeniedPage
        resourceLabel="this product"
        backTo="/console/products"
        backLabel="Back to products"
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('AccessDeniedPage (HUB-1609)', () => {
  it('renders role="alert" with the resource label in the heading', () => {
    renderPage();
    const alert = screen.getByRole('alert');
    expect(alert).toBe(screen.getByTestId('access-denied-page'));
    expect(screen.getByTestId('access-denied-heading').textContent).toMatch(
      /You don.?t have access to this product/i,
    );
  });

  it('renders the back link with the supplied href + label', () => {
    renderPage({
      backTo: '/console/dashboard',
      backLabel: 'Back to dashboard',
    });
    const link = screen.getByTestId('access-denied-back-link');
    expect(link).toHaveAttribute('href', '/console/dashboard');
    expect(link.textContent).toBe('Back to dashboard');
  });

  it('focus moves to the back link on mount so keyboard users have a target', () => {
    renderPage();
    expect(screen.getByTestId('access-denied-back-link')).toBe(
      document.activeElement,
    );
  });

  it('mentions ask Sammy / super_admin escalation guidance', () => {
    renderPage();
    expect(screen.getByTestId('access-denied-page').textContent).toMatch(
      /ask sammy/i,
    );
    expect(screen.getByTestId('access-denied-page').textContent).toMatch(
      /super_admin/,
    );
  });

  it('passes axe-core scan with zero violations', async () => {
    const { container } = renderPage();
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});

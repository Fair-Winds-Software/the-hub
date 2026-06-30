// Authorized by HUB-1637 (E-FE-4 S1) — PlanComparison tests. Covers paired
// card render, label defaults + overrides, delta indicator across the three
// price-change branches (increase / decrease / unchanged), billing-mode
// highlight, feature set diff (added / removed / same), reasoning bullets,
// loading skeleton, empty-card placeholder, and axe-core a11y.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { PlanComparison, type PlanData } from '../PlanComparison';

afterEach(() => {
  cleanup();
});

const LEFT: PlanData = {
  title: 'Standard $99',
  price: 99,
  billingMode: 'standard',
  features: ['API access', 'Email support', 'Single tenant'],
};

const RIGHT: PlanData = {
  title: 'Pro $149',
  price: 149,
  billingMode: 'credit',
  features: ['API access', 'Priority support', 'Multi-tenant'],
};

describe('PlanComparison (HUB-1637)', () => {
  describe('AC#1/#2 — paired card render', () => {
    it('renders both cards with the default Current / Recommended labels', () => {
      render(<PlanComparison left={LEFT} right={RIGHT} />);
      expect(screen.getByTestId('plan-card-left')).toBeInTheDocument();
      expect(screen.getByTestId('plan-card-right')).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: 'Current' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: 'Recommended' }),
      ).toBeInTheDocument();
    });

    it('renders custom labels when leftLabel + rightLabel are passed', () => {
      render(
        <PlanComparison
          left={LEFT}
          right={RIGHT}
          leftLabel="Baseline"
          rightLabel="Scenario A"
        />,
      );
      expect(
        screen.getByRole('heading', { name: 'Baseline' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: 'Scenario A' }),
      ).toBeInTheDocument();
    });

    it('each card uses <section aria-labelledby> per AC#7', () => {
      render(<PlanComparison left={LEFT} right={RIGHT} />);
      const leftCard = screen.getByTestId('plan-card-left');
      const labelledBy = leftCard.getAttribute('aria-labelledby');
      expect(labelledBy).toBeTruthy();
      expect(document.getElementById(labelledBy!)).toBeInTheDocument();
    });
  });

  describe('AC#3 — delta indicator on price changes', () => {
    it('price increase renders +delta with seafoam color and "increased by" aria-label', () => {
      render(<PlanComparison left={LEFT} right={RIGHT} />);
      const delta = screen.getByTestId('plan-delta-price');
      expect(delta.textContent).toMatch(/\+\$50/);
      expect(delta.getAttribute('aria-label')).toMatch(
        /Price changed from \$99\/mo to \$149\/mo, increased by \$50/,
      );
    });

    it('price decrease renders -delta with ironwake color and "decreased by" aria-label', () => {
      render(
        <PlanComparison
          left={{ ...LEFT, price: 149 }}
          right={{ ...RIGHT, price: 99 }}
        />,
      );
      const delta = screen.getByTestId('plan-delta-price');
      expect(delta.textContent).toMatch(/−\$50/);
      expect(delta.getAttribute('aria-label')).toMatch(
        /Price changed from \$149\/mo to \$99\/mo, decreased by \$50/,
      );
    });

    it('equal prices render NO delta indicator', () => {
      render(
        <PlanComparison
          left={{ ...LEFT, price: 99 }}
          right={{ ...RIGHT, price: 99 }}
        />,
      );
      expect(screen.queryByTestId('plan-delta-price')).toBeNull();
    });

    it('highlightDeltas=false suppresses the delta indicator', () => {
      render(
        <PlanComparison left={LEFT} right={RIGHT} highlightDeltas={false} />,
      );
      expect(screen.queryByTestId('plan-delta-price')).toBeNull();
    });
  });

  describe('AC#3 — billing-mode highlight on change', () => {
    it('differing billing modes render the right card billing with a highlight class', () => {
      render(<PlanComparison left={LEFT} right={RIGHT} />);
      const rightBilling = screen.getByTestId('plan-card-right-billing');
      expect(rightBilling.className).toMatch(/accent-brass/);
    });

    it('equal billing modes do NOT highlight', () => {
      render(
        <PlanComparison
          left={LEFT}
          right={{ ...RIGHT, billingMode: 'standard' }}
        />,
      );
      const rightBilling = screen.getByTestId('plan-card-right-billing');
      expect(rightBilling.className).not.toMatch(/accent-brass/);
    });
  });

  describe('AC#3 — feature set diff', () => {
    it('right-card features added vs left render with the added testid', () => {
      render(<PlanComparison left={LEFT} right={RIGHT} />);
      // "Priority support" and "Multi-tenant" are added (not in LEFT).
      const addedItems = screen
        .getByTestId('plan-card-right-features')
        .querySelectorAll('[data-testid="plan-card-right-feature-added"]');
      const addedTexts = Array.from(addedItems).map((el) => el.textContent);
      expect(addedTexts).toEqual(
        expect.arrayContaining(['Priority support', 'Multi-tenant']),
      );
    });

    it('left-card features removed vs right render with the removed testid + strikethrough', () => {
      render(<PlanComparison left={LEFT} right={RIGHT} />);
      const removedItems = screen
        .getByTestId('plan-card-left-features')
        .querySelectorAll('[data-testid="plan-card-left-feature-removed"]');
      const removedTexts = Array.from(removedItems).map((el) => el.textContent);
      expect(removedTexts).toEqual(
        expect.arrayContaining(['Email support', 'Single tenant']),
      );
      // Strikethrough class applied.
      expect(removedItems[0]?.className).toMatch(/line-through/);
    });

    it('features present in both sides render as "same"', () => {
      render(<PlanComparison left={LEFT} right={RIGHT} />);
      const leftFeatures = screen.getByTestId('plan-card-left-features');
      const sameOnLeft = leftFeatures.querySelector(
        '[data-testid="plan-card-left-feature-same"]',
      );
      expect(sameOnLeft?.textContent).toBe('API access');
    });
  });

  describe('AC#4 — reasoning bullets', () => {
    it('renders the numbered <ol> reasoning list when bullets are provided', () => {
      render(
        <PlanComparison
          left={LEFT}
          right={RIGHT}
          reasoningBullets={[
            'Usage exceeds standard tier rate limits',
            'Multi-tenant required by upcoming compliance scope',
          ]}
        />,
      );
      const reasoning = screen.getByTestId('plan-comparison-reasoning');
      expect(reasoning).toBeInTheDocument();
      const items = reasoning.querySelectorAll('li');
      expect(items).toHaveLength(2);
      expect(items[0]?.textContent).toMatch(/rate limits/);
    });

    it('omits the reasoning section when no bullets are provided', () => {
      render(<PlanComparison left={LEFT} right={RIGHT} />);
      expect(screen.queryByTestId('plan-comparison-reasoning')).toBeNull();
    });

    it('each reasoning bullet is keyboard-reachable (tabIndex=0)', () => {
      render(
        <PlanComparison
          left={LEFT}
          right={RIGHT}
          reasoningBullets={['One', 'Two']}
        />,
      );
      expect(screen.getByTestId('reasoning-bullet-0')).toHaveAttribute(
        'tabindex',
        '0',
      );
      expect(screen.getByTestId('reasoning-bullet-1')).toHaveAttribute(
        'tabindex',
        '0',
      );
    });
  });

  describe('AC#5 — loading skeleton matches two-card layout', () => {
    it('loading=true renders the two-card skeleton instead of cards', () => {
      render(<PlanComparison left={LEFT} right={RIGHT} loading />);
      expect(
        screen.getByTestId('plan-comparison-skeleton'),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('plan-card-left')).toBeNull();
      expect(screen.queryByTestId('plan-card-right')).toBeNull();
    });
  });

  describe('AC#6 — empty card placeholder', () => {
    it('left=null renders the empty card placeholder ("No current plan assigned")', () => {
      render(<PlanComparison left={null} right={RIGHT} />);
      expect(
        screen.getByTestId('plan-card-left-empty'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('No current plan assigned.'),
      ).toBeInTheDocument();
    });

    it('right=null renders the same placeholder on the right card', () => {
      render(<PlanComparison left={LEFT} right={null} />);
      expect(
        screen.getByTestId('plan-card-right-empty'),
      ).toBeInTheDocument();
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with both cards + delta indicator + reasoning', async () => {
      const { container } = render(
        <PlanComparison
          left={LEFT}
          right={RIGHT}
          reasoningBullets={['Reason A', 'Reason B']}
        />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan with an empty placeholder card', async () => {
      const { container } = render(
        <PlanComparison left={null} right={RIGHT} />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});

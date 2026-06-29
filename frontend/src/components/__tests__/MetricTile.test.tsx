// Authorized by HUB-1620 (E-FE-8 S1) — MetricTile tests. Covers value rendering,
// triple-encoded verdict (color + icon + text), drift badge, empty/loading/click
// variants, keyboard activation, aria-label composition, and axe-core a11y.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MetricTile } from '../MetricTile';

afterEach(() => {
  cleanup();
});

describe('MetricTile (HUB-1620)', () => {
  describe('value + title rendering', () => {
    it('renders title and numeric value', () => {
      render(<MetricTile title="Compliance posture" value={92} />);
      expect(screen.getByTestId('metric-tile-title').textContent).toBe(
        'Compliance posture',
      );
      expect(screen.getByTestId('metric-tile-value').textContent).toBe('92');
    });

    it('renders string values verbatim', () => {
      render(<MetricTile title="Status" value="OK" />);
      expect(screen.getByTestId('metric-tile-value').textContent).toBe('OK');
    });

    it('renders unit suffix next to the value', () => {
      render(<MetricTile title="Latency" value={142} unit="ms" />);
      expect(screen.getByTestId('metric-tile-unit').textContent).toBe('ms');
    });
  });

  describe('AC#4 — empty state', () => {
    it('null value renders em-dash with aria-label="No data"', () => {
      render(<MetricTile title="Coverage" value={null} />);
      const empty = screen.getByTestId('metric-tile-empty-value');
      expect(empty.textContent).toBe('—');
      expect(empty).toHaveAttribute('aria-label', 'No data');
    });

    it('undefined value renders em-dash', () => {
      render(<MetricTile title="Coverage" value={undefined} />);
      expect(screen.getByTestId('metric-tile-empty-value')).toBeInTheDocument();
    });

    it('empty string renders em-dash', () => {
      render(<MetricTile title="Coverage" value="" />);
      expect(screen.getByTestId('metric-tile-empty-value')).toBeInTheDocument();
    });
  });

  describe('AC#3 — verdict triple-encoded (color + icon + text)', () => {
    it.each(['success', 'warning', 'error', 'neutral'] as const)(
      'verdict=%s renders icon + text label',
      (verdict) => {
        render(<MetricTile title="t" value={1} verdict={verdict} />);
        expect(screen.getByTestId(`verdict-glyph-${verdict}`)).toBeInTheDocument();
        expect(
          screen.getByTestId(`metric-tile-verdict-${verdict}`),
        ).toBeInTheDocument();
      },
    );

    it('defaults to neutral when verdict not provided', () => {
      render(<MetricTile title="t" value={1} />);
      expect(screen.getByTestId('verdict-glyph-neutral')).toBeInTheDocument();
      expect(
        screen.getByTestId('metric-tile-verdict-neutral'),
      ).toBeInTheDocument();
    });

    it('aria-label includes title + value + unit + verdict semantics', () => {
      render(
        <MetricTile
          title="Compliance posture for ContentHelm"
          value={92}
          unit="%"
          verdict="success"
        />,
      );
      expect(
        screen.getByLabelText(
          'Compliance posture for ContentHelm: 92 %, healthy',
        ),
      ).toBeInTheDocument();
    });

    it('aria-label for empty value reports "no data"', () => {
      render(<MetricTile title="Coverage" value={null} verdict="error" />);
      expect(screen.getByLabelText('Coverage: no data')).toBeInTheDocument();
    });

    it('custom ariaLabel overrides composed default', () => {
      render(
        <MetricTile
          title="t"
          value={1}
          verdict="success"
          ariaLabel="Custom label"
        />,
      );
      expect(screen.getByLabelText('Custom label')).toBeInTheDocument();
    });
  });

  describe('AC#4 — drift badge in the corner', () => {
    it.each(['up', 'down', 'flat'] as const)(
      'drift=%s renders the badge with semantic label',
      (drift) => {
        render(
          <MetricTile title="t" value={1} drift={drift} driftLabel="+5" />,
        );
        expect(screen.getByTestId(`drift-badge-${drift}`)).toBeInTheDocument();
      },
    );

    it('drift badge aria-label combines direction + numeric label', () => {
      render(<MetricTile title="t" value={1} drift="up" driftLabel="+5" />);
      expect(
        screen.getByLabelText('trending up: +5'),
      ).toBeInTheDocument();
    });
  });

  describe('AC#5 — onClick makes the tile clickable', () => {
    it('role=button + tabindex=0 + click handler invoked', () => {
      const onClick = vi.fn();
      render(<MetricTile title="t" value={1} onClick={onClick} />);
      const tile = screen.getByTestId('metric-tile');
      expect(tile).toHaveAttribute('role', 'button');
      expect(tile).toHaveAttribute('tabindex', '0');
      fireEvent.click(tile);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('Enter activates onClick', () => {
      const onClick = vi.fn();
      render(<MetricTile title="t" value={1} onClick={onClick} />);
      fireEvent.keyDown(screen.getByTestId('metric-tile'), { key: 'Enter' });
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('Space activates onClick', () => {
      const onClick = vi.fn();
      render(<MetricTile title="t" value={1} onClick={onClick} />);
      fireEvent.keyDown(screen.getByTestId('metric-tile'), { key: ' ' });
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('non-activating keys do NOT fire onClick', () => {
      const onClick = vi.fn();
      render(<MetricTile title="t" value={1} onClick={onClick} />);
      fireEvent.keyDown(screen.getByTestId('metric-tile'), { key: 'a' });
      expect(onClick).not.toHaveBeenCalled();
    });

    it('without onClick, the tile is role=group (not button) and not tabbable', () => {
      render(<MetricTile title="t" value={1} />);
      const tile = screen.getByTestId('metric-tile');
      expect(tile).toHaveAttribute('role', 'group');
      expect(tile).not.toHaveAttribute('tabindex');
    });
  });

  describe('AC#6 — loading skeleton matches final dimensions', () => {
    it('renders the skeleton instead of content when loading=true', () => {
      render(<MetricTile title="t" value={1} loading />);
      expect(screen.getByTestId('metric-tile-skeleton')).toBeInTheDocument();
      expect(screen.queryByTestId('metric-tile-value')).toBeNull();
    });

    it('skeleton uses the same h-[160px] wrapper as the loaded tile (CLS<0.1)', () => {
      render(<MetricTile title="t" value={1} loading />);
      const skel = screen.getByTestId('metric-tile-skeleton');
      expect(skel.className).toMatch(/h-\[160px\]/);
    });
  });

  describe('footer slot', () => {
    it('renders footer node when provided', () => {
      render(
        <MetricTile
          title="t"
          value={1}
          footer={<span data-testid="custom-footer">vs. 7d</span>}
        />,
      );
      expect(screen.getByTestId('metric-tile-footer')).toBeInTheDocument();
      expect(screen.getByTestId('custom-footer')).toBeInTheDocument();
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan for a non-clickable success tile', async () => {
      const { container } = render(
        <MetricTile title="Compliance" value={92} verdict="success" />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan for a clickable tile with drift badge', async () => {
      const { container } = render(
        <MetricTile
          title="Compliance"
          value={92}
          verdict="success"
          drift="up"
          driftLabel="+5"
          onClick={() => {}}
        />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan for an empty-value tile', async () => {
      const { container } = render(
        <MetricTile title="Coverage" value={null} verdict="warning" />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});

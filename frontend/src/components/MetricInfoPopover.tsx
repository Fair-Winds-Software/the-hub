import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';

export interface MetricInfoContent {
  definition: string;
  formula: string;
  source: string;
  verdictLegend?: Array<{ label: string; meaning: string }>;
}

const DEFAULT_VERDICT_LEGEND: Array<{ label: string; meaning: string }> = [
  { label: 'healthy', meaning: 'value is within the healthy band for this metric' },
  { label: 'warning', meaning: 'value is drifting toward a concerning threshold' },
  { label: 'error', meaning: 'value has crossed a threshold that needs attention' },
  {
    label: 'neutral',
    meaning:
      'no threshold logic has been wired for this tile yet — the number is shown without a judgement',
  },
];

export function MetricInfoPopover({
  title,
  content,
}: {
  title: string;
  content: MetricInfoContent;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const escHandler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escHandler);
    };
  }, [open]);

  const legend = content.verdictLegend ?? DEFAULT_VERDICT_LEGEND;

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={`What is ${title}?`}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex items-center justify-center rounded-full p-0.5 text-deep-charcoal/50 hover:text-primary-navy hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
      >
        <Info size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={`${title} definition`}
          className="absolute left-0 top-6 z-30 w-72 rounded-md border border-deep-charcoal/15 bg-sailcloth p-3 shadow-lg font-body text-xs text-deep-charcoal"
        >
          <p className="font-heading text-sm text-primary-navy mb-2">{title}</p>
          <dl className="space-y-2">
            <div>
              <dt className="font-semibold text-deep-charcoal/70">Definition</dt>
              <dd>{content.definition}</dd>
            </div>
            <div>
              <dt className="font-semibold text-deep-charcoal/70">Formula</dt>
              <dd className="font-mono text-[11px]">{content.formula}</dd>
            </div>
            <div>
              <dt className="font-semibold text-deep-charcoal/70">Source</dt>
              <dd>{content.source}</dd>
            </div>
            <div>
              <dt className="font-semibold text-deep-charcoal/70">Verdict legend</dt>
              <dd>
                <ul className="mt-1 space-y-0.5">
                  {legend.map((v) => (
                    <li key={v.label}>
                      <span className="font-semibold">{v.label}</span> — {v.meaning}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}

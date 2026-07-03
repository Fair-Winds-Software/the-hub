// Authorized by HUB-1672 (E-FE-11 S4) — sticky caveat banner. FR-007
// requires the "what-if estimate, not prediction" wording to be visible
// above the results, not collapsed, not below the fold, not styled muted.
// FR-008 adds a tooltip pointing to the v0.2 HUB-1547 advanced engine.
//
// Copy pattern: primary line is the operator-legible warning ("What-if
// estimate ... Not a prediction ..."); secondary line surfaces the
// BE-provided disclaimer verbatim so this UI stays honest when the BE
// tightens or loosens the disclaimer (single source of truth on the BE
// per HUB-1598's SCENARIO_DISCLAIMER const).
//
// Sticky positioning uses `sticky top-0` — works inside a scrolling
// container (the main-content area) so long result tables don't hide
// the caveat during scroll.

interface PricingScenarioCaveatProps {
  disclaimer: string;
}

const V02_TOOLTIP =
  'Advanced scenario engine (historical-data-driven, sensitivity matrix, saved scenarios) ships in v0.2 — HUB-1547.';

export function PricingScenarioCaveat({
  disclaimer,
}: PricingScenarioCaveatProps): React.ReactElement {
  return (
    <div
      role="alert"
      data-testid="pricing-scenario-caveat"
      title={V02_TOOLTIP}
      aria-label={`What-if estimate warning. ${V02_TOOLTIP}`}
      className="sticky top-0 z-10 rounded-md border border-accent-brass/40 bg-accent-brass/10 p-3 text-sm font-body text-deep-charcoal"
    >
      <p className="font-medium">
        <span aria-hidden="true">⚠ </span>
        What-if estimate based on a constant-elasticity model. Not a
        prediction. Real outcomes vary.
      </p>
      <p
        data-testid="pricing-scenario-caveat-disclaimer"
        className="mt-1 text-xs text-deep-charcoal/70"
      >
        {disclaimer}
      </p>
    </div>
  );
}

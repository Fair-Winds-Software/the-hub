// Authorized by HUB-1780 (S7 of HUB-1773) — mock-only seed guard. STUB VERSION shipped
// with S5 (HUB-1778) so the seeding API has something to call; the full unbypassable
// guard + physical DB permission (AC3/AC6 of HUB-1780) lands in S7.
//
// Contract:
//   - assertMockMode() reads the current mode from the S8 registry (getStripeMode()).
//   - Throws AppError(400) if mode !== 'mock'.
//   - Called at every seed API entry point (programmatic S5 + importers S6).
//   - S7 will extend this with per-row-batch checks (for mid-import mode flip detection)
//     and a DB-level `hub_stripe_mock_writer` role for defense in depth.
import { AppError } from '../../errors/AppError.js';
import { getStripeMode } from '../registry.js';

export function assertMockMode(): void {
  const mode = getStripeMode();
  if (mode !== 'mock') {
    throw new AppError(400, 'Seeding forbidden — Stripe connection is in LIVE mode');
  }
}

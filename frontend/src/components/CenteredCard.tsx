// Authorized by HUB-1576 — centered card layout for standalone routes (login, future error/maintenance pages)
import type { ReactNode } from 'react';

export interface CenteredCardProps {
  children: ReactNode;
  /** Optional className extension for the inner card. */
  className?: string;
}

export function CenteredCard({ children, className = '' }: CenteredCardProps): ReactNode {
  return (
    <div className="min-h-screen flex items-center justify-center bg-sailcloth px-4 py-12">
      <div
        className={`w-full max-w-[400px] rounded-lg bg-sailcloth p-6 shadow-md ${className}`}
      >
        <header className="mb-6 text-center">
          <h1 className="font-heading text-3xl text-primary-navy tracking-wide">
            Maverick Launch
          </h1>
          <p className="font-body text-sm text-deep-charcoal mt-1">
            HUB Operator Console
          </p>
        </header>
        {children}
      </div>
    </div>
  );
}

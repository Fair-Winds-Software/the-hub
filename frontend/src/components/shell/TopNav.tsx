// Authorized by HUB-1577 — Top nav for the Console Shell (S8 AC#2).
// 56px tall; wordmark left; operator identity + role badge + logout button right.
// HUB-1579 will replace the placeholder logout handler with real clearSession + nav.
import { LogOut } from 'lucide-react';
import { useOperator } from '../../stores/sessionStore';

function truncateName(fullName: string): string {
  if (fullName.length <= 24) return fullName;
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return fullName.slice(0, 24);
  const first = parts[0];
  const lastInitial = parts[parts.length - 1]?.charAt(0) ?? '';
  return `${first} ${lastInitial}.`;
}

interface TopNavProps {
  /** Placeholder until HUB-1579 wires the real logout flow. */
  onLogout?: () => void;
}

export function TopNav({ onLogout }: TopNavProps): React.ReactElement {
  const operator = useOperator();
  const isSuper = operator?.role === 'super_admin';

  return (
    <header className="h-14 flex items-center justify-between px-6 bg-primary-navy text-sailcloth shadow-md">
      <div>
        <span className="font-heading text-lg tracking-wide">Maverick Launch</span>
        <span className="font-body text-xs ml-2 text-sailcloth/70 hidden sm:inline">
          HUB Operator Console
        </span>
      </div>
      {operator && (
        <div className="flex items-center gap-3">
          <span className="font-body text-sm" data-testid="operator-name">
            {truncateName(operator.name)}
          </span>
          <span
            aria-label={`Role: ${operator.role}`}
            className={`font-mono text-xs uppercase px-2 py-0.5 rounded-md ${
              isSuper
                ? 'bg-accent-brass text-primary-navy'
                : 'bg-sailcloth/20 text-sailcloth'
            }`}
            data-testid="role-badge"
          >
            {operator.role.replace('_', ' ')}
          </span>
          <button
            type="button"
            onClick={onLogout}
            aria-label="Log out"
            className="p-2 rounded-md hover:bg-sailcloth/10 focus:outline-none focus:ring-2 focus:ring-sailcloth"
          >
            <LogOut size={18} aria-hidden="true" />
          </button>
        </div>
      )}
    </header>
  );
}

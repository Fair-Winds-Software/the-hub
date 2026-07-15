// Authorized by HUB-1577 — Top nav for the Console Shell (S8 AC#2).
// Authorized by HUB-1579 — wires real logout flow per R1 D-HUB-SCOPE-028 + D-HUB-SCOPE-050.
// 56px tall; wordmark left; operator identity + role badge + Sign Out button right.
import { LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useOperator } from '../../stores/sessionStore';
import { performLogout } from '../../lib/logout';

function truncateName(fullName: string): string {
  if (fullName.length <= 24) return fullName;
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return fullName.slice(0, 24);
  const first = parts[0];
  const lastInitial = parts[parts.length - 1]?.charAt(0) ?? '';
  return `${first} ${lastInitial}.`;
}

export function TopNav(): React.ReactElement {
  const operator = useOperator();
  const navigate = useNavigate();
  const isSuper = operator?.role === 'super_admin';

  const handleLogout = (): void => {
    // Fire-and-forget per R1 AC#1 — performLogout clears local state synchronously,
    // then the BE call runs in the background (failures enqueue in sessionStorage).
    void performLogout({ navigate });
  };

  return (
    <header className="h-14 flex items-center justify-between px-6 bg-primary-navy text-sailcloth shadow-md">
      <div>
        <span className="font-heading text-lg tracking-wide">The HUB</span>
      </div>
      {operator && (
        <div className="flex items-center gap-3">
          <span className="font-body text-sm" data-testid="operator-name">
            {truncateName(operator.name)}
          </span>
          <span
            aria-label={`Role: ${operator.role}`}
            // HUB-1581: brass-as-background fails WCAG 2.1 AA against any text color at 12px
            // normal-weight (max ~3.94:1 vs white; ~3.63:1 vs navy). Use navy bg + sailcloth
            // text (~12:1) with a brass border so the badge still communicates the
            // "super admin" prestige association.
            className={`font-mono text-xs uppercase px-2 py-0.5 rounded-md ${
              isSuper
                ? 'bg-primary-navy text-sailcloth border border-accent-brass'
                : 'bg-sailcloth/20 text-sailcloth'
            }`}
            data-testid="role-badge"
          >
            {operator.role.replace('_', ' ')}
          </span>
          <button
            type="button"
            onClick={handleLogout}
            aria-label="Sign Out"
            data-testid="logout-button"
            className="flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-sailcloth/10 focus:outline-none focus:ring-2 focus:ring-sailcloth font-body text-sm"
          >
            <LogOut size={16} aria-hidden="true" />
            <span className="hidden lg:inline">Sign Out</span>
          </button>
        </div>
      )}
    </header>
  );
}

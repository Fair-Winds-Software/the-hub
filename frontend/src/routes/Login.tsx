// Authorized by HUB-1576 — /console/login form + UX (S7 of HUB-1555); replaces HUB-1569 placeholder
// Consumes: HUB-1571 design tokens; HUB-1572 sessionStore.setSession + useIsAuthenticated;
// HUB-1573 apiClient.post + ApiError/SessionExpiredError; HUB-1577 will own the /console/dashboard
// route this story redirects to (currently a placeholder in App.tsx per D-HUB-SCOPE-027).
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiClient } from '../lib/api';
import { ApiError } from '../lib/errors';
import { useSessionStore, useIsAuthenticated, type SessionPayload } from '../stores/sessionStore';
import { CenteredCard } from '../components/CenteredCard';

interface ValidationErrors {
  email?: string;
  password?: string;
}

type ServerError = {
  code?: string;
  message: string;
};

function validate(email: string, password: string): ValidationErrors {
  const errors: ValidationErrors = {};
  if (!email.trim()) errors.email = 'Enter your email to continue.';
  if (!password) errors.password = 'Enter your password to continue.';
  return errors;
}

export default function Login(): React.ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const isAuthenticated = useIsAuthenticated();

  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  const emailErrorId = useId();
  const passwordErrorId = useId();
  const serverErrorId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});
  const [serverError, setServerError] = useState<ServerError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // AC#9: already-authenticated → redirect immediately on mount.
  useEffect(() => {
    if (isAuthenticated) {
      const target = (location.state as { from?: string } | null)?.from ?? '/console/dashboard';
      navigate(target, { replace: true });
    }
  }, [isAuthenticated, location.state, navigate]);

  // Autofocus email on mount (lint-banned via autoFocus prop; ref-based per HUB-1575 precedent).
  useEffect(() => {
    if (!isAuthenticated) {
      emailInputRef.current?.focus();
    }
  }, [isAuthenticated]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      setServerError(null);

      // AC#3: client-side validation; do NOT call API on empty fields.
      const errors = validate(email, password);
      setValidationErrors(errors);
      if (errors.email) {
        emailInputRef.current?.focus();
        return;
      }
      if (errors.password) {
        passwordInputRef.current?.focus();
        return;
      }

      setSubmitting(true);
      try {
        const payload = await apiClient.post<SessionPayload>(
          '/api/v1/admin/auth/login',
          { email: email.trim(), password },
        );
        useSessionStore.getState().setSession(payload);
        const target =
          (location.state as { from?: string } | null)?.from ?? '/console/dashboard';
        navigate(target, { replace: true });
      } catch (err) {
        // AC#7: 400/401 → inline server error + clear password + preserve email + re-enable
        // AC#8: network error → generic message + re-enable
        if (err instanceof ApiError) {
          setServerError({
            code: err.status === 401 ? 'AUTH_INVALID_CREDENTIALS' : `HTTP_${err.status}`,
            message: err.message || 'Login failed. Please check your credentials.',
          });
        } else {
          setServerError({
            message: 'Unable to reach the server. Check your connection and try again.',
          });
        }
        setPassword('');
        passwordInputRef.current?.focus();
      } finally {
        setSubmitting(false);
      }
    },
    [email, password, location.state, navigate],
  );

  return (
    <CenteredCard>
      <form onSubmit={handleSubmit} noValidate>
        <div className="mb-4">
          <label htmlFor="email" className="block text-sm text-deep-charcoal mb-1">
            Email
          </label>
          <input
            ref={emailInputRef}
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            aria-invalid={!!validationErrors.email}
            aria-describedby={validationErrors.email ? emailErrorId : undefined}
            className="block w-full rounded-md border border-deep-charcoal/30 px-3 py-2 text-deep-charcoal focus:outline-none focus:ring-2 focus:ring-primary-navy disabled:bg-deep-charcoal/5"
          />
          {validationErrors.email && (
            <p
              id={emailErrorId}
              role="alert"
              className="mt-1 text-sm text-ironwake"
            >
              {validationErrors.email}
            </p>
          )}
        </div>

        <div className="mb-4">
          <label htmlFor="password" className="block text-sm text-deep-charcoal mb-1">
            Password
          </label>
          <input
            ref={passwordInputRef}
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            aria-invalid={!!validationErrors.password}
            aria-describedby={validationErrors.password ? passwordErrorId : undefined}
            className="block w-full rounded-md border border-deep-charcoal/30 px-3 py-2 text-deep-charcoal focus:outline-none focus:ring-2 focus:ring-primary-navy disabled:bg-deep-charcoal/5"
          />
          {validationErrors.password && (
            <p
              id={passwordErrorId}
              role="alert"
              className="mt-1 text-sm text-ironwake"
            >
              {validationErrors.password}
            </p>
          )}
        </div>

        {serverError && (
          <div
            id={serverErrorId}
            role="alert"
            aria-live="polite"
            className="mb-4 rounded-md bg-ironwake/10 border border-ironwake/30 px-3 py-2 text-sm text-ironwake motion-reduce:transition-none transition-opacity duration-150"
          >
            {serverError.code && (
              <span className="font-mono text-xs uppercase mr-2">[{serverError.code}]</span>
            )}
            {serverError.message}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-primary-navy px-4 py-2 text-sailcloth font-body focus:outline-none focus:ring-2 focus:ring-primary-navy hover:bg-primary-navy/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? (
            <span aria-live="polite">
              <span aria-hidden="true" className="inline-block animate-spin mr-2">&#9696;</span>
              Signing in&hellip;
            </span>
          ) : (
            'Sign In'
          )}
        </button>
      </form>
    </CenteredCard>
  );
}

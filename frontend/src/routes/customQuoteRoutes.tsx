// Authorized by HUB-1737 + HUB-1738 + HUB-1739 (E-V2-PP-2 S8/S9/S10, HUB-1726, HUB-1701) —
// Route wrappers that read URL search params + session state and pass them to the
// underlying page components (CustomQuotes / NewCustomQuote / CustomQuoteDetail).
// Kept separate from the pages so the pages remain unit-testable with plain props.

import { useSearchParams } from 'react-router-dom';
import { CustomQuotes } from './CustomQuotes';
import NewCustomQuote from './NewCustomQuote';
import CustomQuoteDetail from './CustomQuoteDetail';
import { useOperator } from '../stores/sessionStore';

function MissingParam({ name }: { name: string }): React.ReactElement {
  return (
    <section className="mx-auto max-w-3xl p-4">
      <p role="alert" className="text-sm text-error-crimson">
        Missing required URL parameter: <code>{name}</code>.
      </p>
    </section>
  );
}

export function CustomQuotesListRoute(): React.ReactElement {
  const [params] = useSearchParams();
  const tenantId = params.get('tenant_id');
  if (!tenantId) return <MissingParam name="tenant_id" />;
  return <CustomQuotes tenantId={tenantId} />;
}

export function NewCustomQuoteRoute(): React.ReactElement {
  const [params] = useSearchParams();
  const tenantId = params.get('tenant_id');
  const productId = params.get('product_id');
  if (!tenantId) return <MissingParam name="tenant_id" />;
  if (!productId) return <MissingParam name="product_id" />;
  return <NewCustomQuote tenantId={tenantId} productId={productId} />;
}

export function CustomQuoteDetailRoute(): React.ReactElement {
  const operator = useOperator();
  const operatorId = operator?.id ?? '';
  return <CustomQuoteDetail currentOperatorId={operatorId} />;
}

import { useLocation } from 'react-router-dom';

export default function NotFound(): React.ReactElement {
  const location = useLocation();
  return (
    <div className="p-8">
      <h1 className="font-heading text-2xl text-primary-navy mb-2">
        Nothing here yet
      </h1>
      <p className="font-body text-sm text-deep-charcoal">
        <code className="font-mono">{location.pathname}</code> hasn't been built.
      </p>
    </div>
  );
}

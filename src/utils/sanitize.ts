// Authorized by HUB-147 — PII scrubber; strips sensitive keys before logging job payloads
const PII_KEYS = new Set([
  'tenantId',
  'email',
  'secret',
  'token',
  'password',
  'apiKey',
  'client_secret',
  'jwt',
]);

export function sanitizePayload(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizePayload);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[key] = PII_KEYS.has(key) ? '[redacted]' : sanitizePayload(value);
  }
  return result;
}

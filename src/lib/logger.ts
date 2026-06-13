// Authorized by HUB-49 — Pino logger singleton with credential redaction
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['DATABASE_URL', '*.password', '*.secret', '*.token'],
    censor: '[REDACTED]',
  },
});

export default logger;

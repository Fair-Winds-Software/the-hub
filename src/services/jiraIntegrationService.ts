// Authorized by HUB-1593 (E-BE-1 S10, CR-1) — jiraIntegrationService: per-product ticket
// counts from Atlassian Cloud REST v3 with Redis cache + graceful degradation.
//
// Auth: Basic <base64("email:token")> per D-HUB-SCOPE-029 (NOT Bearer — Bearer is Server/DC).
// JQL: project = "<key>" AND status in ("To Do","In Progress") AND type in (Bug, "Change Request")
// Cache: success 900s · 429 60s · 5xx 60s · 401/403 15s (R1 FIX#1; admin clearAuthCache to retry)
//        · product_not_mapped + token_missing NOT cached.
//
// Token + workspace URL never logged — only counts make it into log lines.
import { getRedisClient } from '../redis/client.js';
import { getSetting } from './adminSettings.js';
import logger from '../lib/logger.js';

const SUCCESS_TTL_SEC = 900; // 15 minutes
const TRANSIENT_TTL_SEC = 60;
const AUTH_FAILURE_TTL_SEC = 15;

const TICKETS_KEY_PREFIX = 'jira:tickets:';
const AUTH_FAILURE_KEY = 'jira:auth-failure';

const MAPPING_KEY = 'jira_project_key_by_product';

export type JiraFailureReason =
  | 'rate_limited'
  | 'auth_failed'
  | 'upstream_unavailable'
  | 'token_missing'
  | 'product_not_mapped';

export type JiraTicketsResponse =
  | { available: true; openCRs: number; openBugs: number; lastSyncedAt: string }
  | { available: false; reason: JiraFailureReason };

/**
 * HUB-1593 (CR-1): canonical cache key for a product's ticket counts. Exported so the
 * HUB-1582 webhook write-through path (HUB-1583) can write directly to the same key
 * without re-deriving the shape.
 */
export function getCacheKey(productKey: string): string {
  return `${TICKETS_KEY_PREFIX}${productKey}`;
}

/**
 * Admin recovery endpoint after a token rotation: clears the auth-failure marker so the
 * next request retries against Atlassian instead of returning the cached `auth_failed`
 * stub. Per R1 FIX#1.
 */
export async function clearAuthCache(): Promise<void> {
  try {
    await getRedisClient().del(AUTH_FAILURE_KEY);
  } catch (err) {
    logger.warn({ err }, 'jira.clearAuthCache: Redis DEL failed (non-fatal)');
  }
}

function buildBasicAuthHeader(): string | null {
  const email = process.env.JIRA_SERVICE_EMAIL;
  const token = process.env.JIRA_SERVICE_TOKEN;
  if (!email || !token) return null;
  const encoded = Buffer.from(`${email}:${token}`).toString('base64');
  return `Basic ${encoded}`;
}

function buildJqlUrl(projectKey: string): string {
  const workspace = process.env.JIRA_WORKSPACE_URL!;
  const base = workspace.replace(/\/+$/, '');
  const jql = `project = "${projectKey}" AND status in ("To Do","In Progress") AND type in (Bug, "Change Request")`;
  const params = new URLSearchParams({
    jql,
    fields: 'issuetype,status',
    maxResults: '100',
  });
  return `${base}/rest/api/3/search/jql?${params.toString()}`;
}

interface AtlassianIssue {
  fields?: {
    issuetype?: { name?: string } | null;
  };
}

interface AtlassianSearchResponse {
  issues?: AtlassianIssue[];
}

function countByType(payload: AtlassianSearchResponse): { openCRs: number; openBugs: number } {
  let openCRs = 0;
  let openBugs = 0;
  for (const issue of payload.issues ?? []) {
    const typeName = issue.fields?.issuetype?.name?.toLowerCase() ?? '';
    if (typeName === 'bug') openBugs++;
    else if (typeName === 'change request') openCRs++;
  }
  return { openCRs, openBugs };
}

async function readCachedTickets(productKey: string): Promise<JiraTicketsResponse | null> {
  try {
    const raw = await getRedisClient().get(getCacheKey(productKey));
    if (!raw) return null;
    return JSON.parse(raw) as JiraTicketsResponse;
  } catch (err) {
    logger.warn({ err, productKey }, 'jira.readCachedTickets: Redis GET failed');
    return null;
  }
}

async function writeCachedTickets(
  productKey: string,
  payload: JiraTicketsResponse,
  ttlSec: number,
): Promise<void> {
  try {
    await getRedisClient().set(getCacheKey(productKey), JSON.stringify(payload), 'EX', ttlSec);
  } catch (err) {
    logger.warn({ err, productKey }, 'jira.writeCachedTickets: Redis SETEX failed');
  }
}

async function readAuthFailureCache(): Promise<JiraTicketsResponse | null> {
  try {
    const raw = await getRedisClient().get(AUTH_FAILURE_KEY);
    if (!raw) return null;
    return { available: false, reason: 'auth_failed' };
  } catch {
    return null;
  }
}

async function writeAuthFailureCache(): Promise<void> {
  try {
    await getRedisClient().set(AUTH_FAILURE_KEY, '1', 'EX', AUTH_FAILURE_TTL_SEC);
  } catch {
    /* swallow — non-fatal */
  }
}

async function resolveProjectKey(productKey: string): Promise<string | null> {
  try {
    const value = (await getSetting(MAPPING_KEY)) as Record<string, string> | undefined;
    if (!value || typeof value !== 'object') return null;
    return value[productKey] ?? null;
  } catch (err) {
    logger.warn({ err, productKey }, 'jira.resolveProjectKey: getSetting failed');
    return null;
  }
}

/**
 * HUB-1593 (CR-1): single-callsite public surface. Resolves productKey → Atlassian project,
 * checks cache, fetches with Basic auth, counts by type, caches the result. Never throws —
 * every failure path resolves to `{available: false, reason}` so consumers can render a
 * stub tile instead of erroring the dashboard.
 */
export async function getTicketCounts(productKey: string): Promise<JiraTicketsResponse> {
  // 1. Token-missing short-circuit (defensive — validateEnv should prevent at startup).
  const authHeader = buildBasicAuthHeader();
  if (!authHeader) {
    logger.warn({ productKey }, 'jira.getTicketCounts: JIRA_SERVICE_TOKEN/EMAIL missing');
    return { available: false, reason: 'token_missing' };
  }

  // 2. Cached success / transient failure?
  const cached = await readCachedTickets(productKey);
  if (cached) return cached;

  // 3. Cached auth failure? (One global key — token rotation issue blocks all products until
  //    the admin calls clearAuthCache().)
  const cachedAuthFailure = await readAuthFailureCache();
  if (cachedAuthFailure) return cachedAuthFailure;

  // 4. Mapping lookup — uncached "product not mapped" surfaces immediately so adding the
  //    mapping row resolves on the very next request without a cache TTL wait.
  const projectKey = await resolveProjectKey(productKey);
  if (!projectKey) {
    return { available: false, reason: 'product_not_mapped' };
  }

  // 5. Atlassian fetch.
  const url = buildJqlUrl(projectKey);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
  } catch (err) {
    logger.warn({ err, productKey, projectKey }, 'jira.getTicketCounts: network fetch failed');
    const stub: JiraTicketsResponse = { available: false, reason: 'upstream_unavailable' };
    await writeCachedTickets(productKey, stub, TRANSIENT_TTL_SEC);
    return stub;
  }

  // 6. Status-code branch.
  if (response.status === 429) {
    const stub: JiraTicketsResponse = { available: false, reason: 'rate_limited' };
    await writeCachedTickets(productKey, stub, TRANSIENT_TTL_SEC);
    return stub;
  }
  if (response.status === 401 || response.status === 403) {
    logger.error({ productKey, projectKey, status: response.status }, 'jira.getTicketCounts: Atlassian auth failed — rotate token + clearAuthCache');
    await writeAuthFailureCache();
    return { available: false, reason: 'auth_failed' };
  }
  if (response.status >= 500) {
    logger.warn({ productKey, projectKey, status: response.status }, 'jira.getTicketCounts: Atlassian 5xx');
    const stub: JiraTicketsResponse = { available: false, reason: 'upstream_unavailable' };
    await writeCachedTickets(productKey, stub, TRANSIENT_TTL_SEC);
    return stub;
  }
  if (!response.ok) {
    logger.warn({ productKey, projectKey, status: response.status }, 'jira.getTicketCounts: Atlassian non-OK');
    const stub: JiraTicketsResponse = { available: false, reason: 'upstream_unavailable' };
    await writeCachedTickets(productKey, stub, TRANSIENT_TTL_SEC);
    return stub;
  }

  // 7. Happy path — parse + count + cache. Never log issue payload (may contain confidential
  //    titles/descriptions — only counts make it into logs).
  let payload: AtlassianSearchResponse;
  try {
    payload = (await response.json()) as AtlassianSearchResponse;
  } catch (err) {
    logger.warn({ err, productKey, projectKey }, 'jira.getTicketCounts: JSON parse failed');
    const stub: JiraTicketsResponse = { available: false, reason: 'upstream_unavailable' };
    await writeCachedTickets(productKey, stub, TRANSIENT_TTL_SEC);
    return stub;
  }

  const counts = countByType(payload);
  const result: JiraTicketsResponse = {
    available: true,
    openCRs: counts.openCRs,
    openBugs: counts.openBugs,
    lastSyncedAt: new Date().toISOString(),
  };
  await writeCachedTickets(productKey, result, SUCCESS_TTL_SEC);
  logger.info(
    { productKey, projectKey, openCRs: counts.openCRs, openBugs: counts.openBugs },
    'jira.getTicketCounts: success',
  );
  return result;
}

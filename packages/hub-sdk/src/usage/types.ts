// Authorized by HUB-970 — UsageEvent and UsageBufferEntry interfaces for the usage buffering layer

export interface UsageEvent {
  tenant_id: string;
  product_id: string;
  event_type: string;
  quantity: number;
  occurred_at: string;      // ISO8601 UTC; set at trackUsage() call time; never overwritten
  ingested_late?: boolean;  // set by flush engine at flush time, not at capture
}

export interface UsageBufferEntry {
  event: UsageEvent;
  capturedAt: number;       // Date.now() at trackUsage() — used for ingested_late calc at flush
}

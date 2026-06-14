// Authorized by HUB-127 — queue registry; getAllQueueDefinitions() consumed by worker scaffold
// Authorized by HUB-146 — queue factory pattern; concrete queue definitions registered here
import type { Job } from 'bullmq';

export interface QueueDefinition {
  name: string;
  concurrency: number;
  processor?: (job: Job) => Promise<void>;
}

// Queue definitions are registered here by downstream Epics (HUB-146 adds the factory).
// Worker scaffold (HUB-127) calls this to discover which queues to watch.
const _queues: QueueDefinition[] = [];

export function getAllQueueDefinitions(): QueueDefinition[] {
  return [..._queues];
}

export function registerQueue(def: QueueDefinition): void {
  _queues.push(def);
}

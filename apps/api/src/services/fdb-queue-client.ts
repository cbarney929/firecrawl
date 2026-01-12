/**
 * HTTP client for the FDB Queue microservice.
 *
 * This module provides the same interface as fdb-queue.ts but makes HTTP calls
 * to the separate Rust microservice instead of using the FDB native libraries directly.
 */

import { config } from "../config";
import { logger as rootLogger } from "../lib/logger";
import { StoredCrawl, getCrawl } from "../lib/crawl-redis";

const logger = rootLogger.child({ module: "fdb-queue-client" });

// Types matching the Rust service
type FDBQueueJob = {
  id: string;
  data: any;
  priority: number;
  listenable: boolean;
  createdAt: number;
  timesOutAt?: number;
  listenChannelId?: string;
  crawlId?: string;
  teamId: string;
};

// Circuit breaker state for FDB service health
type CircuitState = "closed" | "open" | "half-open";
let circuitState: CircuitState = "closed";
let circuitOpenedAt: number = 0;
let consecutiveFailures: number = 0;
const CIRCUIT_OPEN_DURATION_MS = 5000;
const CIRCUIT_FAILURE_THRESHOLD = 3;

class FDBCircuitOpenError extends Error {
  constructor() {
    super("FDB circuit breaker is open - FDB Queue Service is unavailable");
    this.name = "FDBCircuitOpenError";
  }
}

function checkCircuit(): void {
  if (circuitState === "open") {
    const now = Date.now();
    if (now - circuitOpenedAt >= CIRCUIT_OPEN_DURATION_MS) {
      circuitState = "half-open";
      logger.info("FDB circuit breaker transitioning to half-open");
    } else {
      throw new FDBCircuitOpenError();
    }
  }
}

function recordSuccess(): void {
  if (circuitState === "half-open") {
    circuitState = "closed";
    consecutiveFailures = 0;
    logger.info("FDB circuit breaker closed - FDB Queue Service is healthy");
  } else if (circuitState === "closed") {
    consecutiveFailures = 0;
  }
}

function recordFailure(error: unknown): void {
  consecutiveFailures++;

  if (circuitState === "half-open") {
    circuitState = "open";
    circuitOpenedAt = Date.now();
    logger.error("FDB circuit breaker re-opened after half-open failure", {
      error,
      consecutiveFailures,
    });
  } else if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuitState = "open";
    circuitOpenedAt = Date.now();
    logger.error("FDB circuit breaker opened after consecutive failures", {
      error,
      consecutiveFailures,
      threshold: CIRCUIT_FAILURE_THRESHOLD,
    });
  }
}

function getBaseUrl(): string {
  const url = config.FDB_QUEUE_SERVICE_URL;
  if (!url) {
    throw new Error("FDB_QUEUE_SERVICE_URL is not configured");
  }
  return url;
}

async function httpRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: any,
): Promise<T> {
  checkCircuit();

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    recordSuccess();
    return result as T;
  } catch (error) {
    recordFailure(error);
    throw error;
  }
}

// === Queue Operations ===

export async function pushJob(
  teamId: string,
  job: {
    id: string;
    data: any;
    priority: number;
    listenable: boolean;
    listenChannelId?: string;
  },
  timeout: number,
  crawlId?: string,
): Promise<void> {
  await httpRequest("POST", "/queue/push", {
    teamId,
    job: {
      id: job.id,
      data: job.data,
      priority: job.priority,
      listenable: job.listenable,
      listenChannelId: job.listenChannelId,
    },
    timeout,
    crawlId,
  });

  logger.debug("Pushed job to FDB queue via service", {
    teamId,
    jobId: job.id,
    priority: job.priority,
    crawlId,
  });
}

export async function popNextJob(
  teamId: string,
  crawlConcurrencyChecker?: (crawlId: string) => Promise<boolean>,
): Promise<FDBQueueJob | null> {
  // Get blocked crawl IDs first
  const blockedCrawlIds: string[] = [];

  // We need to check crawl concurrency on the client side since it requires
  // access to Redis for crawl info. The service handles the atomic pop operation.
  // First, let's try without blocking any crawls
  const result = await httpRequest<FDBQueueJob | null>(
    "POST",
    `/queue/pop/${encodeURIComponent(teamId)}`,
    { blockedCrawlIds: [] },
  );

  if (result === null) {
    return null;
  }

  // If there's a crawl concurrency checker and the job has a crawl ID,
  // we need to verify concurrency is OK
  if (result.crawlId && crawlConcurrencyChecker) {
    const canRun = await crawlConcurrencyChecker(result.crawlId);
    if (!canRun) {
      // Unfortunately, we already popped the job.
      // We need to push it back and try again with the blocked list.
      // This is a simplification - in production you'd want to handle this better.
      await pushJob(
        teamId,
        {
          id: result.id,
          data: result.data,
          priority: result.priority,
          listenable: result.listenable,
          listenChannelId: result.listenChannelId,
        },
        result.timesOutAt ? result.timesOutAt - Date.now() : Infinity,
        result.crawlId,
      );

      // Try again with this crawl blocked
      return popNextJobWithBlocking(
        teamId,
        [result.crawlId],
        crawlConcurrencyChecker,
      );
    }
  }

  return result;
}

async function popNextJobWithBlocking(
  teamId: string,
  blockedCrawlIds: string[],
  crawlConcurrencyChecker: (crawlId: string) => Promise<boolean>,
): Promise<FDBQueueJob | null> {
  const result = await httpRequest<FDBQueueJob | null>(
    "POST",
    `/queue/pop/${encodeURIComponent(teamId)}`,
    { blockedCrawlIds },
  );

  if (result === null) {
    return null;
  }

  // Check concurrency again for any new crawl ID
  if (result.crawlId && !blockedCrawlIds.includes(result.crawlId)) {
    const canRun = await crawlConcurrencyChecker(result.crawlId);
    if (!canRun) {
      await pushJob(
        teamId,
        {
          id: result.id,
          data: result.data,
          priority: result.priority,
          listenable: result.listenable,
          listenChannelId: result.listenChannelId,
        },
        result.timesOutAt ? result.timesOutAt - Date.now() : Infinity,
        result.crawlId,
      );

      return popNextJobWithBlocking(
        teamId,
        [...blockedCrawlIds, result.crawlId],
        crawlConcurrencyChecker,
      );
    }
  }

  return result;
}

export async function getTeamQueueCount(teamId: string): Promise<number> {
  const result = await httpRequest<{ count: number }>(
    "GET",
    `/queue/count/team/${encodeURIComponent(teamId)}`,
  );
  return result.count;
}

export async function getCrawlQueueCount(crawlId: string): Promise<number> {
  const result = await httpRequest<{ count: number }>(
    "GET",
    `/queue/count/crawl/${encodeURIComponent(crawlId)}`,
  );
  return result.count;
}

export async function getTeamQueuedJobIds(
  teamId: string,
  limit: number = 10000,
): Promise<Set<string>> {
  const result = await httpRequest<{ jobIds: string[] }>(
    "GET",
    `/queue/jobs/team/${encodeURIComponent(teamId)}?limit=${limit}`,
  );
  return new Set(result.jobIds);
}

// === Active Job Tracking ===

export async function pushActiveJob(
  teamId: string,
  jobId: string,
  timeout: number,
): Promise<void> {
  await httpRequest("POST", "/active/push", {
    teamId,
    jobId,
    timeout,
  });
}

export async function removeActiveJob(
  teamId: string,
  jobId: string,
): Promise<void> {
  await httpRequest("DELETE", "/active/remove", {
    teamId,
    jobId,
  });
}

export async function getActiveJobCount(teamId: string): Promise<number> {
  const result = await httpRequest<{ count: number }>(
    "GET",
    `/active/count/${encodeURIComponent(teamId)}`,
  );
  return result.count;
}

export async function getActiveJobs(teamId: string): Promise<string[]> {
  const result = await httpRequest<{ jobIds: string[] }>(
    "GET",
    `/active/jobs/${encodeURIComponent(teamId)}`,
  );
  return result.jobIds;
}

// === Crawl Active Job Tracking ===

export async function pushCrawlActiveJob(
  crawlId: string,
  jobId: string,
  timeout: number,
): Promise<void> {
  await httpRequest("POST", "/active/crawl/push", {
    crawlId,
    jobId,
    timeout,
  });
}

export async function removeCrawlActiveJob(
  crawlId: string,
  jobId: string,
): Promise<void> {
  await httpRequest("DELETE", "/active/crawl/remove", {
    crawlId,
    jobId,
  });
}

export async function getCrawlActiveJobs(crawlId: string): Promise<string[]> {
  const result = await httpRequest<{ jobIds: string[] }>(
    "GET",
    `/active/crawl/jobs/${encodeURIComponent(crawlId)}`,
  );
  return result.jobIds;
}

// === Cleanup Operations ===

export async function cleanExpiredJobs(): Promise<number> {
  const result = await httpRequest<{ cleaned: number }>(
    "POST",
    "/cleanup/expired-jobs",
  );
  return result.cleaned;
}

export async function cleanExpiredActiveJobs(): Promise<number> {
  const result = await httpRequest<{ cleaned: number }>(
    "POST",
    "/cleanup/expired-active-jobs",
  );
  return result.cleaned;
}

export async function cleanStaleCounters(): Promise<number> {
  const result = await httpRequest<{ cleaned: number }>(
    "POST",
    "/cleanup/stale-counters",
  );
  return result.cleaned;
}

// === Counter Reconciliation ===

export async function reconcileTeamQueueCounter(
  teamId: string,
): Promise<number> {
  const result = await httpRequest<{ correction: number }>(
    "POST",
    `/reconcile/team/queue/${encodeURIComponent(teamId)}`,
  );
  return result.correction;
}

export async function reconcileTeamActiveCounter(
  teamId: string,
): Promise<number> {
  const result = await httpRequest<{ correction: number }>(
    "POST",
    `/reconcile/team/active/${encodeURIComponent(teamId)}`,
  );
  return result.correction;
}

export async function reconcileCrawlQueueCounter(
  crawlId: string,
): Promise<number> {
  const result = await httpRequest<{ correction: number }>(
    "POST",
    `/reconcile/crawl/queue/${encodeURIComponent(crawlId)}`,
  );
  return result.correction;
}

export async function reconcileCrawlActiveCounter(
  crawlId: string,
): Promise<number> {
  const result = await httpRequest<{ correction: number }>(
    "POST",
    `/reconcile/crawl/active/${encodeURIComponent(crawlId)}`,
  );
  return result.correction;
}

// === Counter Sampling ===

export async function sampleTeamCounters(
  limit: number,
  afterTeamId?: string,
): Promise<string[]> {
  let url = `/sample/teams?limit=${limit}`;
  if (afterTeamId) {
    url += `&after=${encodeURIComponent(afterTeamId)}`;
  }
  const result = await httpRequest<{ ids: string[] }>("GET", url);
  return result.ids;
}

export async function sampleCrawlCounters(
  limit: number,
  afterCrawlId?: string,
): Promise<string[]> {
  let url = `/sample/crawls?limit=${limit}`;
  if (afterCrawlId) {
    url += `&after=${encodeURIComponent(afterCrawlId)}`;
  }
  const result = await httpRequest<{ ids: string[] }>("GET", url);
  return result.ids;
}

// === Configuration ===

export function isFDBConfigured(): boolean {
  return !!config.FDB_QUEUE_SERVICE_URL;
}

export function initFDB(): boolean {
  if (!config.FDB_QUEUE_SERVICE_URL) {
    logger.info("FDB Queue Service not configured, skipping initialization");
    return false;
  }
  logger.info("FDB Queue Service client initialized", {
    serviceUrl: config.FDB_QUEUE_SERVICE_URL,
  });
  return true;
}

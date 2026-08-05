import type { RunStore } from "./run-store.ts";

export interface RunPartialSinkPolicy {
  flushIntervalMs: number;
  minGrowthBytes: number;
  maxBytes: number;
}

export const DEFAULT_RUN_PARTIAL_POLICY: RunPartialSinkPolicy = {
  flushIntervalMs: 750,
  minGrowthBytes: 512,
  maxBytes: 65_536,
};

export interface RunPartialSink {
  append(chunk: string): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function createRunPartialSink(
  runs: RunStore,
  runId: string,
  leaseToken: string,
  policy: RunPartialSinkPolicy = DEFAULT_RUN_PARTIAL_POLICY,
): RunPartialSink {
  let text = "";
  let seq = 0;
  let lastFlushAt = 0;
  let lastFlushedLen = 0;
  let inFlight: Promise<void> | null = null;
  let closed = false;

  async function publish(): Promise<void> {
    if (!text) return;
    const snapshot = text.length > policy.maxBytes ? text.slice(0, policy.maxBytes) : text;
    const at = Date.now();
    const n = ++seq;
    await runs.publishPartial(runId, leaseToken, n, snapshot, at);
    lastFlushAt = at;
    lastFlushedLen = snapshot.length;
  }

  function kick(): void {
    if (inFlight) return;
    inFlight = publish()
      .catch(() => {})
      .finally(() => {
        inFlight = null;
      });
  }

  return {
    append(chunk: string): void {
      if (closed || !chunk) return;
      text += chunk;
      if (text.length - lastFlushedLen < policy.minGrowthBytes) return;
      if (Date.now() - lastFlushAt < policy.flushIntervalMs) return;
      kick();
    },
    async flush(): Promise<void> {
      if (closed) return;
      await inFlight;
      await publish().catch(() => {});
    },
    async close(): Promise<void> {
      if (closed) return;
      await inFlight;
      closed = true;
      await publish().catch(() => {});
    },
  };
}

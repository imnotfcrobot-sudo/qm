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

export interface RunPartialSinkHooks {
  onError?: (event: { runId: string; kind: "publish_failed" | "fenced" }) => void;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const next = bytes + Buffer.byteLength(ch, "utf8");
    if (next > maxBytes) break;
    bytes = next;
    end += ch.length;
  }
  return text.slice(0, end);
}

export function createRunPartialSink(
  runs: RunStore,
  runId: string,
  leaseToken: string,
  policy: RunPartialSinkPolicy = DEFAULT_RUN_PARTIAL_POLICY,
  hooks: RunPartialSinkHooks = {},
): RunPartialSink {
  let text = "";
  let textBytes = 0;
  let capped = false;
  let seq = 0;
  let lastFlushAt = 0;
  let lastFlushedBytes = 0;
  let inFlight: Promise<void> | null = null;
  let closed = false;
  let fenced = false;
  let publishFailed = false;
  let dirty = false;
  let generation = 0;

  async function publish(): Promise<void> {
    if (fenced || !text || !dirty) return;
    const publishedGeneration = generation;
    const snapshot = truncateUtf8(text, policy.maxBytes);
    const at = Date.now();
    const n = ++seq;
    let accepted = false;
    try {
      accepted = await runs.publishPartial(runId, leaseToken, n, snapshot, at);
    } catch {
      publishFailed = true;
      hooks.onError?.({ runId, kind: "publish_failed" });
      return;
    }
    if (!accepted) {
      fenced = true;
      hooks.onError?.({ runId, kind: "fenced" });
      return;
    }
    lastFlushAt = at;
    lastFlushedBytes = utf8Bytes(snapshot);
    if (generation === publishedGeneration) dirty = false;
  }

  function maybeKick(): void {
    if (inFlight || fenced || closed) return;
    inFlight = publish().finally(() => {
      inFlight = null;
    });
  }

  return {
    append(chunk: string): void {
      if (closed || fenced || !chunk) return;
      if (capped) return;
      text += chunk;
      textBytes = utf8Bytes(text);
      if (textBytes > policy.maxBytes) {
        text = truncateUtf8(text, policy.maxBytes);
        textBytes = policy.maxBytes;
        capped = true;
      }
      if (textBytes !== lastFlushedBytes) {
        dirty = true;
        publishFailed = false;
        generation += 1;
      }
      if (textBytes - lastFlushedBytes < policy.minGrowthBytes) return;
      if (Date.now() - lastFlushAt < policy.flushIntervalMs) return;
      maybeKick();
    },
    async flush(): Promise<void> {
      if (closed || fenced) return;
      await inFlight;
      while (!fenced && !publishFailed && dirty) {
        await publish();
        await inFlight;
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      await inFlight;
      while (!fenced && !publishFailed && dirty) {
        await publish();
        await inFlight;
      }
      closed = true;
    },
  };
}

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
  if (utf8Bytes(text) <= maxBytes) return text;
  let buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
  while (buf.length > 0 && (buf[buf.length - 1]! & 0b1100_0000) === 0b1000_0000) {
    buf = buf.subarray(0, buf.length - 1);
  }
  const out = buf.toString("utf8");
  return out.endsWith("�") && !text.startsWith(out) ? out.slice(0, -1) : out;
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
  let dirty = false;

  async function publish(): Promise<void> {
    if (fenced || !text || !dirty) return;
    const snapshot = truncateUtf8(text, policy.maxBytes);
    const at = Date.now();
    const n = ++seq;
    let accepted = false;
    try {
      accepted = await runs.publishPartial(runId, leaseToken, n, snapshot, at);
    } catch {
      dirty = false;
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
    dirty = false;
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
      if (textBytes !== lastFlushedBytes) dirty = true;
      if (textBytes - lastFlushedBytes < policy.minGrowthBytes) return;
      if (Date.now() - lastFlushAt < policy.flushIntervalMs) return;
      maybeKick();
    },
    async flush(): Promise<void> {
      if (closed || fenced) return;
      await inFlight;
      if (!fenced) await publish();
    },
    async close(): Promise<void> {
      if (closed) return;
      await inFlight;
      if (!fenced) await publish();
      closed = true;
    },
  };
}

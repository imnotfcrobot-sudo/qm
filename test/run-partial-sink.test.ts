import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunPartialSink, type RunPartialSinkPolicy } from "../src/runs/run-partial-sink.ts";
import type { RunStore } from "../src/runs/run-store.ts";

const POLICY: RunPartialSinkPolicy = { flushIntervalMs: 0, minGrowthBytes: 1, maxBytes: 64 };

function fakeStore(behavior: { throw?: boolean; accept?: boolean }) {
  const calls: Array<{ seq: number; bytes: number }> = [];
  const store = {
    publishPartial: async (_runId: string, _lease: string, seq: number, text: string) => {
      calls.push({ seq, bytes: Buffer.byteLength(text, "utf8") });
      if (behavior.throw) throw new Error("db exploded — simulated sensitive detail");
      return behavior.accept ?? true;
    },
  } as unknown as RunStore;
  return { store, calls };
}

test("publish failure is observable via hook and never leaks content or db errors", async () => {
  const events: Array<{ runId: string; kind: string }> = [];
  const { store, calls } = fakeStore({ throw: true });
  const sink = createRunPartialSink(store, "run-1", "lease", POLICY, { onError: (e) => events.push(e) });
  sink.append("hello partial content that should never be logged");
  await sink.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "publish_failed");
  assert.equal(JSON.stringify(events).includes("hello partial"), false);
  assert.equal(JSON.stringify(events).includes("simulated sensitive detail"), false);
  assert.equal(calls.length, 1);
});

test("fencing rejection (false) stops all subsequent writes", async () => {
  const events: Array<{ kind: string }> = [];
  const { store, calls } = fakeStore({ accept: false });
  const sink = createRunPartialSink(store, "run-1", "lease", POLICY, { onError: (e) => events.push(e) });
  sink.append("first");
  await sink.flush();
  sink.append("second");
  await sink.flush();
  await sink.close();
  assert.equal(calls.length, 1, "only the first publish reached the store");
  assert.deepEqual(events.map((e) => e.kind), ["fenced"]);
});

test("utf-8 byte accounting caps multibyte text without splitting codepoints", async () => {
  const { store, calls } = fakeStore({ accept: true });
  const sink = createRunPartialSink(store, "run-1", "lease", { flushIntervalMs: 0, minGrowthBytes: 1, maxBytes: 10 });
  sink.append("你好世界🙂"); // 12+4 bytes
  await sink.close();
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.bytes <= 10, `capped at 10 bytes, got ${calls[0]!.bytes}`);
});

test("after the cap: bounded memory, no repeated big writes", async () => {
  const { store, calls } = fakeStore({ accept: true });
  const sink = createRunPartialSink(store, "run-1", "lease", { flushIntervalMs: 0, minGrowthBytes: 1, maxBytes: 32 });
  for (let i = 0; i < 200; i++) sink.append("x".repeat(64));
  await sink.flush();
  await sink.flush();
  await sink.close();
  const maxWrite = Math.max(...calls.map((c) => c.bytes));
  assert.ok(maxWrite <= 32, `no write exceeds the cap (got ${maxWrite})`);
  assert.ok(calls.length <= 2, `no repeated full-text writes (got ${calls.length})`);
});

test("no writes after terminal close", async () => {
  const { store, calls } = fakeStore({ accept: true });
  const sink = createRunPartialSink(store, "run-1", "lease", POLICY);
  sink.append("final");
  await sink.close();
  sink.append("late");
  await sink.flush();
  assert.equal(calls.length, 1);
});

test("capped partial still leaves lease liveness intact (no false client timeout)", async () => {
  const { createMemoryRunStore } = await import("../src/runs/memory-run-store.ts");
  const { leaseLapsed } = await import("../src/runs/run-store.ts");
  const store = createMemoryRunStore();
  const enq = await store.runs.enqueue({ sessionId: "s1", request: {} as never });
  const claimed = await store.runs.claimById(enq.run.id, "w1", 60_000);
  assert.ok(claimed);
  const sink = createRunPartialSink(store.runs, enq.run.id, claimed!.leaseToken!, {
    flushIntervalMs: 0,
    minGrowthBytes: 1,
    maxBytes: 16,
  });
  for (let i = 0; i < 50; i++) sink.append("y".repeat(32));
  await sink.close();
  for (let i = 0; i < 3; i++) {
    const alive = await store.runs.heartbeat(enq.run.id, claimed!.leaseToken!, 60_000);
    assert.equal(alive, true);
  }
  const after = await store.runs.get(enq.run.id);
  assert.ok(after);
  assert.equal(leaseLapsed(after!, Date.now()), false, "lease kept fresh — clients must not time out");
  assert.ok((after!.partialText?.length ?? 0) <= 16, "partial stays capped");
});

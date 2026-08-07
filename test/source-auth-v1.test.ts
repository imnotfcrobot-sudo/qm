import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  canonicalPayloadV1,
  NONCE_HEADER,
  signRequestV1,
  signedRequestHeadersV1,
} from "../src/auth/source-auth-sign.ts";
import { createSourceAuth, verifySignature, SOURCE_AUTH_REPLAY_WINDOW_MS } from "../src/auth/source-auth.ts";

const SECRET = "core-signing-secret".repeat(3);
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;

test("v1: 1000 signatures in one second carry real wall-clock time and unique nonces", () => {
  const now = Math.floor(Date.now() / 1000);
  const nonces = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const h = signedRequestHeadersV1(SECRET, "POST", "/v1/turns", "same-body");
    const ts = Number(h["x-timestamp"]!);
    assert.ok(Math.abs(ts - now) <= 1, "timestamp must be the real wall clock, never incremented");
    const nonce = h[NONCE_HEADER]!;
    assert.match(nonce, NONCE_RE);
    nonces.add(nonce);
    assert.ok(h["x-signature"]!.startsWith("v1="));
  }
  assert.equal(nonces.size, 1000, "every request gets its own 128-bit nonce");
});

test("v1: tampering with nonce, body, or path fails verification", () => {
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ text: "hello" });
  const canonical = canonicalPayloadV1("POST", "/v1/turns", body);
  const nonce = randomBytes(16).toString("base64url");
  const good = signRequestV1(SECRET, ts, nonce, canonical);
  const now = Date.now();
  const ok = verifySignature(SECRET, { signature: good, timestamp: ts, body: canonical, nonce }, now, SOURCE_AUTH_REPLAY_WINDOW_MS);
  assert.equal(ok.ok, true);
  const badNonce = verifySignature(SECRET, { signature: good, timestamp: ts, body: canonical, nonce: randomBytes(16).toString("base64url") }, now, SOURCE_AUTH_REPLAY_WINDOW_MS);
  assert.equal(badNonce.ok, false, "tampered nonce");
  const badBody = verifySignature(SECRET, { signature: good, timestamp: ts, body: canonicalPayloadV1("POST", "/v1/turns", body + "x"), nonce }, now, SOURCE_AUTH_REPLAY_WINDOW_MS);
  assert.equal(badBody.ok, false, "tampered body");
  const badPath = verifySignature(SECRET, { signature: good, timestamp: ts, body: canonicalPayloadV1("POST", "/v1/runs", body), nonce }, now, SOURCE_AUTH_REPLAY_WINDOW_MS);
  assert.equal(badPath.ok, false, "tampered path");
  const missing = verifySignature(SECRET, { signature: good, timestamp: ts, body: canonical }, now, SOURCE_AUTH_REPLAY_WINDOW_MS);
  assert.equal(missing.ok, false, "v1 signature without a nonce");
});

test("v1: exact replay rejected, same-body new-nonce retry reaches the dedupe layer", async () => {
  const auth = createSourceAuth({ signingSecret: SECRET });
  const ts = Math.floor(Date.now() / 1000);
  const canonical = canonicalPayloadV1("POST", "/v1/turns", "{}");
  const n1 = randomBytes(16).toString("base64url");
  const sig1 = signRequestV1(SECRET, ts, n1, canonical);
  const first = await auth.verify({ signature: sig1, timestamp: ts, body: canonical, nonce: n1, eventId: sig1 });
  assert.equal(first.ok, true);
  const replay = await auth.verify({ signature: sig1, timestamp: ts, body: canonical, nonce: n1, eventId: sig1 });
  assert.equal(replay.ok, false, "byte-identical replay must be rejected");
  const n2 = randomBytes(16).toString("base64url");
  const sig2 = signRequestV1(SECRET, ts, n2, canonical);
  const retry = await auth.verify({ signature: sig2, timestamp: ts, body: canonical, nonce: n2, eventId: sig2 });
  assert.equal(retry.ok, true, "a new nonce is a new request — business idempotency decides");
});

test("v0 signatures still accepted (backward compatible)", async () => {
  const { signRequest, canonicalPayload } = await import("../src/auth/source-auth-sign.ts");
  const ts = Math.floor(Date.now() / 1000);
  const sig = signRequest(SECRET, ts, canonicalPayload("GET", "/v1/sessions", ""));
  const res = verifySignature(SECRET, { signature: sig, timestamp: ts, body: canonicalPayload("GET", "/v1/sessions", "") }, Date.now(), SOURCE_AUTH_REPLAY_WINDOW_MS);
  assert.equal(res.ok, true);
});

test("two cells (two secrets) share no mutable signing state", () => {
  const other = "other-cell-secret".repeat(3);
  const ts = Math.floor(Date.now() / 1000);
  const h1 = signedRequestHeadersV1(SECRET, "GET", "/v1/runs/1", "");
  const canonical = canonicalPayloadV1("GET", "/v1/runs/1", "");
  const cross = verifySignature(other, { signature: h1["x-signature"]!, timestamp: ts, body: canonical, nonce: h1[NONCE_HEADER]! }, Date.now(), SOURCE_AUTH_REPLAY_WINDOW_MS);
  assert.equal(cross.ok, false, "a signature from cell A must never validate in cell B");
});

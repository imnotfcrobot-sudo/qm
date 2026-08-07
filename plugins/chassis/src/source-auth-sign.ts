import { createHmac, randomBytes } from "node:crypto";

export function canonicalPayload(method: string, pathWithQuery: string, body: string): string {
  return `${method}\n${pathWithQuery}\n${body}`;
}

export function signRequest(secret: string, timestampSec: number, canonical: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestampSec}:${canonical}`).digest("hex")}`;
}

export function signedRequestHeaders(
  secret: string | undefined,
  method: string,
  pathWithQuery: string,
  body = "",
  base: Record<string, string> = {},
  nowSec: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  if (!secret) return { ...base };
  const canonical = canonicalPayload(method, pathWithQuery, body);
  return { ...base, "x-timestamp": String(nowSec), "x-signature": signRequest(secret, nowSec, canonical) };
}

export const NONCE_HEADER = "x-request-nonce";
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;

export function isValidNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_RE.test(value);
}

export function canonicalPayloadV1(method: string, pathWithQuery: string, body: string): string {
  return `${method}\n${pathWithQuery}\n${body}`;
}

export function signRequestV1(secret: string, timestampSec: number, nonce: string, canonical: string): string {
  return `v1=${createHmac("sha256", secret).update(`v1:${timestampSec}:${nonce}:${canonical}`).digest("hex")}`;
}

export function signedRequestHeadersV1(
  secret: string,
  method: string,
  pathWithQuery: string,
  body = "",
  base: Record<string, string> = {},
  nowSec: number = Math.floor(Date.now() / 1000),
  nonceFn: () => string = () => randomBytes(16).toString("base64url"),
): Record<string, string> {
  const nonce = nonceFn();
  const canonical = canonicalPayloadV1(method, pathWithQuery, body);
  return {
    ...base,
    "x-timestamp": String(nowSec),
    [NONCE_HEADER]: nonce,
    "x-signature": signRequestV1(secret, nowSec, nonce, canonical),
  };
}

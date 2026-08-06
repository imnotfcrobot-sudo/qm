import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { mintSignedPayload } from "../src/auth/signed-token.ts";

const SERVER_URL = process.env.DATABASE_URL;
const skip = !SERVER_URL
  ? "set DATABASE_URL (a Postgres server) to run production-entry integration tests"
  : false;
let URL = SERVER_URL ?? "";
let qualDbName = "";

const SIGNING_SECRET = "qual-signing-secret-0123456789abcdef0123456789abcdef";
const CAPABILITY_SECRET = "qual-capability-secret-0123456789abcdef0123456789a";
const PORTAL_SECRET = "qual-portal-secret-0123456789abcdef0123456789abcde";
const CONNECTOR_KEY = "qual-connector-key-0123456789abcdef0123456789abcdef0";
const SKILL_KEY = "qual-skill-key-0123456789abcdef0123456789abcdef0123456";
const ORG = "qual-org";

let child: ChildProcess | null = null;
let port = 0;
let dataDir = "";
const created: string[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
}

function sign(method: string, pathWithQuery: string, body: string) {
  const ts = Math.floor(Date.now() / 1000);
  const canonical = `${method}\n${pathWithQuery}\n${body}`;
  const sig = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${canonical}`).digest("hex")}`;
  return { "x-timestamp": String(ts), "x-signature": sig };
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  opts: { actor?: string; unsigned?: boolean } = {},
): Promise<{ status: number; json: any }> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers: Record<string, string> = raw ? { "content-type": "application/json" } : {};
  if (!opts.unsigned) Object.assign(headers, sign(method, path, raw));
  if (opts.actor) {
    headers["x-admin-actor"] = opts.actor;
    headers["x-portal-identity"] = await mintSignedPayload(
      { p: opts.actor, exp: Date.now() + 60_000 },
      PORTAL_SECRET,
    );
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: raw || undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function boot(): Promise<void> {
  port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    DATABASE_URL: URL!,
    ORG_ID: ORG,
    CORE_SIGNING_SECRET: SIGNING_SECRET,
    CAPABILITY_SECRET,
    PORTAL_IDENTITY_SECRET: PORTAL_SECRET,
    CONNECTOR_SECRET_KEY: CONNECTOR_KEY,
    SKILL_SIGNING_SECRET: SKILL_KEY,
    ADMIN_GRANTS: "qual-admin:org_admin",
    HARNESS: "pi",
    SANDBOX_BACKEND: "local",
  };
  const stderrChunks: string[] = [];
  let stderrLen = 0;
  child = spawn(process.execPath, ["src/index.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", (chunk) => {
    const text = String(chunk);
    if (stderrLen + text.length > 16_384) return;
    stderrLen += text.length;
    stderrChunks.push(text);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("core did not start in 30s")), 30_000);
    child!.stdout!.on("data", (chunk) => {
      if (String(chunk).includes(`listening on :${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child!.on("exit", (code) => {
      clearTimeout(timer);
      const stderr = stderrChunks
        .join("")
        .replaceAll(SIGNING_SECRET, "<redacted>")
        .replaceAll(CAPABILITY_SECRET, "<redacted>")
        .replaceAll(PORTAL_SECRET, "<redacted>")
        .replaceAll(CONNECTOR_KEY, "<redacted>")
        .replaceAll(SKILL_KEY, "<redacted>")
        .slice(0, 2_000);
      reject(new Error(`core exited early with code ${code}; stderr (truncated): ${stderr}`));
    });
  });
}

async function stop(): Promise<void> {
  if (!child) return;
  const c = child;
  child = null;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      c.kill("SIGKILL");
      resolve();
    }, 10_000);
    c.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    c.kill("SIGTERM");
  });
}

before(async () => {
  if (skip) return;
  dataDir = mkdtempSync(join(tmpdir(), "qm-prod-entry-"));
  created.push(dataDir);
  const pg = (await import("pg")).default;
  qualDbName = `qm_qual_entry_${Math.random().toString(16).slice(2, 10)}`;
  const admin = new pg.Pool({ connectionString: SERVER_URL });
  try {
    await admin.query(`CREATE DATABASE ${qualDbName}`);
  } finally {
    await admin.end();
  }
  URL = `${(SERVER_URL ?? "").replace(/\/[^/]*$/, "")}/${qualDbName}`;
  await boot();
});

after(async () => {
  await stop();
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  if (qualDbName) {
    const pg = (await import("pg")).default;
    const admin = new pg.Pool({ connectionString: SERVER_URL });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${qualDbName}`);
    } finally {
      await admin.end();
    }
  }
});

const SPEC = {
  name: "Qual Gateway",
  protocol: "openai",
  baseUrl: "https://qual-gateway.invalid/v1",
  models: [{ id: "Qual-Model-1", name: "Qual Model 1" }],
  apiKey: "qual-test-key-not-a-real-secret-0000000000000000",
  validate: false,
};

test("production entry: custom provider admin API is reachable and persists", { skip }, async () => {
  const unauthenticated = await api("GET", "/v1/admin/custom-providers", undefined, { unsigned: true });
  assert.equal(unauthenticated.status, 401, "unsigned request must be rejected");

  const notAdmin = await api("GET", "/v1/admin/custom-providers", undefined, { actor: "qual-user" });
  assert.equal(notAdmin.status, 403, "non-admin must be rejected");

  const empty = await api("GET", "/v1/admin/custom-providers", undefined, { actor: "qual-admin" });
  assert.equal(empty.status, 200, "admin route must be reachable from the production entry");
  assert.deepEqual(empty.json.providers, []);

  const put = await api("PUT", "/v1/admin/custom-providers/qual-gw", SPEC, { actor: "qual-admin" });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal(put.json.status.hasKey, true);
  assert.equal(JSON.stringify(put.json).includes(SPEC.apiKey), false, "response must not echo the key");

  const listed = await api("GET", "/v1/admin/custom-providers", undefined, { actor: "qual-admin" });
  assert.equal(listed.json.providers.length, 1);
  assert.equal(listed.json.providers[0].id, "qual-gw");
  assert.equal(JSON.stringify(listed.json).includes(SPEC.apiKey), false);

  const models = await api("GET", "/v1/runtime-config?principalId=qual-admin&scopeId=personal:qual-admin", undefined, { actor: "qual-admin" });
  assert.equal(models.status, 200);
  assert.ok(
    JSON.stringify(models.json).includes("Qual-Model-1"),
    "model catalog must include the registered custom model in the same process",
  );

  await stop();
  await boot();

  const afterRestart = await api("GET", "/v1/admin/custom-providers", undefined, { actor: "qual-admin" });
  assert.equal(afterRestart.status, 200);
  assert.equal(afterRestart.json.providers.length, 1, "provider must survive a Core restart (postgres-backed)");
  assert.equal(afterRestart.json.providers[0].hasKey, true);

  const modelsAfterRestart = await api("GET", "/v1/runtime-config?principalId=qual-admin&scopeId=personal:qual-admin", undefined, { actor: "qual-admin" });
  assert.ok(
    JSON.stringify(modelsAfterRestart.json).includes("Qual-Model-1"),
    "model catalog must hydrate the custom model from the durable store at boot",
  );
});

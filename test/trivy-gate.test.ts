import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ignoreRaw = readFileSync(join(repoRoot, ".trivyignore.yaml"), "utf8");
const workflowRaw = readFileSync(join(repoRoot, ".github/workflows/private-release.yml"), "utf8");

interface IgnoreEntry {
  id: string;
  purls: string[];
  expiredAt: string;
  statement: string;
}

function parseTrivyIgnore(raw: string): IgnoreEntry[] {
  const entries: IgnoreEntry[] = [];
  let current: IgnoreEntry | undefined;
  let inPurls = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    if (line === "vulnerabilities:") continue;
    const idMatch = line.match(/^  - id: (CVE-\d{4}-\d{4,7})\s*$/);
    if (idMatch) {
      current = { id: idMatch[1]!, purls: [], expiredAt: "", statement: "" };
      entries.push(current);
      inPurls = false;
      continue;
    }
    if (!current) continue;
    if (/^    purls:\s*$/.test(line)) {
      inPurls = true;
      continue;
    }
    const purlMatch = line.match(/^      - "(pkg:[^"]+)"\s*$/);
    if (inPurls && purlMatch) {
      current.purls.push(purlMatch[1]!);
      continue;
    }
    inPurls = false;
    const expMatch = line.match(/^    expired_at: (\d{4}-\d{2}-\d{2})\s*$/);
    if (expMatch) {
      current.expiredAt = expMatch[1]!;
      continue;
    }
    const stmtMatch = line.match(/^    statement: "(.+)"\s*$/);
    if (stmtMatch) {
      current.statement = stmtMatch[1]!;
      continue;
    }
    assert.fail(`unparseable line in .trivyignore.yaml (fail-closed): ${JSON.stringify(line)}`);
  }
  return entries;
}

function suppressedBy(entries: IgnoreEntry[], finding: { id: string; purl: string }, today: string): boolean {
  return entries.some((e) => e.id === finding.id && e.purls.includes(finding.purl) && e.expiredAt >= today);
}

const TODAY = new Date().toISOString().slice(0, 10);

test("every exception is exact: CVE id, version-qualified purls, future expiry, reason", () => {
  const entries = parseTrivyIgnore(ignoreRaw);
  assert.ok(entries.length > 0, "no exceptions parsed");
  for (const e of entries) {
    assert.match(e.id, /^CVE-\d{4}-\d{4,7}$/);
    assert.ok(e.purls.length > 0, `${e.id}: purls required (no id-only blanket ignore)`);
    for (const p of e.purls) assert.ok(p.startsWith("pkg:") && p.includes("@"), `${e.id}: purl must be version-qualified`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(e.expiredAt), `${e.id}: expired_at required`);
    assert.ok(e.expiredAt >= TODAY, `${e.id}: exception expired on ${e.expiredAt} — re-review or remove`);
    assert.ok(e.statement.length > 40, `${e.id}: statement must carry a real reason`);
  }
});

test("all current sandbox OS CRITICALs are covered, exactly once per CVE", () => {
  const entries = parseTrivyIgnore(ignoreRaw);
  const ids = entries.map((e) => e.id).sort();
  assert.deepEqual(ids, [
    "CVE-2023-45853",
    "CVE-2025-7458",
    "CVE-2026-13221",
    "CVE-2026-40468",
    "CVE-2026-40469",
    "CVE-2026-42496",
    "CVE-2026-57433",
    "CVE-2026-8376",
  ]);
  assert.equal(new Set(ids).size, ids.length, "duplicate exception ids");
});

test("gate semantics: a non-excepted CRITICAL is not suppressed", () => {
  const entries = parseTrivyIgnore(ignoreRaw);
  const known = { id: entries[0]!.id, purl: entries[0]!.purls[0]! };
  assert.equal(suppressedBy(entries, known, TODAY), true);
  const novel = { id: "CVE-2099-0001", purl: "pkg:deb/debian/bash@5.2.15-2?arch=amd64&distro=debian-12.15" };
  assert.equal(suppressedBy(entries, novel, TODAY), false, "novel CRITICAL must fail the gate");
  const wrongPurl = { id: entries[0]!.id, purl: "pkg:deb/debian/zlib1g@9.9.9?arch=amd64&distro=debian-13.0" };
  assert.equal(suppressedBy(entries, wrongPurl, TODAY), false, "purl drift must fail the gate");
  assert.equal(suppressedBy(entries, known, "2999-01-01"), false, "expired exception must fail the gate");
});

test("workflow wires the gate: trivy exit-code 1 + trivyignores + npm audit, no escape hatches", () => {
  assert.match(workflowRaw, /exit-code: "1"/, "trivy gate must fail the job on unapproved findings");
  assert.match(workflowRaw, /trivyignores: \.trivyignore\.yaml/, "gate must consume the exact exception file");
  assert.match(workflowRaw, /severity: CRITICAL\n/, "gate pass must target CRITICAL");
  assert.match(workflowRaw, /npm audit --omit=dev --audit-level=moderate/, "npm audit must run in the pipeline");
  assert.doesNotMatch(workflowRaw, /\|\|\s*true/, "no || true anywhere in the release workflow");
  assert.doesNotMatch(workflowRaw, /continue-on-error/i, "no continue-on-error anywhere in the release workflow");
  assert.doesNotMatch(workflowRaw, /ignore-unfixed: '?true/, "global ignore-unfixed is forbidden");
});

test("every action is pinned to a full commit SHA with the version in a comment", () => {
  const uses = [...workflowRaw.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
  assert.ok(uses.length >= 8, "expected at least 8 action references");
  for (const u of uses) {
    assert.match(u, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, `mutable action ref: ${u}`);
  }
});

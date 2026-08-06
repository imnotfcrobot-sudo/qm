import { test } from "node:test";
import assert from "node:assert/strict";
import { ThinkStripper, stripThinking } from "../src/harness/think-stripper.ts";

test("every split point of the spaced-tag regression case", () => {
  const full = "visible <think >SECRET</think> answer";
  assert.equal(stripThinking(full), "visible  answer");
  for (let i = 1; i < full.length; i++) {
    const s = new ThinkStripper();
    const got = s.feed(full.slice(0, i)) + s.feed(full.slice(i)) + s.finish();
    assert.equal(got, "visible  answer", `split at ${i}`);
  }
});

test("per-character drip of the regression case", () => {
  const full = "visible <think >SECRET</think> answer";
  const s = new ThinkStripper();
  let out = "";
  for (const ch of full) out += s.feed(ch);
  out += s.finish();
  assert.equal(out, "visible  answer");
});

test("close tag split between '<' and '/think>'", () => {
  const s = new ThinkStripper();
  const out = s.feed("a<think>x<") + s.feed("/think>ok");
  assert.equal(out + s.finish(), "aok");
});

test("variants: case, extra whitespace, multi-block", () => {
  assert.equal(stripThinking("<THINK>x</THINK>v"), "v");
  assert.equal(stripThinking("<think   >x</think  >v"), "v");
  assert.equal(stripThinking("a<think>r1</think>b<think>r2</think>c"), "abc");
});

test("unclosed tags fail closed without leaking reasoning", () => {
  assert.equal(stripThinking("before<think>never closed"), "before");
  assert.equal(stripThinking("<think>only reasoning"), "");
});

test("incomplete tag-like prefixes in normal text are not swallowed", () => {
  assert.equal(stripThinking("text with <th literal"), "text with <th literal");
  assert.equal(stripThinking("a < b"), "a < b");
  assert.equal(stripThinking("use <think in prose"), "use <think in prose");
  const s = new ThinkStripper();
  assert.equal(s.feed("value: <th") + s.feed("ank you") + s.finish(), "value: <thank you");
});

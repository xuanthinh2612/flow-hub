// Tests for the chain rules the Canvas buttons run, using the same module the
// UI imports (src/store/chainRules.ts) — no mocking, so a rule that regresses
// here is a rule the buttons would get wrong.
//
// Run with `npm test` (node --test).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHAIN_GENERABLE_TYPES,
  activeNodeIds,
  blockedByFailedUpstream,
  chainAncestors,
  chainDescendants,
  chainTopoOrder,
} from "../src/store/chainRules.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

const node = (id: string, status?: string, type = "image") => ({
  id,
  data: { type, status },
});

const edge = (source: string, target: string) => ({ source, target });

// ── 1. Run All runs nodes that have no parent, and orders by dependency ────

test("a node with no parent is never blocked by another branch's failure", () => {
  const nodes = [
    node("a", "error"),
    node("b"),          // depends on a — parked behind a failure
    node("independent"),
  ];
  const edges = [edge("a", "b")];

  assert.equal(blockedByFailedUpstream("independent", nodes, edges), false);
  assert.equal(blockedByFailedUpstream("b", nodes, edges), true);
});

test("independent nodes sort first and are all present in the order", () => {
  const nodes = [node("a"), node("b"), node("root2")];
  const edges = [edge("a", "b")];
  const order = chainTopoOrder(nodes.map((n) => n.id), edges);

  assert.equal(order.indexOf("a") < order.indexOf("b"), true);
  assert.ok(order.includes("root2"));
  assert.equal(order.length, 3);
});

test("only media-producing node types are runnable", () => {
  assert.equal(CHAIN_GENERABLE_TYPES.has("image"), true);
  assert.equal(CHAIN_GENERABLE_TYPES.has("video"), true);
  // Structure nodes have nothing to generate.
  assert.equal(CHAIN_GENERABLE_TYPES.has("prompt"), false);
  assert.equal(CHAIN_GENERABLE_TYPES.has("note"), false);
});

// ── 2. A failed prerequisite blocks its whole downstream, transitively ─────

test("a node whose grandparent failed is blocked even though its parent is idle", () => {
  // a failed → b parked at idle (never executed) → c must not be dispatched.
  const nodes = [node("a", "error"), node("b", "idle"), node("c")];
  const edges = [edge("a", "b"), edge("b", "c")];

  assert.equal(blockedByFailedUpstream("c", nodes, edges), true);
});

test("a failure does not block an independent branch", () => {
  const nodes = [node("a", "error"), node("a2"), node("unrelated")];
  const edges = [edge("a", "a2")];

  assert.equal(blockedByFailedUpstream("unrelated", nodes, edges), false);
});

test("blockers follow the graph, not the canvas layout", () => {
  // `mid` sits between them on screen but is wired to nothing.
  const nodes = [node("left", "error"), node("mid"), node("right")];
  const edges = [edge("left", "right")];

  assert.equal(blockedByFailedUpstream("right", nodes, edges), true);
  assert.equal(blockedByFailedUpstream("mid", nodes, edges), false);
});

// ── 3. Run from Here scope ─────────────────────────────────────────────────

test("descendants include transitive dependents but not upstream or siblings", () => {
  const edges = [edge("root", "a"), edge("a", "b"), edge("other", "sibling")];

  assert.deepEqual(chainDescendants("root", edges).sort(), ["a", "b"]);
  assert.deepEqual(chainAncestors("b", edges).sort(), ["a", "root"]);
});

// ── 4. Stop All enablement: project busy vs project stopped ────────────────

test("a node still running makes the project busy, so Stop All is enabled", () => {
  const nodes = [node("a", "running"), node("b", "done"), node("c", "idle")];

  assert.deepEqual(activeNodeIds(nodes, {}), ["a"]);
});

test("a project with nothing in flight is not busy, so Stop All is disabled", () => {
  const nodes = [node("a", "done"), node("b", "idle"), node("c", "error")];

  assert.deepEqual(activeNodeIds(nodes, {}), []);
});

test("an in-flight poll counts as busy before the status round-trip lands", () => {
  // Right after dispatch the node may still read `idle` while a poll owns it.
  const nodes = [node("a", "idle")];

  assert.deepEqual(activeNodeIds(nodes, { a: { requestId: "r1", timerId: null } }), ["a"]);
});
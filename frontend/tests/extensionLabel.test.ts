// Tests for extensionLabel, which writes an extension's name with its Flow credit
// balance beside it — the `Chrome nhà (💳 186)` the overview page, the canvas
// project cards and Settings all render. Run with `npm test` (node --test).

import assert from "node:assert/strict";
import { test } from "node:test";

import { extensionLabel } from "../src/utils/format.ts";

test("a fresh balance is written beside the name", () => {
  const ext = extensionLabel("Chrome nhà", { value: 186, ok: true, at: 1792037095 });
  assert.equal(ext.text, "Chrome nhà (💳 186 credit)");
  assert.equal(ext.stale, false);
  assert.equal(ext.title, null);
});

test("nothing is added until the worker has read a balance", () => {
  // No signed-in Flow tab, or an extension older than 1.0.4 — the name alone
  // must stay clean, never grow a meaningless "(💳 —)".
  assert.deepEqual(extensionLabel("Chrome nhà", { value: null, ok: false }), {
    text: "Chrome nhà",
    stale: false,
    title: null,
  });
  assert.equal(extensionLabel("Chrome nhà", null).text, "Chrome nhà");
});

test("a stale balance stays visible but is marked", () => {
  const ext = extensionLabel("Chrome nhà", {
    value: 186,
    ok: false,
    error: "NO_FLOW_TAB",
    at: 1792037095,
  });
  assert.equal(ext.text, "Chrome nhà (💳 186 credit)");
  assert.equal(ext.stale, true);
  assert.match(ext.title || "", /NO_FLOW_TAB/);
});

test("an empty credits payload is treated as no balance", () => {
  assert.equal(extensionLabel("Chrome nhà", {}).text, "Chrome nhà");
});

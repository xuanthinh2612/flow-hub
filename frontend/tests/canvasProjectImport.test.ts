import assert from "node:assert/strict";
import { test } from "node:test";

import { isAutoGenEnabled } from "../src/services/autoGen.ts";

test("auto_gen only enables automatic Run All for boolean true", () => {
  assert.equal(isAutoGenEnabled(true), true);
  assert.equal(isAutoGenEnabled(false), false);
  assert.equal(isAutoGenEnabled(undefined), false);
  assert.equal(isAutoGenEnabled("true"), false);
  assert.equal(isAutoGenEnabled(1), false);
  assert.equal(isAutoGenEnabled(null), false);
});

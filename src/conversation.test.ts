import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewCommand } from "./conversation.js";

test("parseReviewCommand detects normal review", () => {
  assert.deepEqual(parseReviewCommand("/ai-review"), { type: "review", full: false });
});

test("parseReviewCommand detects full review", () => {
  assert.deepEqual(parseReviewCommand("/ai-review full"), { type: "review", full: true });
});

test("parseReviewCommand detects explain target", () => {
  assert.deepEqual(parseReviewCommand("/ai-review explain src/app.ts:42"), {
    type: "explain",
    target: "src/app.ts:42"
  });
});

test("parseReviewCommand detects ci command", () => {
  assert.deepEqual(parseReviewCommand("/ai-review ci"), { type: "ci" });
});

test("parseReviewCommand ignores normal comments", () => {
  assert.deepEqual(parseReviewCommand("Can you check this?"), { type: "none" });
});

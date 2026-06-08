import assert from "node:assert/strict";
import test from "node:test";
import { createFindingFingerprint, renderFingerprintMarker, withFingerprints } from "./fingerprint.js";
import type { Finding } from "./types.js";

const finding: Finding = {
  file: "src/example.ts",
  line: 10,
  severity: "high",
  title: "Missing validation",
  body: "This accepts unsafe input."
};

test("createFindingFingerprint is stable for equivalent text", () => {
  const sameFinding: Finding = {
    ...finding,
    title: "  Missing   validation ",
    body: "This accepts unsafe input."
  };

  assert.equal(createFindingFingerprint(finding), createFindingFingerprint(sameFinding));
});

test("withFingerprints preserves existing fingerprints", () => {
  const result = withFingerprints([{ ...finding, fingerprint: "abc123" }]);

  assert.equal(result[0]?.fingerprint, "abc123");
});

test("renderFingerprintMarker emits an HTML marker", () => {
  assert.equal(
    renderFingerprintMarker("abc123"),
    "<!-- crispin-lab-review-bot:finding:abc123 -->"
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildChangedLineMap, filterFindingsToChangedLines } from "./diff.js";
import type { ChangedFile, Finding } from "./types.js";

test("buildChangedLineMap tracks added lines in unified diffs", () => {
  const files: ChangedFile[] = [
    {
      filename: "src/example.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: `@@ -10,5 +10,6 @@ function example() {
 context();
-oldCall();
+newCall();
 keepGoing();
+addedCall();
}`
    }
  ];

  const changedLines = buildChangedLineMap(files).get("src/example.ts");

  assert.deepEqual(changedLines, new Set([11, 13]));
});

test("filterFindingsToChangedLines keeps only findings on changed lines", () => {
  const changedLineMap = new Map([["src/example.ts", new Set([11, 13])]]);
  const findings: Finding[] = [
    {
      file: "src/example.ts",
      line: 11,
      severity: "high",
      title: "Changed line",
      body: "This should be kept."
    },
    {
      file: "src/example.ts",
      line: 12,
      severity: "medium",
      title: "Context line",
      body: "This should be filtered."
    },
    {
      file: "src/example.ts",
      severity: "low",
      title: "File level",
      body: "File-level findings are kept."
    }
  ];

  const result = filterFindingsToChangedLines(findings, changedLineMap);

  assert.equal(result.filteredCount, 1);
  assert.deepEqual(
    result.findings.map((finding) => finding.title),
    ["Changed line", "File level"]
  );
});

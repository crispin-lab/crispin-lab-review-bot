import type { ChangedFile, Finding } from "./types.js";

export type ChangedLineMap = Map<string, Set<number>>;

const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function buildChangedLineMap(files: ChangedFile[]): ChangedLineMap {
  const map: ChangedLineMap = new Map();

  for (const file of files) {
    if (!file.patch) {
      continue;
    }

    const changedLines = parseChangedLines(file.patch);
    if (changedLines.size > 0) {
      map.set(file.filename, changedLines);
    }
  }

  return map;
}

export function filterFindingsToChangedLines(
  findings: Finding[],
  changedLineMap: ChangedLineMap
): { findings: Finding[]; filteredCount: number } {
  const filtered = findings.filter((finding) => {
    if (!finding.line) {
      return true;
    }

    const changedLines = changedLineMap.get(finding.file);
    return changedLines?.has(finding.line) ?? false;
  });

  return {
    findings: filtered,
    filteredCount: findings.length - filtered.length
  };
}

export function parseChangedLines(patch: string): Set<number> {
  const changedLines = new Set<number>();
  let newLine = 0;

  for (const line of patch.split("\n")) {
    const headerMatch = hunkHeader.exec(line);
    if (headerMatch) {
      newLine = Number(headerMatch[1]);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      changedLines.add(newLine);
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }

    if (newLine > 0) {
      newLine += 1;
    }
  }

  return changedLines;
}

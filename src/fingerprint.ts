import { createHash } from "node:crypto";
import type { Finding } from "./types.js";

export function withFingerprints(findings: Finding[]): Finding[] {
  return findings.map((finding) => ({
    ...finding,
    fingerprint: finding.fingerprint ?? createFindingFingerprint(finding)
  }));
}

export function createFindingFingerprint(finding: Finding): string {
  const normalized = [
    finding.file,
    finding.line ?? "file",
    finding.severity,
    normalize(finding.title),
    normalize(finding.body)
  ].join("\n");

  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function renderFingerprintMarker(fingerprint: string): string {
  return `<!-- crispin-lab-review-bot:finding:${fingerprint} -->`;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

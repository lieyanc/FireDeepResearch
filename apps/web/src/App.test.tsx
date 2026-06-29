import { describe, expect, it } from "vitest";
import { bodyRefs, extractArtifactIds, frontmatterRefs } from "./artifactRefs";

describe("artifact reference extraction", () => {
  it("finds generated evidence, audit, critique, and feedback artifact ids once", () => {
    expect(
      extractArtifactIds(
        [
          "final-report links claim-001, source-002, question-003, audit-004, insight-001.",
          "Auto critique auto-deep-dive-001 and manual continuation deep-dive-002 should be clickable.",
          "Trace evidence-ledger-001, contradiction-matrix-001, quality-audit-001, memory-update-001, followup-report-002.",
          "Feedback feedback-1782680000000-deadbeef and duplicate claim-001 should dedupe.",
        ].join(" "),
      ),
    ).toEqual([
      "final-report",
      "claim-001",
      "source-002",
      "question-003",
      "audit-004",
      "insight-001",
      "auto-deep-dive-001",
      "deep-dive-002",
      "evidence-ledger-001",
      "contradiction-matrix-001",
      "quality-audit-001",
      "memory-update-001",
      "followup-report-002",
      "feedback-1782680000000-deadbeef",
    ]);
  });

  it("extracts relationship ids from frontmatter and body helpers", () => {
    expect(
      frontmatterRefs({
        sources: ["source-001", 123, "source-002"],
        source: "source-003",
        target: "final-report",
        question_id: "question-001",
        artifact_id: "claim-001",
        opposes: ["claim-002"],
        ignored: "source-999",
      }),
    ).toEqual(["source-001", "source-002", "source-003", "final-report", "question-001", "claim-001", "claim-002"]);

    expect(bodyRefs("source-001 source-001 claim-002 and not-an-artifact")).toEqual(["source-001", "claim-002"]);
  });
});

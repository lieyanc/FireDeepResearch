export const artifactIdPattern =
  /\b(?:source|claim|question|audit|insight|critique)-\d{3}\b|\bfeedback-\d+(?:-[a-f0-9]{8})?\b|\b(?:final-report|research-plan|blackboard|user-input|evidence-ledger-\d{3}|contradiction-matrix-\d{3}|quality-audit-\d{3}|memory-update-\d{3}|auto-deep-dive-\d{3}|deep-dive-\d{3}|followup-report-\d{3})\b/g;

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" && value ? [value] : [];
}

export function frontmatterRefs(frontmatter: Record<string, unknown>): string[] {
  return [
    ...asStringArray(frontmatter.sources),
    ...asStringArray(frontmatter.source),
    ...asStringArray(frontmatter.target),
    ...asStringArray(frontmatter.question_id),
    ...asStringArray(frontmatter.artifact_id),
    ...asStringArray(frontmatter.opposes),
  ];
}

export function extractArtifactIds(body: string): string[] {
  return [...new Set(body.match(artifactIdPattern) ?? [])];
}

export function bodyRefs(body: string): string[] {
  return extractArtifactIds(body);
}

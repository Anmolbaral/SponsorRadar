import type { WinbackReport } from "@/src/radar/domain/types";

export interface ReportQualityResult {
  evidenceAttributionRate: number;
  knownFalsePositiveLeads: number;
  paddedResults: number;
  cautiousLanguageViolations: number;
  coverageWarningsVisible: boolean;
  passed: boolean;
}

const CAUTION_VIOLATIONS = [
  /stopped sponsoring/i,
  /definitely (?:has|is|will)/i,
  /the same buyer is active/i,
  /the campaign is active/i
];

export function evaluateReportQuality(
  report: WinbackReport,
  options: {
    expectedQualifiedLeads: number;
    allowedLeadKeys: string[];
  }
): ReportQualityResult {
  const attributable = report.leads.filter(
    (lead) =>
      hasAttributableEvidence(lead.targetEvidence) &&
      hasAttributableEvidence(lead.peerEvidence)
  ).length;
  const evidenceAttributionRate =
    report.leads.length === 0 ? 1 : attributable / report.leads.length;
  const allowed = new Set(options.allowedLeadKeys);
  const knownFalsePositiveLeads = report.leads.filter(
    (lead) => !allowed.has(`${lead.domain}|${lead.peer}`)
  ).length;
  const paddedResults = Math.max(
    0,
    report.leads.length - options.expectedQualifiedLeads
  );
  const cautiousLanguageViolations = report.leads.filter((lead) =>
    CAUTION_VIOLATIONS.some((pattern) =>
      pattern.test(lead.outreachHypothesis)
    )
  ).length;
  const coverageWarningsVisible = report.coverage.some(
    (notice) => notice.severity === "warning"
  );

  return {
    evidenceAttributionRate,
    knownFalsePositiveLeads,
    paddedResults,
    cautiousLanguageViolations,
    coverageWarningsVisible,
    passed:
      evidenceAttributionRate === 1 &&
      knownFalsePositiveLeads === 0 &&
      paddedResults === 0 &&
      cautiousLanguageViolations === 0 &&
      coverageWarningsVisible
  };
}

function hasAttributableEvidence(evidence: {
  contentUrl: string;
  publishedDate: string;
  excerpt: string;
}): boolean {
  return (
    /^https:\/\//.test(evidence.contentUrl) &&
    /^\d{4}-\d{2}-\d{2}$/.test(evidence.publishedDate) &&
    evidence.excerpt.trim().length > 0
  );
}

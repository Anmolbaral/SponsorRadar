import type { WinbackReport } from "@/src/radar/domain/types";

export interface ReportQualityResult {
  evidenceAttributionRate: number;
  knownFalsePositiveLeads: number;
  missingExpectedLeads: number;
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
  // A zero-lead report is only "fully attributed" when zero leads were
  // expected. When a lead was expected, an empty report is a regression, not
  // a perfect score, so it must not round up to 1.
  const evidenceAttributionRate =
    report.leads.length === 0
      ? options.expectedQualifiedLeads === 0
        ? 1
        : 0
      : attributable / report.leads.length;
  const allowed = new Set(options.allowedLeadKeys);
  const knownFalsePositiveLeads = report.leads.filter(
    (lead) => !allowed.has(`${lead.domain}|${lead.peer}`)
  ).length;
  const presentAllowedLeadKeys = new Set(
    report.leads
      .map((lead) => `${lead.domain}|${lead.peer}`)
      .filter((key) => allowed.has(key))
  );
  const missingExpectedLeads = Math.max(
    0,
    options.expectedQualifiedLeads - presentAllowedLeadKeys.size
  );
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
    missingExpectedLeads,
    paddedResults,
    cautiousLanguageViolations,
    coverageWarningsVisible,
    passed:
      evidenceAttributionRate === 1 &&
      knownFalsePositiveLeads === 0 &&
      missingExpectedLeads === 0 &&
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

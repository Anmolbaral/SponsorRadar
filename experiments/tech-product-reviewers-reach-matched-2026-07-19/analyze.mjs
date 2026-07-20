import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const experimentDir = path.dirname(fileURLToPath(import.meta.url));

async function readJson(relativePath) {
  return JSON.parse(
    await readFile(path.join(experimentDir, relativePath), "utf8"),
  );
}

function normalizeDomain(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const candidate = value.includes("://") ? value : `https://${value}`;
  try {
    return new URL(candidate).hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, "");
  } catch {
    return null;
  }
}

function groupByDomain(rows) {
  const groups = new Map();
  for (const row of rows) {
    const domain = normalizeDomain(row.sponsor_domain);
    if (!domain) continue;
    const existing = groups.get(domain) ?? [];
    existing.push(row);
    groups.set(domain, existing);
  }
  return groups;
}

function newestRow(rows) {
  return [...rows].sort((a, b) =>
    a.most_recent_ad.published_date.localeCompare(
      b.most_recent_ad.published_date,
    ),
  ).at(-1);
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

const config = await readJson("config.json");
const verification = await readJson("verification.json");
const targetPayload = await readJson(config.target.cached_raw_file);
const firstPilot = await readJson(
  "../tech-product-reviewers-2026-07-19/derived/analysis.json",
);

const targetGroups = groupByDomain(targetPayload.results);
const targetDomains = [...targetGroups.entries()].map(([domain, rows]) => {
  const latest = newestRow(rows);
  return {
    domain,
    latest_observed: latest.most_recent_ad.published_date,
    latest_type: latest.most_recent_ad.sponsor_type,
    latest_row: latest,
  };
});
const staleTargetDomains = targetDomains.filter(
  (row) => row.latest_observed < config.stale_cutoff_exclusive,
);
const apiExplicitStaleTargets = staleTargetDomains.filter(
  (row) => row.latest_type === "explicit_ad",
);

const peerPayloads = await Promise.all(
  config.peers.map(async (peer) => ({
    peer,
    payload: await readJson(peer.raw_file),
  })),
);

const inventoryByKey = new Map(
  verification.peer_inventory.map((row) => [
    `${row.channel}|${row.api_partner_name}`,
    row,
  ]),
);

const peerRows = peerPayloads.flatMap(({ peer, payload }) =>
  payload.results.map((row) => {
    const inventory = inventoryByKey.get(`${peer.name}|${row.partner_name}`);
    return {
      peer: peer.name,
      partner_name: row.partner_name,
      api_domain: normalizeDomain(row.sponsor_domain),
      resolved_domain:
        normalizeDomain(row.sponsor_domain) ??
        normalizeDomain(inventory?.manually_resolved_domain),
      api_type: row.most_recent_ad.sponsor_type,
      latest_observed: row.most_recent_ad.published_date,
      latest_placement: row.most_recent_ad,
      strict_classification: inventory?.strict_classification ?? "SU",
      inventory,
    };
  }),
);

const joinableStrictPeerRows = peerRows.filter(
  (row) => row.strict_classification === "S3" && row.resolved_domain,
);
const rawMatches = joinableStrictPeerRows
  .filter((peerRow) =>
    staleTargetDomains.some(
      (targetRow) => targetRow.domain === peerRow.resolved_domain,
    ),
  )
  .map((peerRow) => {
    const target = staleTargetDomains.find(
      (row) => row.domain === peerRow.resolved_domain,
    );
    const manual = verification.overlaps.find(
      (row) => row.domain === peerRow.resolved_domain,
    );
    return {
      domain: peerRow.resolved_domain,
      target,
      peer: peerRow,
      manual_verification: manual ?? null,
      strict_pass:
        manual?.gate_result === "strict_pass" &&
        ["A", "B"].includes(manual?.product_line_continuity_grade),
    };
  });

const strictPasses = rawMatches.filter((row) => row.strict_pass);
const targetSubscriberCount = config.target.subscriber_count;
const reach = config.peers.map((peer) => ({
  name: peer.name,
  subscriber_count: peer.subscriber_count,
  ratio_to_target: Number(
    (peer.subscriber_count / targetSubscriberCount).toFixed(3),
  ),
  percent_difference: Number(
    (
      ((peer.subscriber_count - targetSubscriberCount) /
        targetSubscriberCount) *
      100
    ).toFixed(1),
  ),
}));

const output = {
  generated_at: new Date().toISOString(),
  as_of: config.as_of,
  method: {
    cached_target_history: true,
    peer_filter: config.sponsor_types,
    strict_gate:
      "S3 target + S3 peer + product-line continuity grade A or B",
  },
  target: config.target,
  reach,
  counts: {
    cached_target_api_rows: targetPayload.results.length,
    stale_domain_resolved_targets: staleTargetDomains.length,
    stale_api_explicit_target_candidates: apiExplicitStaleTargets.length,
    strict_peer_api_rows: peerRows.length,
    manually_confirmed_s3_peer_rows: peerRows.filter(
      (row) => row.strict_classification === "S3",
    ).length,
    joinable_s3_peer_rows: joinableStrictPeerRows.length,
    raw_domain_matches: rawMatches.length,
    strict_product_continuous_passes: strictPasses.length,
    brand_research_reports: config.brand_research_domains.length,
  },
  peer_inventory: peerRows,
  overlaps: rawMatches,
  comparison_to_first_pilot: {
    first_pilot_raw_domain_overlaps: firstPilot.counts.raw_domain_overlaps,
    first_pilot_inclusive_accepted: firstPilot.counts.manually_accepted_overlaps,
    first_pilot_strict_passes_under_new_rubric:
      verification.first_pilot_reclassification.strict_passes,
    second_pilot_raw_domain_matches: rawMatches.length,
    second_pilot_strict_passes: strictPasses.length,
  },
};

await writeFile(
  path.join(experimentDir, "derived", "analysis.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);

const headers = [
  "domain",
  "target_latest",
  "target_class",
  "peer",
  "peer_latest",
  "peer_class",
  "continuity_grade",
  "gate_result",
  "target_product_line",
  "peer_product_line",
];
const rows = strictPasses.map((row) => [
  row.domain,
  row.target.latest_observed,
  row.manual_verification?.target_classification,
  row.peer.peer,
  row.peer.latest_observed,
  row.manual_verification?.peer_classification,
  row.manual_verification?.product_line_continuity_grade,
  row.manual_verification?.gate_result,
  row.manual_verification?.target_product_line,
  row.manual_verification?.peer_product_line,
]);
const csv = [
  headers.map(csvCell).join(","),
  ...rows.map((row) => row.map(csvCell).join(",")),
].join("\n");

await writeFile(
  path.join(experimentDir, "derived", "strict-overlaps.csv"),
  `${csv}\n`,
);

console.log(
  `Wrote ${rawMatches.length} raw match and ${strictPasses.length} strict product-continuous pass.`,
);

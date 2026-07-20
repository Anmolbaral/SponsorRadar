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

function newestRow(rows) {
  return [...rows].sort((a, b) =>
    a.most_recent_ad.published_date.localeCompare(
      b.most_recent_ad.published_date,
    ),
  ).at(-1);
}

function groupByDomain(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const domain = normalizeDomain(row.sponsor_domain);
    if (!domain) continue;
    const domainRows = grouped.get(domain) ?? [];
    domainRows.push(row);
    grouped.set(domain, domainRows);
  }

  return grouped;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

const config = await readJson("config.json");
const verification = await readJson("verification.json");
const targetPayload = await readJson(config.target.raw_file);

const peerPayloads = await Promise.all(
  config.peers.map(async (peer) => ({
    peer,
    payload: await readJson(peer.raw_file),
  })),
);

const targetGroups = groupByDomain(targetPayload.results);
const targetDomains = [...targetGroups.entries()].map(([domain, rows]) => {
  const latest = newestRow(rows);
  return {
    domain,
    partner_names: [...new Set(rows.map((row) => row.partner_name))].sort(),
    latest_observed: latest.most_recent_ad.published_date,
    total_ads_found: rows.reduce(
      (sum, row) => sum + (row.total_ads_found ?? 0),
      0,
    ),
    latest_placement: latest.most_recent_ad,
  };
});

const staleTargetDomains = targetDomains.filter(
  (row) => row.latest_observed < config.stale_cutoff_exclusive,
);

const peerRows = peerPayloads.flatMap(({ peer, payload }) =>
  payload.results.map((row) => ({
    ...row,
    selected_peer_name: peer.name,
  })),
);
const peerGroups = groupByDomain(peerRows);

const rawOverlaps = staleTargetDomains
  .filter((target) => peerGroups.has(target.domain))
  .map((target) => {
    const matches = peerGroups.get(target.domain);
    const peers = [...new Set(matches.map((row) => row.selected_peer_name))];
    const peerLatest = newestRow(matches);

    return {
      ...target,
      peer_count: peers.length,
      peers: peers.sort(),
      peer_latest_observed: peerLatest.most_recent_ad.published_date,
      peer_total_ads_found: matches.reduce(
        (sum, row) => sum + (row.total_ads_found ?? 0),
        0,
      ),
      peer_placements: matches.map((row) => ({
        peer: row.selected_peer_name,
        partner_name: row.partner_name,
        total_ads_found: row.total_ads_found,
        most_recent_ad: row.most_recent_ad,
      })),
    };
  })
  .sort(
    (a, b) =>
      b.peer_count - a.peer_count ||
      b.total_ads_found - a.total_ads_found ||
      b.peer_total_ads_found - a.peer_total_ads_found ||
      b.peer_latest_observed.localeCompare(a.peer_latest_observed),
  );

const verificationByDomain = new Map(
  verification.overlaps.map((row) => [row.domain, row]),
);
const verifiedOverlaps = rawOverlaps.map((row) => ({
  ...row,
  manual_verification: verificationByDomain.get(row.domain) ?? null,
  selected_for_brand_research: config.top_three_domains.includes(row.domain),
}));

const output = {
  generated_at: new Date().toISOString(),
  as_of: config.as_of,
  windows: {
    target: config.target_window,
    stale_cutoff_exclusive: config.stale_cutoff_exclusive,
    peers: config.peer_window,
  },
  target: config.target,
  peers: config.peers,
  counts: {
    target_api_rows: targetPayload.results.length,
    target_domain_resolved: targetDomains.length,
    target_domain_unresolved_rows:
      targetPayload.results.length -
      targetPayload.results.filter((row) => normalizeDomain(row.sponsor_domain))
        .length,
    stale_domain_resolved: staleTargetDomains.length,
    peer_api_rows: peerRows.length,
    peer_domain_resolved: peerGroups.size,
    raw_domain_overlaps: rawOverlaps.length,
    manually_accepted_overlaps: verifiedOverlaps.filter((row) =>
      row.manual_verification?.inclusive_scope_status.startsWith("pass"),
    ).length,
    rejected_overlaps: verifiedOverlaps.filter(
      (row) => row.manual_verification?.inclusive_scope_status === "reject",
    ).length,
  },
  overlaps: verifiedOverlaps,
  top_three_domains: config.top_three_domains,
};

await writeFile(
  path.join(experimentDir, "derived", "analysis.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);

const csvHeaders = [
  "domain",
  "target_latest",
  "target_ads",
  "peer_count",
  "peers",
  "peer_latest",
  "peer_ads",
  "manual_status",
  "strict_paid_status",
  "brand_research",
];
const csvRows = verifiedOverlaps.map((row) => [
  row.domain,
  row.latest_observed,
  row.total_ads_found,
  row.peer_count,
  row.peers.join("; "),
  row.peer_latest_observed,
  row.peer_total_ads_found,
  row.manual_verification?.inclusive_scope_status,
  row.manual_verification?.strict_paid_sponsorship_status,
  row.selected_for_brand_research ? "yes" : "no",
]);
const csv = [
  csvHeaders.map(csvCell).join(","),
  ...csvRows.map((row) => row.map(csvCell).join(",")),
].join("\n");

await writeFile(
  path.join(experimentDir, "derived", "overlaps.csv"),
  `${csv}\n`,
);

console.log(
  `Wrote ${rawOverlaps.length} overlaps (${output.counts.manually_accepted_overlaps} accepted, ${output.counts.rejected_overlaps} rejected).`,
);

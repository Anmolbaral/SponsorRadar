import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const experimentDir = path.dirname(fileURLToPath(import.meta.url));
const apiBase = "https://api.upriver.ai/v1";
const apiKey = process.env.UPRIVER_API_KEY;

if (!apiKey) {
  throw new Error(
    "UPRIVER_API_KEY is required. From the repository root, run with: node --env-file=.env experiments/tech-product-reviewers-reach-matched-2026-07-19/collect-peers.mjs",
  );
}

const config = JSON.parse(
  await readFile(path.join(experimentDir, "config.json"), "utf8"),
);

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "X-API-Key": apiKey,
      ...options.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return JSON.parse(text);
}

async function writeJson(relativePath, value) {
  const outputPath = path.join(experimentDir, relativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchStrictSponsors(peer) {
  const results = [];
  let cursor = null;

  do {
    const url = new URL(`${apiBase}/sponsors`);
    url.searchParams.set("publication_url", peer.url);
    url.searchParams.set("platforms", "youtube");
    url.searchParams.set("since", config.peer_window.since);
    url.searchParams.set("until", config.peer_window.until);
    url.searchParams.set("sponsor_types", "explicit_ad");
    url.searchParams.set("include_evidence", "true");
    url.searchParams.set("limit", "50");
    if (cursor) url.searchParams.set("cursor", cursor);

    const page = await apiFetch(url);
    results.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);

  return {
    results,
    total_count: results.length,
    has_more: false,
    next_cursor: null,
  };
}

for (const peer of config.peers) {
  const payload = await fetchStrictSponsors(peer);
  await writeJson(peer.raw_file, payload);
}

const profiles = await apiFetch(`${apiBase}/creators/batch`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ urls: config.peers.map((peer) => peer.url) }),
});
await writeJson("raw/creator-profiles.json", profiles);

for (const domain of config.brand_research_domains) {
  const research = await apiFetch(`${apiBase}/brand/research`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brand_url: `https://${domain}` }),
  });
  await writeJson(
    `raw/brand-research/${domain.split(".")[0]}.json`,
    research,
  );
}

console.log(
  "Collected only the three peers' strict 90-day sponsor sets, peer profiles, and the qualifying brand report. The cached target history was not refetched.",
);

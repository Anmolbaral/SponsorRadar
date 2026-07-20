import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const experimentDir = path.dirname(fileURLToPath(import.meta.url));
const rawDir = path.join(experimentDir, "raw");
const apiBase = "https://api.upriver.ai/v1";
const apiKey = process.env.UPRIVER_API_KEY;

if (!apiKey) {
  throw new Error(
    "UPRIVER_API_KEY is required. From the repository root, run with: node --env-file=.env experiments/tech-product-reviewers-2026-07-19/collect.mjs",
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

async function fetchSponsors(publicationUrl, window) {
  const allResults = [];
  let cursor = null;
  let trackingStatus = null;

  do {
    const url = new URL(`${apiBase}/sponsors`);
    url.searchParams.set("publication_url", publicationUrl);
    url.searchParams.set("platforms", "youtube");
    url.searchParams.set("since", window.since);
    url.searchParams.set("until", window.until);
    url.searchParams.set("include_evidence", "true");
    url.searchParams.set("limit", "50");
    if (cursor) url.searchParams.set("cursor", cursor);

    const page = await apiFetch(url);
    allResults.push(...page.results);
    trackingStatus ??= page.tracking_status ?? null;
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);

  return {
    results: allResults,
    total_count: allResults.length,
    has_more: false,
    next_cursor: null,
    tracking_status: trackingStatus,
  };
}

async function writeJson(relativePath, value) {
  const outputPath = path.join(experimentDir, relativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

await mkdir(rawDir, { recursive: true });

const targetSponsors = await fetchSponsors(
  config.target.url,
  config.target_window,
);
await writeJson(config.target.raw_file, targetSponsors);

for (const peer of config.peers) {
  const peerSponsors = await fetchSponsors(peer.url, config.peer_window);
  await writeJson(peer.raw_file, peerSponsors);
}

const profiles = await apiFetch(`${apiBase}/creators/batch`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    urls: [config.target.url, ...config.peers.map((peer) => peer.url)],
  }),
});
await writeJson("raw/creator-profiles.json", profiles);

await Promise.all(
  config.top_three_domains.map(async (domain) => {
    const research = await apiFetch(`${apiBase}/brand/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand_url: `https://${domain}` }),
    });
    const filename = domain.split(".")[0];
    await writeJson(`raw/brand-research/${filename}.json`, research);
  }),
);

console.log(
  `Collected ${targetSponsors.results.length} target sponsor rows, three peer sets, four creator profiles, and three brand reports.`,
);

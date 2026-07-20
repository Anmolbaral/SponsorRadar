---
name: upriver
description: "API for real-time context on creators, audiences, brands, trends, and sponsorships."
metadata:
    mintlify-proj: upriver
    version: "1.0.0"
---

## Capabilities

Upriver gives AI agents structured consumer context via a REST API. Use it to:
understand brands, products, and their audiences,
find creators and sponsorship relationships,
and track trending formats and emerging topics.
All responses are JSON with cursor-based pagination on list endpoints.

## Skills

Each endpoint lists key parameters; follow the linked reference for the complete parameter set and response schema.

### Brands

- **Brand Research** (`POST /v1/brand/research`): Get brand identity, positioning, and brand language. Provide brand_url (brand website URL) or brand_name; at least one is required.
  - Key parameters: Body — `brand_url`, `brand_name` — [full reference](https://docs.upriver.ai/api-reference/brands/brand-research)

### Products

- **Product Details** (`POST /v1/brand/product`): Get details for a specific product. Requires product_name and at least one of product_url, brand_url, or brand_name. Provide as much as you have — more context improves results. Use values from the /v1/brand/products response when chaining.
  - Key parameters: Body — `product_name`*, `product_url`, `brand_url`, `brand_name` — [full reference](https://docs.upriver.ai/api-reference/products/product-details)
- **Products List** (`POST /v1/brand/products`): Get a paginated list of products for a brand. Provide brand_url on every request, including when paging. Returns a best-effort exhaustive list; limit defaults to 10, so raise it to get more products per page.
  - Key parameters: Body — `brand_url`*, `limit`, `cursor` — [full reference](https://docs.upriver.ai/api-reference/products/products-list)

### Creators

- **Creator Profile by URL** (`GET /v1/creators`): Lookup a creator profile by social media profile URL. Returns the same payload shape as /v1/creators/`{creator_id}`; only the lookup key differs. Use `include` for optional enrichments (`engagement_metrics`, `video_metrics`, `relative_metrics`, `bio`, `audience`, `brand_safety`).
  - Parameters: `url`*, `include` — [full reference](https://docs.upriver.ai/api-reference/creators/creator-profile-by-url)
- **Batch Creator Details** (`POST /v1/creators/batch`): Look up 1-10 creators at once by social media profile URL. Body takes a urls array of profile URLs (e.g., urls: ['https://...', ...]). Useful when checking multiple creators from sponsorship results or batch processing. Note: engagement metrics are not available in batch responses.
  - Key parameters: Body — `urls`* — [full reference](https://docs.upriver.ai/api-reference/creators/batch-creator-details)
- **Search** (`POST /v1/creators/search`): Find creators by exact lookup or resolve one by name/handle, then narrow with filters. Provide one of: `creator_url` for an exact profile; `name_or_handle` to resolve a creator by handle or display name (matches exactly, by prefix, and by fuzzy substring — 'beast' finds 'MrBeast'); or filter-only browse, which requires `follower_bucket` plus `categories` or `category_ids`. `follower_bucket` takes one or more of: under_5k, 5k_10k, 10k_50k, 50k_100k, 100k_300k, 300k_1m, over_1m (combine to span a range). `categories` is free text; `category_ids` are exact taxonomy ids. Use the category/platform/follower filters for discovery — `name_or_handle` finds a specific creator, not a topic. Only filter-only browse is paginated.
  - Key parameters: Body — `creator_url`, `name_or_handle`, `content_query`, `categories`, `category_ids`, `follower_bucket`, `platforms`, `creator_country`, `audience_country`, `creator_language`, `cursor` — [full reference](https://docs.upriver.ai/api-reference/creators/search)
  - Returns: Returns a results array; each result has a channels array (platform, handle, url, subscriber_count, follower_bucket) plus a score, and next_cursor for filter-only browse.
- **Find Similar Creators (Beta)** (`POST /v1/creators/similar`): Find canonical creators who make content similar to an anchor creator. Provide exactly one of: `creator_id` (from another creator endpoint) for similarity across that creator's channel cluster, or `channel_url` for a single channel. Optional `platforms` (instagram, tiktok, youtube), `category_ids`, `min_followers`/`max_followers`, `creator_country`, and `match_content_language` constrain the peers. Results are ordered by shared niche and audience fit; the first channel on each result is the one that qualified it. Beta: the response shape may change.
  - Parameters: Body: `CreatorSimilarInput` — [full reference](https://docs.upriver.ai/api-reference/creators/find-similar-creators-beta)
- **Creator Profile by ID** (`GET /v1/creators/{creator_id}`): Lookup a creator profile by Upriver creator ID. Returns the same payload shape as /v1/creators; only the lookup key differs. Merged IDs return redirect metadata in the response body/header. Use `include` for optional enrichments (`engagement_metrics`, `video_metrics`, `relative_metrics`, `bio`, `audience`, `brand_safety`).
  - Parameters: `creator_id`*, `include` — [full reference](https://docs.upriver.ai/api-reference/creators/creator-profile-by-id)

### Audience

- **Dimensions** (`POST /v1/audience_dimensions`): Extract atomic behavioral, motivational, and lifestyle dimensions for a brand's audience. Input: brand_url. Returns granular longtail audience facts useful for programmatic matching. Slower than Personas due to extensive research. In most cases, prefer /v3/audience_insights unless granular dimension-level data is specifically needed. Rate limited to 1 request per minute.
  - Key parameters: Body — `brand_url`* — [full reference](https://docs.upriver.ai/api-reference/audience/dimensions)
- **Personas (v3)** (`POST /v3/audience_insights`): Generate a list of audience personas for a brand, grounded in real online conversations. Provide brand_url. Each persona includes purchase triggers, barriers, behaviors, language patterns, and real-world citations. include_citations defaults to true (set false to omit); query is an optional focus hint; set effort=high for broader, deeper research (default auto). Generation can take roughly 15-25s.
  - Key parameters: Body — `brand_url`*, `query`, `include_citations`, `effort` — [full reference](https://docs.upriver.ai/api-reference/audience/personas-v3)

### Sponsorships

- **Sponsors** (`GET /v1/sponsors`): Discover brands that recently sponsored content. Provide exactly one scope filter: categories (free text, matched to the nearest vertical and echoed back as industry_category) or publication_url (a specific creator's channel or newsletter). Optionally narrow by platforms, sponsor_type, and a date window (since/until as YYYY-MM-DD; defaults to the last 90 days). Set include_evidence=true for the ad excerpt. Returns matching brands, each with an example of their latest placement. Use /v1/sponsorships for individual placement rows.
  - Key parameters: `categories`, `publication_url`, `platforms`, `sponsor_type`, `include_evidence`, `since`, `until`, `limit`, `cursor` — [full reference](https://docs.upriver.ai/api-reference/sponsorships/sponsors)
- **Sponsorships** (`GET /v1/sponsorships`): Return individual sponsored placements (content-level rows). Provide at least one selector: sponsor_name, publication_url, or categories (free text, matched to the nearest vertical). These can be combined, except publication_url and categories cannot be used together. Optionally narrow by platforms, sponsor_type, and a date window (since/until as YYYY-MM-DD; defaults to the last 90 days). Set include_evidence=true for the ad excerpt.
  - Key parameters: `sponsor_name`, `publication_url`, `categories`, `platforms`, `sponsor_type`, `include_evidence`, `include_inferred`, `since`, `until`, `limit`, `cursor` — [full reference](https://docs.upriver.ai/api-reference/sponsorships/sponsorships)

### Trends

- **Trends List** (`POST /v2/trends/broad`): Get the latest trending TikTok video formats and templates — the primary endpoint for trend discovery. Trends are sourced from TikTok but are useful for ideation across platforms (Instagram Reels, YouTube Shorts, etc.). Filter by uses_specific_sound, participation_type, content_structure, has_text_template, include/exclude tags (e.g., exclude_tags=['nsfw']), and duration range. Each trend in the response has an id field — use it as the trend_id path parameter for the trend details, media, and playback endpoints.
  - Key parameters: Body — `commercial_music_status`, `uses_specific_sound`, `participation_type`, `content_structure`, `sort_by`, `has_text_template`, `tags`, `exclude_tags`, `min_duration`, `max_duration`, `cursor` — [full reference](https://docs.upriver.ai/api-reference/trends/trends-list)
- **Trend Details** (`GET /v2/trends/{trend_id}`): Get full details for a specific trend by ID, including description, metrics, and metadata. Use after discovering trends via /v2/trends/broad.
  - Parameters: `trend_id`* — [full reference](https://docs.upriver.ai/api-reference/trends/trend-details)
- **Media Samples** (`GET /v2/trends/{trend_id}/media`): Get video samples for a trend — returns URLs to example TikTok videos demonstrating the trend. Filter by kind (video, audio) and limit the number of samples.
  - Parameters: `trend_id`*, `kind`, `limit` — [full reference](https://docs.upriver.ai/api-reference/trends/media-samples)
- **Audio Playback** (`GET /v2/trends/{trend_id}/playback`): Get the top associated audio playback URL for a trend's sound. Use when the user wants the audio/music behind a trend rather than full video samples.
  - Parameters: `trend_id`*, `media_key` — [full reference](https://docs.upriver.ai/api-reference/trends/audio-playback)
- **Similar Trends** (`GET /v2/trends/{trend_id}/similar`): Find trends similar to a given trend. Use a trend_id from /v2/trends/broad results. Returns up to limit (default 5, max 20) related trends ranked by similarity.
  - Parameters: `trend_id`*, `limit` — [full reference](https://docs.upriver.ai/api-reference/trends/similar-trends)
- **Traction Graph** (`GET /v2/trends/{trend_id}/traction`): Get the traction graph for a trend — returns pre-computed estimated traction curves, plus the underlying blended activity curves, for both the full time range and a focused recent window.
  - Parameters: `trend_id`*, `metadata_mode` — [full reference](https://docs.upriver.ai/api-reference/trends/traction-graph)

### Breakout Topics

- **List Breakout Entities** (`GET /v1/entities/breakout`): List players or teams that are breaking out right now, ranked by how much their current coverage exceeds their own typical level. Set entity_type=player or entity_type=team. Use sort=recommended (default, balanced) for the front page, sort=rising for biggest movers vs their own baseline, sort=top for the highest absolute volume, or sort=newest for the most recently appeared. Pass tag to filter to one sport or other tag (discover values from /entities/breakout/tags).
  - Key parameters: `entity_type`*, `sort`, `vertical`, `tag`, `limit` — [full reference](https://docs.upriver.ai/api-reference/breakout-topics/list-breakout-entities)
- **List Breakout Entity Tags** (`GET /v1/entities/breakout/tags`): List the tags you can filter the breakout entity list by — e.g. the sports present among the currently-breaking entities, with how many carry each. Pass a returned tag back as the 'tag' parameter on /entities/breakout. Set relation=sport (default) for sports.
  - Key parameters: `entity_type`*, `relation`, `vertical`, `locale` — [full reference](https://docs.upriver.ai/api-reference/breakout-topics/list-breakout-entity-tags)
- **Get Breakout Entity** (`GET /v1/entities/{entity_id}/breakout`): Get one entity's current breaking topics and recent activity. Use the entity_id returned by the list endpoint.
  - Parameters: `entity_id`*, `sort`, `temporal_status` — [full reference](https://docs.upriver.ai/api-reference/breakout-topics/get-breakout-entity)
- **List Breakout Topics** (`GET /v1/topics/breakout`): List emerging topics gaining traction in online communities. Filter by vertical — only valid values are: tech, sports, politics. Category filtering is currently only supported for sports in topic mode. Also filter by status (e.g., status=emerging for newly rising topics). Use surface_mode=story to return deduped derived story surfaces instead of raw topics.
  - Key parameters: `vertical`, `category`, `status`, `limit`, `cursor`, `surface_mode`, `include` — [full reference](https://docs.upriver.ai/api-reference/breakout-topics/list-breakout-topics)
- **Get Breakout Topics Metadata** (`GET /v1/topics/breakout/metadata`): Get available breakout topic filters. Valid verticals are: tech, sports, politics. Category filters are currently only supported for the sports vertical.
  - [Full reference](https://docs.upriver.ai/api-reference/breakout-topics/get-breakout-topics-metadata)
- **List Narratives** (`GET /v1/topics/breakout/narratives`): List narrative arcs that group related breakout topics. Ordered by most recently updated.
  - Parameters: `vertical`, `limit`, `offset` — [full reference](https://docs.upriver.ai/api-reference/breakout-topics/list-narratives)
- **Get Narrative** (`GET /v1/topics/breakout/narratives/{narrative_id}`): Get a narrative arc with its member breakout topics. Use a narrative_id from `GET /v1/topics/breakout/narratives`.
  - Parameters: `narrative_id`*, `include` — [full reference](https://docs.upriver.ai/api-reference/breakout-topics/get-narrative)
- **Search Breakout Topics** (`POST /v1/topics/breakout/search`): Search for specific breakout topics by keyword within a vertical. Use when looking for topics about a particular subject (e.g., search 'AI' within the tech vertical). Uses hybrid search for relevance.
  - Key parameters: Body — `query`*, `vertical`, `mode`, `surface_mode`, `limit`, `include`, `query_context`, `kalshi_event_url` — [full reference](https://docs.upriver.ai/api-reference/breakout-topics/search-breakout-topics)
- **Find Similar Topics** (`POST /v1/topics/breakout/similar`): Find topics similar to a given topic by semantic similarity. Use a topic_id from `GET /v1/topics/breakout` or `POST /v1/topics/breakout/search`.
  - Key parameters: Body — `topic_id`*, `limit`, `include` — [full reference](https://docs.upriver.ai/api-reference/breakout-topics/find-similar-topics)
- **Get Breakout Topic** (`GET /v1/topics/breakout/{topic_id}`): Get full details for a single breakout topic by ID. Use a topic_id from `GET /v1/topics/breakout` or `POST /v1/topics/breakout/search`, not raw query text or domains.
  - Parameters: `topic_id`*, `include` — [full reference](https://docs.upriver.ai/api-reference/breakout-topics/get-breakout-topic)
- **Get Topic Story View** (`GET /v1/topics/breakout/{topic_id}/story`): Get the best available derived story surface around a breakout topic. Use a topic_id from `GET /v1/topics/breakout` or `POST /v1/topics/breakout/search`. Prefers a strict timeline when available, otherwise falls back to a related topical cluster or the topic itself.
  - Parameters: `topic_id`*, `include` — [full reference](https://docs.upriver.ai/api-reference/breakout-topics/get-topic-story-view)

### Taxonomy

- **Media Categories Search** (`POST /v1/categories/search`): Find the most relevant categories from the taxonomy for a given freeform text (e.g., `{ "text": "gaming and esports" }`). Useful for discovering valid category values to pass as filters to the sponsors, sponsorships, and breakout topics endpoints. Returns ordered category matches with confidence scores.
  - Key parameters: Body — `text`* — [full reference](https://docs.upriver.ai/api-reference/taxonomy/media-categories-search)
- **Media Categories** (`GET /v1/media_categories`): Returns the media categories split into L1 (top-level) and L2 (second-level) lists. These categories can be used as a filter for sponsors, sponsorships, and other endpoints.
  - [Full reference](https://docs.upriver.ai/api-reference/taxonomy/media-categories)

## Workflows

### Find Trending Content Opportunities
1. `POST /v2/trends/broad` — browse latest TikTok trends (filter by participation_type, tags, duration)
2. `GET /v2/trends/{trend_id}` — get full trend details and metadata
3. `GET /v2/trends/{trend_id}/media` — get video samples demonstrating the trend
4. `GET /v2/trends/{trend_id}/playback` — get the trend's audio playback URL
5. `GET /v1/topics/breakout` — identify emerging breakout topics across verticals

### Build Audience Understanding
1. `POST /v3/audience_insights` — generate grounded personas with real-world citations (pass brand_url directly)
2. `POST /v1/audience_dimensions` — extract granular behavioral and lifestyle dimensions
3. `POST /v1/categories/search` — classify audience interests via taxonomy

### Analyze Sponsorship Landscape
1. `GET /v1/sponsors` — discover brands sponsoring content (filter by categories, publication_url, platforms)
2. `GET /v1/sponsorships` — get individual sponsored placements (filter by sponsor_name, publication_url, categories)
3. `GET /v1/creators` — get creator profiles for publications in sponsorship results
4. `POST /v1/creators/batch` — batch lookup multiple creators from sponsorship results

## Integration

- **Base URL:** `https://api.upriver.ai`
- **Authentication:** Send your API key in the `X-API-Key` request header (e.g. `X-API-Key: YOUR_KEY`). Request a key at founders@upriver.ai.
- **Format:** JSON request/response
- **Pagination:** Most list endpoints are cursor-based: each response returns a `next_cursor`; send it as the `cursor` parameter to get the next page. `limit` sets page size.
- **Rate limits:** Per-key; see response headers. Note: `/v1/audience_dimensions` is limited to 1 request per minute.
- **Errors:** Error responses return a JSON body with a `detail` field describing the issue. Common codes: `400` (invalid input), `401` (missing or invalid API key), `403` (insufficient permissions), `429` (rate limit exceeded — retry after backoff), `500` (server error — retry with exponential backoff).
- **Effort levels:** Most endpoints support an `effort` parameter. Default (`auto`) is recommended. Use `low` when speed is critical and less detail is acceptable.

## Context

- [API Reference](https://docs.upriver.ai/api-reference)
- [Changelog](https://docs.upriver.ai/changelog)
- [OpenAPI Spec](https://docs.upriver.ai/api-reference/openapi.json)
- [llms.txt](https://docs.upriver.ai/llms.txt)

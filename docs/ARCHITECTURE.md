# System architecture

## One input-to-output flow

```mermaid
flowchart LR
    U["User: YouTube @handle or URL"] --> UI["UI / API route"]
    UI -->|"submit authorizes one bounded run"| W["Persisted run state machine"]
    W --> AP["Internal plan + cohort + per-run credit checkpoints"]
    AP --> UC["Application use case"]
    UC --> P["Policy + credit preflight"]
    P --> T["Upriver tools through typed ports"]
    T --> K["TTL + schema-versioned evidence cache"]
    K --> C["Golden fixture adapter (safe default)"]
    K --> API["Dynamic Upriver adapter (explicit live workflow only)"]
    API --> TR["Exact target resolution"]
    TR --> B["Similar Beta: YouTube, 0.75–1.25 reach"]
    B --> AP
    C --> D["Deterministic evidence pipeline"]
    API --> D
    D --> G{"Qualification policy"}
    G --> F["Fixture: verified S3 + continuity A/B"]
    G --> LQ["Live: explicit ads + exact sponsor domain"]
    F --> R["Canonical 0–3 evidence-backed leads"]
    LQ --> R
    R --> UI
    UC -. "every decision and call" .-> A["Append-only audit trace"]
    T -.-> A
    G -.-> A
    W -.-> S["Atomic snapshots, approvals, credit ledgers, events"]
    AP -.-> S
    K -.-> S
    W --> O["Bounded wording orchestrator"]
    X["Reviewed purpose-bound context"] -.-> O
    O --> L["Tool-free structured-output model"]
    O -. "optional persisted peer rationale" .-> AP
    R --> O
    O -. "compact progress + validated final result" .-> UI
```

The deterministic pipeline — not the LLM — owns dates, joins, sponsorship class,
credit arithmetic, eligibility, result count, state transitions, cache keys,
expiry, idempotency, and per-run credit reservation.

### Current public presentation boundary

The page asks for one **Channel handle or URL**. While that field is editable,
the UI reuses the domain parser to show the canonical interpretation before
submission. Selecting **Research channel** starts the bounded run; the user then
sees concise progress and the final result or an actionable failure. The result
renders no internal credit metrics or activity log.

The presentation boundary is ahead of the transport boundary: the browser still
posts hidden internal progression actions, and `/api/runs` still returns the
internal run resource. Moving progression to a durable server worker and adding a
capability-named public DTO are explicit remaining migrations.

## What each component is

| Component | Kind | Responsibility | May call the LLM? | May call Upriver? |
|---|---|---|---:|---:|
| `app/` | Interface | Submit/restore one bounded run, show compact progress, present the report | No | No |
| Run workflow | Deterministic coordinator | Legal transitions, submission authorization, internal approvals, idempotency, per-run credits, resume/cancel, generation checkpoints | Through the bounded agent | Only through a tool port |
| Application use case | Deterministic coordinator | Runs the internally authorized workflow through ports | No | Only through a tool port |
| Tool registry + executor | Authoritative operation policy (ADR 0004) | Declares the five canonical provider operations (identity, endpoint, modes, stages, pricing reference, settlement class, audit name); one executor validates registration, mode, stage, input, cache, output, and settlement around every adapter call | No | Only through a tool port |
| Domain core | Pure code | Normalize, classify, join, gate, rank | No | No |
| Upriver adapter | Tool implementation | Exact public YouTube resolution, bounded Similar Beta discovery, typed sponsor HTTP, timeout, zero-retry paid calls, cost metadata | No | Yes, through explicitly enabled live gates |
| Fixture adapter | Tool implementation | Replays the frozen `@UrAvgConsumer` / Dell-XPS strict oracle with zero credits | No | No |
| Evidence cache | Tool decorator | Mode-isolated read-through cache with TTL/schema/policy invalidation | No | No |
| Workflow repository | Persistence adapter | Atomic snapshots, approvals, credit ledgers, cache, append-only events | No | No |
| Orchestrator | Controlled presentation component | Explain locked peers and word already-qualified claims without strengthening their policy | Yes | No |
| `SKILL.md` | Passive skill context | Describes available Upriver capabilities and constraints | N/A | Never |
| `llms.txt` | Passive docs index | Points to the relevant upstream reference page | N/A | Never |
| LLM adapter | Model boundary | Peer rationale and grounded report wording only | Yes | Never directly |
| Audit sink | Observability | Records tools, skills, LLMs, policy, latency, rows, credits | No | No |

### Skill versus tool

A **skill** is read-only context: loading it executes nothing and grants no
permission. A **tool** is executable code behind a typed port, and declares why
it's needed, its expected credit cost, cache policy, timeout/retry policy, and
the audit fields it emits.

The single source for that declaration is the authoritative registry at
`src/radar/application/tools/tool-registry.ts` (ADR 0004): the `EvidenceOperation`
vocabulary comes from its keys, each price is its rate-kind × result-cap into the
one rate card, the frozen `${mode}.${operation}` audit names are derived by its
helper for writers and readers, and `EvidenceToolExecutor` is the only path from
application code to an evidence adapter. Deferred capabilities (brand research)
are unregistered and fail closed; guardrail tests pin that audit history never
leaves the registry vocabulary and that no operation reaches the model.

The compatibility `/api/report` route always constructs the fixture adapter. Paid
execution exists only behind `/api/runs`, a server-selected mode, the user's
initial bounded-run authorization, persisted plan/cohort/credit checkpoints, an
exact quote, and idempotent per-run operation claims. `UPRIVER_MODE=live` alone
is insufficient — the server must also set `UPRIVER_LIVE_WORKFLOW=true`. The live
contract smoke stays separate with a six-credit budget and zero retries. The full
live adapter rejects retry-enabled clients because a timeout can leave billing
ambiguous.

### Dynamic live path

The live input boundary accepts an exact, public YouTube `@handle` or channel
URL, canonicalizes the identity, resolves exactly one creator through Upriver,
and rejects a mismatched response. It never falls back to fuzzy name search or
the golden fixture.

Peer discovery makes one bounded request to Upriver Similar Creators (Beta):

- `platforms: ["youtube"]`;
- a follower window of 0.75–1.25× the resolved target;
- a ten-result provider cap.

Content-language matching is deliberately omitted because a controlled live
request for a valid anchor returned `anchor_language_not_ready`; exact anchor,
platform, and reach checks stay enforced.

The adapter validates the beta wire shape and anchor, removes the target,
duplicates, invalid YouTube URLs, and out-of-range results, then keeps up to
three peers. The workflow freezes that cohort hash and stage quote at persisted
checkpoints before execution — the initial submit already authorized the bounded
policy, so these aren't separate user review screens. Sponsor research then uses
a rolling 365-day target window and a rolling 90-day peer window.

The live policy joins older target and recent peer `explicit_ad` evidence by
exact normalized sponsor domain. To spend only on work that can produce a lead,
`same_brand_reactivation` researches peer sponsor histories first; if no peer row
has evidence-backed, in-window, domain-resolvable `explicit_ad` evidence, the
workflow skips the paid target-history search and reports honestly that target
history wasn't searched (never that the target has no sponsors). The resulting
lead explicitly leaves product line, campaign, business unit, buyer, budget, and
agency unverified. The stricter S3 + product-continuity A/B policy keeps its
target-first ordering and manual ledger and exists only in the frozen
`@UrAvgConsumer` / Dell-XPS fixture and evals.

### Persistence and resume

The local repository uses private, atomic JSON files under `.data/sponsor-radar`.
Snapshot writes use optimistic revisions; events are immutable and contiguous;
approvals, cache keys, and idempotency keys are stored only as hashes. A
filesystem lock serializes credit-ledger operations across Node processes sharing
the storage directory.

The initial submit is the sole UI authorization for one run within the
server-owned policy and ceiling. The plan, cohort, and credit approval records
are internal state-machine checkpoints: they preserve fingerprints, attribution,
and restart safety without asking the user to confirm non-editable values. If any
checkpoint would exceed or diverge from the authorized bounds, the run stops
safely.

Non-cancellable `resolving` and `executing` claims are persisted before their
first tool calls. Refreshing a page reads the saved run instead of creating a new
one. Active leases keep another tab from racing in-flight work, and the browser
polls those checkpoints. Safe pre- and post-call checkpoints resume
deterministically. An interrupted live paid claim fails closed, is never
replayed, and settles its full reservation conservatively.

Credit estimates derived from cache state are rechecked immediately before each
credit checkpoint, and the checkpointed stage ceiling is injected into the live
gateway's budget, so cache expiry between inspection and execution can't
authorize extra spend.

Each schema-v4 run persists `per_run_v1` accounting with a hard maximum of 160
credits. Its resolution and execution reservations share that run-specific
ledger, checked atomically without a lifetime shutdown. The former 200-credit
shared ledger is closed to new reservations and retained as historical evidence;
a pre-existing active legacy claim may only settle or release without replay. The
conservative uncached quote is 157: two creator results (initial resolution plus
forced-fresh execution revalidation), up to ten Similar Beta results at one
creator-result credit each, 23 grouped target sponsor results at five credits
each, and two grouped sponsor results for each of three peers at five credits
each. Upriver doesn't document Similar Beta billing, so ceilings and result-based
settlements are estimates, not provider-confirmed charges.

The wording agent writes a durable purpose/input-fingerprint claim before either
model call. On restart with an ambiguous claimed call it doesn't replay; the
workflow persists deterministic fallback wording. Successful output and its audit
trace are checkpointed atomically with the peer proposal or report artifact.

### Where LLM calls happen

The deterministic pipeline makes no LLM calls. The bounded wording orchestrator
may make two:

1. explain every member of the exact, checkpoint-bound reach-matched cohort;
2. draft sentence-level wording from an already-qualified claim/evidence ledger.

The provider port returns `unknown`; a trusted wrapper enforces strict schemas,
exact opaque IDs/order/cardinality, exact evidence attribution, input/token/call/
time limits, and no tool calls before returning an application artifact. The
workflow locks peers before expensive research. The model never selects peers,
sees an API key, calls Upriver, changes a query, or returns a canonical report.
For a live lead, the request ledger and validator forbid wording that implies
product, campaign, buyer, budget, agency, or business-unit continuity. Any
invalid or unavailable generation falls back to deterministic wording.

The default model adapter is a network-free fixture. The optional OpenAI adapter
is server-only, zero-retry, tool-free, strict-JSON-Schema, non-stored, and
enabled separately from live Upriver evidence.

## Flag-gated agentic engine (ADR 0008)

`SPONSOR_RADAR_ENGINE=agentic` selects a second orchestration engine behind
the same `/api/runs` contract. An LLM planner proposes tool calls; a broker
(`src/radar/application/agentic/tool-broker.ts`) validates each proposal
against a fixed six-tool catalog, enforces the per-run credit budget with a
conservative preflight and result-based settlement, and executes through the
single `ToolExecutor`. Facts stay deterministic: evidence accumulates in
server-held state (`evidence-state.ts`), qualification runs the extracted
`same-brand-qualification.ts` module, and the report is assembled by code —
the model authors no fact-bearing field. Runs are autonomous (no approval
checkpoints), bounded by iteration/token/transcript/credit ceilings enforced
in code, and persist to a parallel `agentic-v1` store under
`${SPONSOR_RADAR_DATA_DIR}/agentic` so the legacy store stays byte-identical
and rollback self-heals. The engine router
(`src/radar/adapters/run-engine-runtime.ts`) dispatches reads and recovery on
which store holds the record, so runs from either engine stay reachable
across flag flips and one idempotency key never creates two runs. Fixture
mode drives the loop with a deterministic rule-based planner; live mode uses
a zero-retry OpenAI Responses tool-calling adapter with serial tool calls.

## Stable code boundaries

Historical engineering phases are archived in `docs/archive/BUILD_HISTORY.md`
(forward work lives in `docs/ROADMAP.md`); they were never encoded as
`phase-1/phase-2` source folders. This keeps domain and port boundaries stable as
fixture implementations are replaced by live ones. External JSON is validated at
the adapter boundary and normalized into smaller application types; raw optional
fields don't leak into the domain core.

## Audit event contract

Each run receives a `run_id`. Append-only events can include:

- phase, actor, event type, sequence, and timestamp;
- tool name, mode, reason, input fingerprint, cache status, rows, retries,
  result, request ID, HTTP status, and duration;
- skill name, upstream version/hash, section loaded, and reason;
- LLM provider/model, purpose, prompt/context/evidence/output fingerprints, token
  limits/usage, provider request ID, attempt count, latency, structured-
  validation result, outcome, and safe error type;
- policy decision, initial user-authorization identity/time, internal checkpoint
  identity/time, preflight credits, result-based credit estimate, and
  reconciliation status;
- time to first result and total run duration.

API keys, raw authorization headers, personal usage-account fields, and full
prompts containing sensitive data are never logged.

The legacy API route emits each safe audit event to the server log as it occurs.
Run resources also persist transition history and safe tool/HTTP/LLM audit
events, then return them with the saved report.

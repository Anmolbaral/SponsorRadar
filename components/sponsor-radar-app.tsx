"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent
} from "react";
import type { Phase3RunResource } from "@/src/radar/application/run-workflow";
import type { WinbackReport } from "@/src/radar/domain/types";
import { parseYouTubeChannelReference } from "@/src/radar/domain/youtube";

interface PendingCreateAttempt {
  idempotencyKey: string;
  channel: string;
}

interface WorkflowIssue {
  message: string;
  code: string | null;
  retryable: boolean;
  status: number | null;
  noAdditionalResearchStarted: boolean;
}

type RunActionBody =
  | {
      action: "approve_plan";
      expectedVersion: number;
      planId: string;
    }
  | {
      action: "approve_execution";
      expectedVersion: number;
      proposalId: string;
      quoteId: string;
      approvedCreditCeiling: number;
    }
  | {
      action: "cancel" | "resume";
      expectedVersion: number;
    };

const SAVED_RUN_ID_KEY = "sponsor-radar-run-id";
const PENDING_CREATE_KEY = "sponsor-radar-pending-create";

export function SponsorRadarDemo() {
  const [channel, setChannel] = useState("");
  const [run, setRun] = useState<Phase3RunResource | null>(null);
  const [issue, setIssue] = useState<WorkflowIssue | null>(null);
  const [loading, setLoading] = useState(false);
  const createKey = useRef<string | null>(null);
  const actionInFlight = useRef<string | null>(null);
  const attemptedAutomaticActions = useRef(new Set<string>());

  const act = useCallback(
    async (currentRun: Phase3RunResource, body: RunActionBody) => {
      const idempotencyKey = runActionIdempotencyKey(currentRun, body);
      if (actionInFlight.current) return;
      actionInFlight.current = idempotencyKey;
      setLoading(true);
      setIssue(null);
      try {
        const updated = await workflowRequest(
          `/api/runs/${currentRun.runId}/actions`,
          {
            idempotencyKey,
            body
          }
        );
        setRun(updated);
      } catch (caught) {
        setIssue(
          workflowIssueFrom(
            caught,
            "We couldn’t continue this search right now."
          )
        );
      } finally {
        if (actionInFlight.current === idempotencyKey) {
          actionInFlight.current = null;
        }
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const runId = window.localStorage.getItem(SAVED_RUN_ID_KEY);
    if (!runId) {
      const pending = readPendingCreateAttempt();
      if (!pending) return;
      createKey.current = pending.idempotencyKey;
      let active = true;
      void Promise.resolve().then(() => {
        if (active) setChannel(pending.channel);
      });
      return () => {
        active = false;
      };
    }
    let active = true;
    void workflowRequest(`/api/runs/${runId}`)
      .then((restored) => {
        if (active) {
          clearPendingCreateAttempt();
          createKey.current = null;
          setRun(restored);
        }
      })
      .catch((caught: unknown) => {
        if (!active) return;
        if (
          caught instanceof WorkflowRequestError &&
          caught.status === 404
        ) {
          window.localStorage.removeItem(SAVED_RUN_ID_KEY);
        }
        setIssue(
          workflowIssueFrom(
            caught,
            "We couldn’t restore your saved search right now."
          )
        );
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!run || issue || shouldPollRun(run)) return;
    const automaticAction = automaticActionFor(run);
    if (!automaticAction) return;
    const key = runActionIdempotencyKey(run, automaticAction);
    if (attemptedAutomaticActions.current.has(key)) return;
    attemptedAutomaticActions.current.add(key);
    void act(run, automaticAction);
  }, [act, issue, run]);

  useEffect(() => {
    if (!run || loading || !shouldPollRun(run)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void workflowRequest(`/api/runs/${run.runId}`)
        .then((updated) => {
          if (active) {
            setIssue(null);
            setRun(updated);
          }
        })
        .catch((caught: unknown) => {
          if (active) {
            setIssue(
              workflowIssueFrom(
                caught,
                "We couldn’t refresh this search right now."
              )
            );
          }
        });
    }, 2_000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [loading, run]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setIssue(null);

    try {
      const normalizedChannel = channel.trim();
      const pending = readPendingCreateAttempt();
      createKey.current ??=
        pending?.channel === normalizedChannel
          ? pending.idempotencyKey
          : window.crypto.randomUUID();
      writePendingCreateAttempt({
        idempotencyKey: createKey.current,
        channel: normalizedChannel
      });
      const created = await workflowRequest("/api/runs", {
        idempotencyKey: createKey.current,
        body: { channel }
      });
      window.localStorage.setItem(SAVED_RUN_ID_KEY, created.runId);
      clearPendingCreateAttempt();
      createKey.current = null;
      setRun(created);
    } catch (caught) {
      setIssue(
        workflowIssueFrom(
          caught,
          "We couldn’t start this search right now."
        )
      );
    } finally {
      setLoading(false);
    }
  }

  async function refreshRun(retryAutomaticAction = false) {
    if (!run || actionInFlight.current) return;
    setLoading(true);
    try {
      const updated = await workflowRequest(`/api/runs/${run.runId}`);
      if (retryAutomaticAction) {
        const currentAction = automaticActionFor(run);
        const updatedAction = automaticActionFor(updated);
        if (currentAction) {
          attemptedAutomaticActions.current.delete(
            runActionIdempotencyKey(run, currentAction)
          );
        }
        if (updatedAction) {
          attemptedAutomaticActions.current.delete(
            runActionIdempotencyKey(updated, updatedAction)
          );
        }
      }
      setIssue(null);
      setRun(updated);
    } catch (caught) {
      setIssue(
        workflowIssueFrom(
          caught,
          "We couldn’t refresh this search right now."
        )
      );
    } finally {
      setLoading(false);
    }
  }

  function retryAfterIssue() {
    if (!run || !issue?.retryable) return;
    if (
      issue.code === "run_conflict" ||
      issue.code === "workflow_state_conflict"
    ) {
      void refreshRun(true);
      return;
    }
    const automaticAction = automaticActionFor(run);
    if (automaticAction) {
      void act(run, automaticAction);
      return;
    }
    if (run.availableActions.includes("resume")) {
      void act(run, {
        action: "resume",
        expectedVersion: run.version
      });
      return;
    }
    void refreshRun();
  }

  function startOver() {
    window.localStorage.removeItem(SAVED_RUN_ID_KEY);
    clearPendingCreateAttempt();
    createKey.current = null;
    setRun(null);
    setIssue(null);
  }

  const channelInputIssue = issue ? isChannelInputIssue(issue) : false;
  const interpretedChannel = interpretChannelInput(channel);
  const channelDescription = [
    "channel-note",
    interpretedChannel ? "channel-interpretation" : null,
    issue ? "channel-error" : null
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className="workspace" aria-label="Sponsor winback report">
      {!run ? (
        <form className="channel-form" onSubmit={submit}>
          <label htmlFor="channel">Channel handle or URL</label>
          <div className="input-row">
            <input
              id="channel"
              name="channel"
              aria-describedby={channelDescription}
              aria-invalid={channelInputIssue ? "true" : undefined}
              value={channel}
              onChange={(event) => {
                setChannel(event.target.value);
                setIssue(null);
                clearPendingCreateAttempt();
                createKey.current = null;
              }}
              placeholder="@channel or youtube.com/@channel"
              autoComplete="off"
              maxLength={200}
              required
              disabled={loading}
            />
            <button type="submit" disabled={loading}>
              {loading
                ? "Starting research…"
                : issue?.retryable
                  ? "Try again"
                  : "Research channel"}
            </button>
          </div>
          {interpretedChannel ? (
            <p
              className="form-note channel-interpretation"
              id="channel-interpretation"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              We’ll research: <strong>{interpretedChannel}</strong>
            </p>
          ) : null}
          <p className="form-note" id="channel-note">
            One click starts the research. We confirm the channel, compare
            reach-comparable channels, and verify sponsor evidence
            automatically.
          </p>
          {issue ? (
            <div
              className="form-error"
              id="channel-error"
              role="alert"
              aria-live="assertive"
            >
              <p>{issue.message}</p>
              <p className="form-error-guidance">
                {channelInputIssue
                  ? "Check the channel above and try again."
                  : issue.retryable
                  ? "Your request is saved. Try again when you’re ready."
                  : "Please try again later."}
              </p>
            </div>
          ) : null}
        </form>
      ) : null}

      {run && !run.report ? (
        <WorkflowPanel
          run={run}
          loading={loading}
          issue={issue}
          onRetry={retryAfterIssue}
          onCancel={() =>
            void act(run, {
              action: "cancel",
              expectedVersion: run.version
            })
          }
          onResume={() =>
            void act(run, {
              action: "resume",
              expectedVersion: run.version
            })
          }
          onStartOver={startOver}
        />
      ) : null}

      {run?.report ? (
        <ReportView
          report={run.report}
          status={run.status}
          onStartOver={startOver}
        />
      ) : null}
    </section>
  );
}

function WorkflowPanel({
  run,
  loading,
  issue,
  onRetry,
  onCancel,
  onResume,
  onStartOver
}: {
  run: Phase3RunResource;
  loading: boolean;
  issue: WorkflowIssue | null;
  onRetry: () => void;
  onCancel: () => void;
  onResume: () => void;
  onStartOver: () => void;
}) {
  const state = run.state.state;
  const paused = run.availableActions.includes("resume");
  const terminal =
    state === "completed" ||
    state === "partial" ||
    state === "no_eligible_peers" ||
    state === "failed" ||
    state === "cancelled";

  return (
    <section
      className={`workflow-panel${issue ? " workflow-panel-issue" : ""}`}
      aria-live="polite"
      aria-busy={
        !issue &&
        !paused &&
        (loading || shouldPollRun(run) || automaticActionFor(run) !== null)
      }
    >
      <div className="workflow-heading">
        <div>
          <p className="eyebrow">
            {issue
              ? "Research needs attention"
              : terminal
                ? "Research status"
                : "Research in progress"}
          </p>
          <h2>
            {issue
              ? "We couldn’t continue this search"
              : workflowTitle(run)}
          </h2>
        </div>
        <span
          className={`workflow-status ${
            issue
              ? "workflow-status-issue"
              : `workflow-status-${run.status}`
          }`}
        >
          {issue ? "Needs attention" : workflowStatusLabel(run.status)}
        </span>
      </div>

      {issue ? (
        <div className="workflow-issue" role="alert" aria-live="assertive">
          <span className="issue-mark" aria-hidden="true">
            !
          </span>
          <div className="workflow-issue-content">
            <p>{issue.message}</p>
            {issue.noAdditionalResearchStarted ? (
              <p className="issue-safety-note">
                No additional research was started after this issue.
              </p>
            ) : null}
            <div className="workflow-actions issue-actions">
              {issue.retryable ? (
                <button
                  className="primary-action"
                  type="button"
                  disabled={loading}
                  onClick={onRetry}
                >
                  Try again
                </button>
              ) : (
                <button
                  className="secondary-action"
                  type="button"
                  disabled={loading}
                  onClick={onStartOver}
                >
                  Back to search
                </button>
              )}
              {issue.retryable &&
              run.availableActions.includes("cancel") ? (
                <button
                  className="secondary-action"
                  type="button"
                  disabled={loading}
                  onClick={onCancel}
                >
                  Cancel research
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : !terminal ? (
        <>
          <div
            className={`research-progress${paused ? " research-progress-paused" : ""}`}
          >
            <span
              className={paused ? "progress-paused" : "progress-spinner"}
              aria-hidden="true"
            />
            <div>
              <strong>
                {paused ? "Research paused safely" : workflowStepTitle(run)}
              </strong>
              <p>
                {paused
                  ? "Your progress is saved. Continue when you’re ready."
                  : workflowStepCopy(run)}
              </p>
            </div>
          </div>
          {run.availableActions.includes("resume") ||
          run.availableActions.includes("cancel") ? (
            <div className="workflow-actions">
              {run.availableActions.includes("resume") ? (
                <button
                  className="primary-action"
                  type="button"
                  disabled={loading}
                  onClick={onResume}
                >
                  Resume research
                </button>
              ) : null}
              {run.availableActions.includes("cancel") ? (
                <button
                  className="secondary-action"
                  type="button"
                  disabled={loading}
                  onClick={onCancel}
                >
                  Cancel research
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {!issue && state === "partial" ? (
        <p className="partial-notice">
          The report preserves evidence from successful peers and
          clearly marks missing peer coverage.
        </p>
      ) : null}
      {!issue && state === "no_eligible_peers" ? (
        <div className="empty-state workflow-empty">
          <h3>No comparable peers found</h3>
          <p>
            {run.resolvedCohort
              ? `We confirmed ${run.resolvedCohort.target.name}, but found no comparable YouTube channels inside the selected audience range.`
              : "The channel resolved, but no eligible reach-comparable peers were available."}{" "}
            Sponsor evidence was not checked, and no opportunities were
            returned.
          </p>
        </div>
      ) : null}
      {!issue && state === "failed" && run.error ? (
        <div className="error-panel workflow-error" role="alert">
          We couldn’t complete this search. No result was produced.
        </div>
      ) : null}
      {!issue && state === "cancelled" ? (
        <p className="cancelled-note">
          Research was cancelled before more work started.
        </p>
      ) : null}

      {!issue && terminal ? (
        <button
          className="text-action"
          type="button"
          onClick={onStartOver}
        >
          Start a new search
        </button>
      ) : null}
    </section>
  );
}

function ReportView({
  report,
  status,
  onStartOver
}: {
  report: WinbackReport;
  status: Phase3RunResource["status"];
  onStartOver: () => void;
}) {
  const opportunityCount = report.leads.length;

  return (
    <div className="report" aria-live="polite">
      <div className="report-heading">
        <div>
          <p className="eyebrow">Results for</p>
          <h2>{report.target.name}</h2>
          <p className="report-context">
            {formatCompactNumber(report.target.subscriberCount)} subscribers
            {" · "}
            Sponsor activity checked through {formatDate(report.asOf)}
          </p>
        </div>
        <div className="report-actions">
          <span className="result-count">
            {opportunityCount}{" "}
            {opportunityCount === 1 ? "opportunity" : "opportunities"}
          </span>
          <button
            className="text-action"
            type="button"
            onClick={onStartOver}
          >
            Start a new search
          </button>
        </div>
      </div>

      {status === "partial" ? (
        <p className="partial-notice">
          Research completed with partial coverage. This report preserves
          evidence from successful peers and clearly marks missing peer
          coverage.
        </p>
      ) : null}

      <div className="lead-list">
        {opportunityCount === 0 ? (
          <div className="empty-state">
            <h3>No qualified winback opportunity found</h3>
            <p>
              We checked the selected peers but found no evidence-backed
              same-brand reactivation signal that passed the current policy.
              The report is intentionally not padded with weak matches.
            </p>
          </div>
        ) : (
          report.leads.map((lead, leadIndex) => {
            const generatedNarrative = report.phase4?.narratives.find(
              (narrative) => narrative.leadIndex === leadIndex
            );
            return (
            <article className="lead-card" key={lead.domain}>
              <div className="lead-title">
                <div>
                  <h3>{lead.brand}</h3>
                  <a
                    className="brand-link"
                    href={`https://${lead.domain}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {lead.domain} ↗
                  </a>
                </div>
                <span className="grade">
                  {lead.continuity === "A"
                    ? "Strong product match"
                    : lead.continuity === "B"
                      ? "Related product match"
                      : "Same sponsor · product unverified"}
                </span>
              </div>

              <section className="opportunity-summary">
                <p className="eyebrow">Why this is worth reviewing</p>
                <p>
                  <strong>
                    {lead.brand} sponsored {lead.peer}{" "}
                    {formatDaysAgo(lead.peerDaysSinceLatest)}.
                  </strong>{" "}
                  The latest {lead.brand} sponsorship found on the target
                  channel was {formatDaysAgo(lead.targetDaysSinceLatest)}.{" "}
                  {lead.continuity === "U"
                    ? "The shared sponsor domain is verified by placement evidence; product line, campaign, and buyer continuity are not."
                    : "Both placements were manually verified as promoting products from the same or an adjacent family."}
                </p>
              </section>

              <div className="comparison-grid">
                <RelationshipCard
                  label="Target channel"
                  name={report.target.name}
                  url={report.target.url}
                  subscriberCount={report.target.subscriberCount}
                  observedPlacements={lead.targetObservedPlacements}
                  firstObservedDate={lead.targetFirstObservedDate}
                  latestObservedDate={lead.targetEvidence.publishedDate}
                  productLine={lead.targetProductLine}
                  trackingSince={report.methodology.targetWindow.since}
                  trackingUntil={report.methodology.targetWindow.until}
                />
                <RelationshipCard
                  label="Similar channel"
                  name={lead.peer}
                  url={lead.peerUrl}
                  subscriberCount={lead.peerSubscriberCount}
                  observedPlacements={lead.peerObservedPlacements}
                  firstObservedDate={lead.peerFirstObservedDate}
                  latestObservedDate={lead.peerEvidence.publishedDate}
                  productLine={lead.peerProductLine}
                  trackingSince={report.methodology.peerWindow.since}
                  trackingUntil={report.methodology.peerWindow.until}
                  comparison={reachComparison(
                    report.target.subscriberCount,
                    lead.peerSubscriberCount
                  )}
                />
              </div>

              <section className="product-match">
                <p className="eyebrow">
                  {lead.continuity === "U"
                    ? "What the evidence matches"
                    : "Why the products match"}
                </p>
                <p>{lead.continuityReason}</p>
              </section>

              <div className="evidence-grid">
                <EvidenceBlock
                  title="Target sponsorship evidence"
                  evidence={lead.targetEvidence}
                />
                <EvidenceBlock
                  title={`${lead.peer}'s sponsorship evidence`}
                  evidence={lead.peerEvidence}
                />
              </div>

              <section className="next-step">
                <p className="eyebrow">What this means</p>
                {generatedNarrative ? (
                  <>
                    {generatedNarrative.sentences.map((sentence) => (
                      <p key={sentence.claimIds.join(":")}>
                        {sentence.text}
                      </p>
                    ))}
                    <p className="form-note">
                      Grounded in the cited target and peer placements shown
                      above.
                    </p>
                  </>
                ) : (
                  <>
                    <p>{lead.outreachHypothesis}</p>
                    {report.phase4?.status === "fallback" ? (
                      <p className="form-note">
                        This result uses the verified evidence summary.
                      </p>
                    ) : null}
                  </>
                )}
              </section>
            </article>
            );
          })
        )}
      </div>

      <section className="data-notes">
        <div>
          <p className="eyebrow">About the data</p>
          <h3>What this report can and cannot tell you</h3>
        </div>
        <ul>
          {report.coverage.map((notice) => (
            <li key={notice.code}>{plainLanguageDataNote(notice)}</li>
          ))}
        </ul>
      </section>

      <details className="audit">
        <summary>How this research works</summary>
        <p className="form-note">
          We confirm the exact YouTube channel, compare reach-comparable
          channels, and check sponsor evidence within the selected time
          window.
        </p>
      </details>
    </div>
  );
}

function EvidenceBlock({
  title,
  evidence
}: {
  title: string;
  evidence: WinbackReport["leads"][number]["targetEvidence"];
}) {
  return (
    <section className="evidence">
      <p className="eyebrow">{title}</p>
      <h4>{evidence.videoTitle}</h4>
      <p className="evidence-date">
        Observed {formatDate(evidence.publishedDate)}
      </p>
      <p>{evidence.excerpt}</p>
      <a href={evidence.contentUrl} target="_blank" rel="noreferrer">
        View sponsorship source ↗
      </a>
    </section>
  );
}

function RelationshipCard({
  label,
  name,
  url,
  subscriberCount,
  observedPlacements,
  firstObservedDate,
  latestObservedDate,
  productLine,
  trackingSince,
  trackingUntil,
  comparison
}: {
  label: string;
  name: string;
  url: string;
  subscriberCount: number;
  observedPlacements: number;
  firstObservedDate: string | null;
  latestObservedDate: string;
  productLine: string;
  trackingSince: string;
  trackingUntil: string;
  comparison?: string;
}) {
  return (
    <section className="relationship-card">
      <p className="eyebrow">{label}</p>
      <div className="channel-heading">
        <h4>{name}</h4>
        <a href={url} target="_blank" rel="noreferrer">
          View channel ↗
        </a>
      </div>
      <p className="subscriber-count">
        {formatCompactNumber(subscriberCount)} subscribers
      </p>
      {comparison ? <p className="comparison-note">{comparison}</p> : null}

      <dl className="relationship-stats">
        <div>
          <dt>Sponsorships found</dt>
          <dd>{observedPlacements}</dd>
        </div>
        <div>
          <dt>First observed</dt>
          <dd>
            {firstObservedDate
              ? formatDate(firstObservedDate)
              : "Not available"}
          </dd>
        </div>
        <div>
          <dt>Latest observed</dt>
          <dd>{formatDate(latestObservedDate)}</dd>
        </div>
        <div>
          <dt>Product promoted</dt>
          <dd>{productLine}</dd>
        </div>
      </dl>
      <p className="tracking-window">
        Searched {formatDate(trackingSince)}–{formatDate(trackingUntil)}
      </p>
    </section>
  );
}

async function workflowRequest(
  path: string,
  options?: {
    idempotencyKey: string;
    body: unknown;
  }
): Promise<Phase3RunResource> {
  const response = await fetch(path, {
    method: options ? "POST" : "GET",
    ...(options
      ? {
          headers: {
            "content-type": "application/json",
            "idempotency-key": options.idempotencyKey
          },
          body: JSON.stringify(options.body)
        }
      : {})
  });
  const payload = (await response.json()) as
    | Phase3RunResource
    | {
        error?: unknown;
        code?: unknown;
        retryable?: unknown;
      };
  if (!response.ok || !("runId" in payload)) {
    const rawMessage =
      "error" in payload && typeof payload.error === "string"
        ? payload.error
        : null;
    const rawCode =
      "code" in payload && typeof payload.code === "string"
        ? payload.code
        : null;
    const code = normalizeWorkflowErrorCode(
      rawCode,
      rawMessage,
      response.status
    );
    const retryable =
      "retryable" in payload && typeof payload.retryable === "boolean"
        ? payload.retryable
        : false;
    throw new WorkflowRequestError(
      publicWorkflowErrorMessage(code, response.status),
      response.status,
      code,
      retryable,
      noAdditionalResearchStarted(code)
    );
  }
  return payload;
}

class WorkflowRequestError extends Error {
  readonly name = "WorkflowRequestError";

  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly retryable: boolean,
    readonly noAdditionalResearchStarted: boolean
  ) {
    super(message);
  }
}

function workflowIssueFrom(
  caught: unknown,
  fallbackMessage: string
): WorkflowIssue {
  if (caught instanceof WorkflowRequestError) {
    return {
      message: caught.message,
      code: caught.code,
      retryable: caught.retryable,
      status: caught.status,
      noAdditionalResearchStarted:
        caught.noAdditionalResearchStarted
    };
  }
  return {
    message: fallbackMessage,
    code: null,
    retryable: false,
    status: null,
    noAdditionalResearchStarted: false
  };
}

function normalizeWorkflowErrorCode(
  code: string | null,
  rawMessage: string | null,
  status: number
): string | null {
  if (code) return code;
  if (
    status === 409 &&
    rawMessage &&
    (/maximumUnits/i.test(rawMessage) ||
      /Quota [a-f0-9]{32,}/i.test(rawMessage) ||
      /persisted workflow/i.test(rawMessage))
  ) {
    return "research_unavailable";
  }
  return null;
}

function publicWorkflowErrorMessage(
  code: string | null,
  status: number
): string {
  switch (code) {
    case "research_unavailable":
    case "workflow_persistence_conflict":
      return "We couldn’t complete this research right now. Start a new search or try again later.";
    case "run_credit_limit_reached":
      return "This research reached its safety limit. Start a new search.";
    case "run_restart_required":
      return "This saved search can’t continue safely. Start a new search.";
    case "rate_limited":
      return "Too many research requests were started at once. Wait briefly, then try again.";
    case "run_conflict":
    case "workflow_state_conflict":
      return "This search changed while the page was open. Try again to load its latest progress.";
    case "invalid_run_state":
      return "This saved search can’t continue from its current step. Start a new search.";
    case "capacity_reached":
    case "shared_quota_exceeded":
      return "Research capacity is currently full. Please try again in a little while.";
  }
  if (status === 400 || status === 422) {
    return "Enter a YouTube channel handle or URL.";
  }
  if (status === 404) {
    return "We couldn’t find this saved search. Start a new one.";
  }
  if (status === 409) {
    return "This saved search can’t continue from its current step. Start a new search.";
  }
  if (status === 429) {
    return "Research capacity is currently full. Please try again in a little while.";
  }
  if (status === 503) {
    return "We couldn’t complete this research right now. Start a new search or try again later.";
  }
  return "Something went wrong while checking this search. Please try again later.";
}

function noAdditionalResearchStarted(code: string | null): boolean {
  return (
    code === "research_unavailable" ||
    code === "workflow_persistence_conflict" ||
    code === "run_credit_limit_reached" ||
    code === "run_restart_required" ||
    code === "rate_limited" ||
    code === "capacity_reached" ||
    code === "shared_quota_exceeded"
  );
}

function isChannelInputIssue(issue: WorkflowIssue): boolean {
  return (
    issue.code === "invalid_request" ||
    issue.code === "invalid_channel" ||
    issue.code === "invalid_workflow_request"
  );
}

export function interpretChannelInput(input: string): string | null {
  if (!input.trim()) return null;
  try {
    return parseYouTubeChannelReference(input).lookupUrl.replace(
      /^https:\/\/www\./,
      ""
    );
  } catch {
    return null;
  }
}

function shouldPollRun(run: Phase3RunResource): boolean {
  return (
    !run.availableActions.includes("resume") &&
    (run.state.state === "plan_approved" ||
      run.state.state === "resolving" ||
      run.state.state === "executing")
  );
}

function readPendingCreateAttempt(): PendingCreateAttempt | null {
  const raw = window.localStorage.getItem(PENDING_CREATE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingCreateAttempt>;
    if (
      typeof parsed.idempotencyKey === "string" &&
      parsed.idempotencyKey.length >= 8 &&
      typeof parsed.channel === "string"
    ) {
      return {
        idempotencyKey: parsed.idempotencyKey,
        channel: parsed.channel
      };
    }
  } catch {
    // A malformed browser value is not a valid retry token.
  }
  window.localStorage.removeItem(PENDING_CREATE_KEY);
  return null;
}

function writePendingCreateAttempt(attempt: PendingCreateAttempt): void {
  window.localStorage.setItem(PENDING_CREATE_KEY, JSON.stringify(attempt));
}

function clearPendingCreateAttempt(): void {
  window.localStorage.removeItem(PENDING_CREATE_KEY);
}

function automaticActionFor(
  run: Phase3RunResource
): RunActionBody | null {
  if (
    run.state.state === "planned" &&
    run.availableActions.includes("approve_plan")
  ) {
    return {
      action: "approve_plan",
      expectedVersion: run.version,
      planId: run.plan.planId
    };
  }
  if (
    run.state.state === "peers_proposed" &&
    run.availableActions.includes("approve_execution") &&
    run.peerProposal
  ) {
    return {
      action: "approve_execution",
      expectedVersion: run.version,
      proposalId: run.peerProposal.proposalId,
      quoteId: run.peerProposal.quote.quoteId,
      approvedCreditCeiling: run.peerProposal.quote.creditCeiling
    };
  }
  return null;
}

function runActionIdempotencyKey(
  run: Phase3RunResource,
  action: RunActionBody
): string {
  return `${action.action}-${run.runId}-${run.version}`;
}

function workflowTitle(run: Phase3RunResource): string {
  switch (run.status) {
    case "awaiting_plan_approval":
    case "resolving_peers":
    case "awaiting_execution_approval":
    case "executing":
      return "Researching winback opportunities";
    case "completed":
      return "Research complete";
    case "partial":
      return "Research complete with partial coverage";
    case "failed":
      return "Research stopped safely";
    case "cancelled":
      return "Research cancelled";
  }
}

function workflowStepTitle(run: Phase3RunResource): string {
  switch (run.state.state) {
    case "submitted":
    case "planned":
    case "plan_approved":
      return "Confirming the channel";
    case "resolving":
    case "resolved":
      return "Finding comparable channels";
    case "peers_proposed":
    case "peers_approved":
    case "credit_approved":
      return "Preparing sponsor research";
    case "executing":
      return "Checking sponsor evidence";
    case "verifying":
      return "Verifying and formatting the report";
    case "no_eligible_peers":
    case "completed":
    case "partial":
    case "failed":
    case "cancelled":
      return "Research finished";
  }
}

function workflowStepCopy(run: Phase3RunResource): string {
  switch (run.state.state) {
    case "submitted":
    case "planned":
    case "plan_approved":
      return "Confirming the exact YouTube identity before any sponsor evidence is checked.";
    case "resolving":
    case "resolved":
      return "Selecting up to three reach-comparable channels for a focused comparison.";
    case "peers_proposed":
    case "peers_approved":
    case "credit_approved":
      return "Preparing a focused evidence check across the selected comparable channels.";
    case "executing":
      return "Comparing recent peer sponsorships with the target channel’s history.";
    case "verifying":
      return "Keeping only evidence-backed opportunities and preparing the concise result.";
    case "no_eligible_peers":
    case "completed":
    case "partial":
    case "failed":
    case "cancelled":
      return "The research has ended.";
  }
}

function workflowStatusLabel(
  status: Phase3RunResource["status"]
): string {
  switch (status) {
    case "awaiting_plan_approval":
      return "Starting";
    case "resolving_peers":
      return "Finding peers";
    case "awaiting_execution_approval":
      return "Preparing";
    case "executing":
      return "Researching";
    case "completed":
      return "Ready";
    case "partial":
      return "Partial";
    case "failed":
      return "Stopped";
    case "cancelled":
      return "Cancelled";
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2
  }).format(value);
}

function formatDaysAgo(days: number): string {
  if (days === 0) return "today";
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function reachComparison(
  targetSubscribers: number,
  peerSubscribers: number
): string {
  const percentage = Math.round(
    (Math.abs(peerSubscribers - targetSubscribers) / targetSubscribers) * 100
  );
  const direction =
    peerSubscribers >= targetSubscribers ? "larger" : "smaller";
  return `Similar audience size: ${percentage}% ${direction} than your channel.`;
}

function plainLanguageDataNote(
  notice: WinbackReport["coverage"][number]
): string {
  if (notice.code === "target_domain_coverage") {
    if (notice.denominator === 0) return notice.message;
    return `We could match ${notice.numerator ?? 0} of ${
      notice.denominator ?? 0
    } past sponsor records to a brand website. Missing websites may hide some opportunities.`;
  }
  if (notice.code === "peer_domain_joinability") {
    if (notice.denominator === 0) return notice.message;
    return `${notice.numerator ?? 0} of ${
      notice.denominator ?? 0
    } verified competitor sponsors had a brand website we could match.`;
  }
  if (notice.code === "grouped_summary_limit") {
    return "The source provides the most recent example and a total count for each brand, not every historical sponsorship. “First observed” is shown only when the available data supports it.";
  }
  return notice.message;
}

export const RUN_STATES = [
  "submitted",
  "planned",
  "plan_approved",
  "resolving",
  "no_eligible_peers",
  "resolved",
  "peers_proposed",
  "peers_approved",
  "credit_approved",
  "executing",
  "verifying",
  "completed",
  "partial",
  "failed",
  "cancelled"
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_RUN_STATES = [
  "no_eligible_peers",
  "completed",
  "partial",
  "failed",
  "cancelled"
] as const satisfies readonly RunState[];

/**
 * Cancellation is safe only before a paid-operation claim is durable. Once a
 * run is resolving, executing, or verifying, callers must let the in-flight
 * work settle into verification or failure instead of representing it as
 * having spent no credits.
 */
export const CANCELLABLE_RUN_STATES = [
  "submitted",
  "planned",
  "plan_approved",
  "resolved",
  "peers_proposed",
  "peers_approved",
  "credit_approved"
] as const satisfies readonly RunState[];

function transitions<const States extends readonly RunState[]>(
  ...states: States
): Readonly<States> {
  return Object.freeze(states);
}

export const RUN_TRANSITION_GRAPH = Object.freeze({
  submitted: transitions("planned", "failed", "cancelled"),
  planned: transitions("plan_approved", "failed", "cancelled"),
  plan_approved: transitions("resolving", "failed", "cancelled"),
  resolving: transitions("no_eligible_peers", "resolved", "failed"),
  no_eligible_peers: transitions(),
  resolved: transitions("peers_proposed", "failed", "cancelled"),
  peers_proposed: transitions(
    "peers_approved",
    "failed",
    "cancelled"
  ),
  peers_approved: transitions(
    "credit_approved",
    "failed",
    "cancelled"
  ),
  credit_approved: transitions("executing", "failed", "cancelled"),
  executing: transitions("verifying", "failed"),
  verifying: transitions("completed", "partial", "failed"),
  completed: transitions(),
  partial: transitions(),
  failed: transitions(),
  cancelled: transitions()
}) satisfies Readonly<Record<RunState, readonly RunState[]>>;

export type RunTransitionActor =
  | "user"
  | "application"
  | "policy"
  | "tool";

export interface RunTransitionRecord {
  sequence: number;
  from: RunState;
  to: RunState;
  occurredAt: string;
  actor: RunTransitionActor;
  reason: string;
}

export interface RunStateSnapshot {
  state: RunState;
  version: number;
  createdAt: string;
  updatedAt: string;
  history: readonly RunTransitionRecord[];
}

export interface RunTransitionInput {
  to: RunState;
  occurredAt: string;
  actor: RunTransitionActor;
  reason: string;
}

export class IllegalRunTransitionError extends Error {
  readonly name = "IllegalRunTransitionError";
  readonly allowed: readonly RunState[];

  constructor(
    readonly from: RunState,
    readonly to: RunState
  ) {
    const allowed = allowedRunTransitions(from);
    super(
      `Illegal run transition: ${from} -> ${to}. Allowed: ${
        allowed.length > 0 ? allowed.join(", ") : "none"
      }`
    );
    this.allowed = [...allowed];
  }
}

/**
 * Creates the initial persisted shape without consulting a clock. Requiring a
 * canonical timestamp from the caller keeps replay and tests deterministic.
 */
export function createRunState(submittedAt: string): RunStateSnapshot {
  assertCanonicalTimestamp(submittedAt, "submittedAt");
  return {
    state: "submitted",
    version: 0,
    createdAt: submittedAt,
    updatedAt: submittedAt,
    history: []
  };
}

export function allowedRunTransitions(
  state: RunState
): readonly RunState[] {
  return RUN_TRANSITION_GRAPH[state];
}

export function canTransitionRun(
  from: RunState,
  to: RunState
): boolean {
  return allowedRunTransitions(from).includes(to);
}

export function isTerminalRunState(state: RunState): boolean {
  return (TERMINAL_RUN_STATES as readonly RunState[]).includes(state);
}

export function isRunCancellable(state: RunState): boolean {
  return (CANCELLABLE_RUN_STATES as readonly RunState[]).includes(state);
}

/**
 * Returns a new snapshot and leaves the supplied snapshot unchanged.
 */
export function transitionRun(
  snapshot: RunStateSnapshot,
  input: RunTransitionInput
): RunStateSnapshot {
  assertSnapshotShape(snapshot);
  assertCanonicalTimestamp(input.occurredAt, "occurredAt");
  if (Date.parse(input.occurredAt) < Date.parse(snapshot.updatedAt)) {
    throw new Error("occurredAt must not precede the current run timestamp");
  }

  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new Error("transition reason must not be empty");
  }
  if (!canTransitionRun(snapshot.state, input.to)) {
    throw new IllegalRunTransitionError(snapshot.state, input.to);
  }

  const record: RunTransitionRecord = {
    sequence: snapshot.version + 1,
    from: snapshot.state,
    to: input.to,
    occurredAt: input.occurredAt,
    actor: input.actor,
    reason
  };

  return {
    state: input.to,
    version: record.sequence,
    createdAt: snapshot.createdAt,
    updatedAt: input.occurredAt,
    history: [...snapshot.history, record]
  };
}

function assertSnapshotShape(snapshot: RunStateSnapshot): void {
  assertCanonicalTimestamp(snapshot.createdAt, "run createdAt");
  assertCanonicalTimestamp(snapshot.updatedAt, "run updatedAt");
  if (
    !Number.isInteger(snapshot.version) ||
    snapshot.version < 0 ||
    snapshot.history.length !== snapshot.version
  ) {
    throw new Error("run version must equal its transition history length");
  }
  if (Date.parse(snapshot.updatedAt) < Date.parse(snapshot.createdAt)) {
    throw new Error("run updatedAt must not precede createdAt");
  }

  const latest = snapshot.history.at(-1);
  if (
    (snapshot.version === 0 && snapshot.state !== "submitted") ||
    (latest !== undefined &&
      (latest.sequence !== snapshot.version ||
        latest.to !== snapshot.state ||
        latest.occurredAt !== snapshot.updatedAt))
  ) {
    throw new Error("run snapshot does not match its latest transition");
  }
}

function assertCanonicalTimestamp(value: string, name: string): void {
  const date = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(date.valueOf()) ||
    date.toISOString() !== value
  ) {
    throw new Error(`${name} must be a canonical UTC ISO timestamp`);
  }
}

import { describe, expect, it } from "vitest";
import {
  CANCELLABLE_RUN_STATES,
  IllegalRunTransitionError,
  RUN_STATES,
  RUN_TRANSITION_GRAPH,
  TERMINAL_RUN_STATES,
  allowedRunTransitions,
  canTransitionRun,
  createRunState,
  isRunCancellable,
  isTerminalRunState,
  transitionRun,
  type RunState,
  type RunStateSnapshot
} from "@/src/radar/domain/run-state";

const HAPPY_PATH = [
  "planned",
  "plan_approved",
  "resolving",
  "resolved",
  "peers_proposed",
  "peers_approved",
  "credit_approved",
  "executing",
  "verifying",
  "completed"
] as const satisfies readonly RunState[];

const EXPECTED_GRAPH = {
  submitted: ["planned", "failed", "cancelled"],
  planned: ["plan_approved", "failed", "cancelled"],
  plan_approved: ["resolving", "failed", "cancelled"],
  resolving: ["no_eligible_peers", "resolved", "failed"],
  no_eligible_peers: [],
  resolved: ["peers_proposed", "failed", "cancelled"],
  peers_proposed: ["peers_approved", "failed", "cancelled"],
  peers_approved: ["credit_approved", "failed", "cancelled"],
  credit_approved: ["executing", "failed", "cancelled"],
  executing: ["verifying", "failed"],
  verifying: ["completed", "partial", "failed"],
  completed: [],
  partial: [],
  failed: [],
  cancelled: []
} as const satisfies Readonly<Record<RunState, readonly RunState[]>>;

describe("run state machine", () => {
  it("records the complete approved workflow as immutable ordered history", () => {
    const initial = createRunState(at(0));
    let snapshot = initial;

    for (const [index, to] of HAPPY_PATH.entries()) {
      snapshot = transitionRun(snapshot, {
        to,
        occurredAt: at(index + 1),
        actor: actorFor(to),
        reason: `Advance to ${to}`
      });
    }

    expect(initial).toEqual({
      state: "submitted",
      version: 0,
      createdAt: at(0),
      updatedAt: at(0),
      history: []
    });
    expect(snapshot).toMatchObject({
      state: "completed",
      version: HAPPY_PATH.length,
      createdAt: at(0),
      updatedAt: at(HAPPY_PATH.length)
    });
    expect(snapshot.history).toHaveLength(HAPPY_PATH.length);
    expect(snapshot.history.map(({ sequence, from, to }) => ({
      sequence,
      from,
      to
    }))).toEqual(
      HAPPY_PATH.map((to, index) => ({
        sequence: index + 1,
        from: index === 0 ? "submitted" : HAPPY_PATH[index - 1],
        to
      }))
    );
    expect(snapshot.history[1]).toMatchObject({
      actor: "user",
      reason: "Advance to plan_approved",
      occurredAt: at(2)
    });
  });

  it.each(["completed", "partial", "failed"] as const)(
    "allows verification to settle as %s",
    (outcome) => {
      const verifying = snapshotAt("verifying");
      expect(
        transitionRun(verifying, {
          to: outcome,
          occurredAt: at(verifying.version + 1),
          actor: "application",
          reason: `Verification settled as ${outcome}`
        }).state
      ).toBe(outcome);
    }
  );

  it("settles peer discovery with no eligible peers as a terminal outcome", () => {
    const resolving = snapshotAt("resolving");
    const settled = transitionRun(resolving, {
      to: "no_eligible_peers",
      occurredAt: at(resolving.version + 1),
      actor: "application",
      reason: "No reach-comparable peers were available"
    });

    expect(settled.state).toBe("no_eligible_peers");
    expect(isTerminalRunState(settled.state)).toBe(true);
    expect(allowedRunTransitions(settled.state)).toEqual([]);
  });

  it("permits failure from every active state and makes failure terminal", () => {
    for (const state of RUN_STATES.filter(
      (candidate) => !isTerminalRunState(candidate)
    )) {
      expect(canTransitionRun(state, "failed")).toBe(true);
    }
    expect(allowedRunTransitions("failed")).toEqual([]);
  });

  it("allows cancellation at every pre-execution state and nowhere else", () => {
    expect(CANCELLABLE_RUN_STATES).toEqual([
      "submitted",
      "planned",
      "plan_approved",
      "resolved",
      "peers_proposed",
      "peers_approved",
      "credit_approved"
    ]);

    for (const state of RUN_STATES) {
      expect(isRunCancellable(state)).toBe(
        CANCELLABLE_RUN_STATES.includes(
          state as (typeof CANCELLABLE_RUN_STATES)[number]
        )
      );
      expect(canTransitionRun(state, "cancelled")).toBe(
        isRunCancellable(state)
      );
    }
    expect(canTransitionRun("executing", "cancelled")).toBe(false);
    expect(canTransitionRun("verifying", "cancelled")).toBe(false);
  });

  it("defines and enforces every legal and illegal edge exhaustively", () => {
    expect(RUN_TRANSITION_GRAPH).toEqual(EXPECTED_GRAPH);

    for (const from of RUN_STATES) {
      const legalTargets = EXPECTED_GRAPH[from] as readonly RunState[];
      for (const to of RUN_STATES) {
        const expected = legalTargets.includes(to);
        expect(
          canTransitionRun(from, to),
          `${from} -> ${to}`
        ).toBe(expected);

        const snapshot = snapshotAt(from);
        const operation = () =>
          transitionRun(snapshot, {
            to,
            occurredAt: at(snapshot.version + 1),
            actor: "application",
            reason: `Attempt ${from} -> ${to}`
          });
        if (expected) {
          expect(operation().state).toBe(to);
        } else {
          expect(operation).toThrow(IllegalRunTransitionError);
        }
      }
    }
  });

  it("prevents every terminal state from changing", () => {
    expect(TERMINAL_RUN_STATES).toEqual([
      "no_eligible_peers",
      "completed",
      "partial",
      "failed",
      "cancelled"
    ]);
    for (const state of TERMINAL_RUN_STATES) {
      expect(isTerminalRunState(state)).toBe(true);
      expect(allowedRunTransitions(state)).toEqual([]);
    }
  });

  it("rejects non-canonical, blank, regressing, and inconsistent history", () => {
    expect(() => createRunState("2026-07-19T12:00:00Z")).toThrow(
      /canonical UTC ISO timestamp/
    );

    const submitted = createRunState(at(1));
    expect(() =>
      transitionRun(submitted, {
        to: "planned",
        occurredAt: at(0),
        actor: "application",
        reason: "Build the plan"
      })
    ).toThrow(/must not precede/);
    expect(() =>
      transitionRun(submitted, {
        to: "planned",
        occurredAt: at(2),
        actor: "application",
        reason: " "
      })
    ).toThrow(/reason must not be empty/);

    const inconsistent: RunStateSnapshot = {
      ...submitted,
      version: 1
    };
    expect(() =>
      transitionRun(inconsistent, {
        to: "planned",
        occurredAt: at(2),
        actor: "application",
        reason: "Build the plan"
      })
    ).toThrow(/history length/);

    const planned = transitionRun(submitted, {
      to: "planned",
      occurredAt: at(2),
      actor: "application",
      reason: "Build the plan"
    });
    expect(() =>
      transitionRun(
        { ...planned, createdAt: at(3) },
        {
          to: "plan_approved",
          occurredAt: at(4),
          actor: "user",
          reason: "Approve the plan"
        }
      )
    ).toThrow(/updatedAt must not precede createdAt/);
    expect(() =>
      transitionRun(
        { ...planned, state: "resolved" },
        {
          to: "peers_proposed",
          occurredAt: at(3),
          actor: "application",
          reason: "Propose peers"
        }
      )
    ).toThrow(/latest transition/);
  });

  it("reports the attempted edge and allowed destinations on errors", () => {
    const submitted = createRunState(at(0));
    const error = captureError(() =>
      transitionRun(submitted, {
        to: "executing",
        occurredAt: at(1),
        actor: "application",
        reason: "Skip every approval"
      })
    );

    expect(error).toBeInstanceOf(IllegalRunTransitionError);
    expect(error).toMatchObject({
      name: "IllegalRunTransitionError",
      from: "submitted",
      to: "executing",
      allowed: ["planned", "failed", "cancelled"]
    });
    expect(error.message).toContain("submitted -> executing");
  });
});

function snapshotAt(target: RunState): RunStateSnapshot {
  let snapshot = createRunState(at(0));
  if (target === "submitted") {
    return snapshot;
  }
  if (target === "failed" || target === "cancelled") {
    return transitionRun(snapshot, {
      to: target,
      occurredAt: at(1),
      actor: target === "cancelled" ? "user" : "application",
      reason: `Settle as ${target}`
    });
  }

  if (target === "no_eligible_peers") {
    for (const [index, to] of [
      "planned",
      "plan_approved",
      "resolving"
    ].entries()) {
      snapshot = transitionRun(snapshot, {
        to: to as RunState,
        occurredAt: at(index + 1),
        actor: actorFor(to as RunState),
        reason: `Advance to ${to}`
      });
    }
    return transitionRun(snapshot, {
      to: "no_eligible_peers",
      occurredAt: at(4),
      actor: "application",
      reason: "No eligible peers"
    });
  }

  const path =
    target === "partial"
      ? [...HAPPY_PATH.slice(0, -1), "partial"] as const
      : HAPPY_PATH;
  for (const [index, to] of path.entries()) {
    snapshot = transitionRun(snapshot, {
      to,
      occurredAt: at(index + 1),
      actor: actorFor(to),
      reason: `Advance to ${to}`
    });
    if (to === target) {
      return snapshot;
    }
  }
  throw new Error(`No test path to ${target}`);
}

function actorFor(state: RunState) {
  if (
    state === "plan_approved" ||
    state === "peers_approved" ||
    state === "credit_approved"
  ) {
    return "user" as const;
  }
  return "application" as const;
}

function at(offsetMinutes: number): string {
  return new Date(
    Date.UTC(2026, 6, 19, 12, offsetMinutes)
  ).toISOString();
}

function captureError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }
  throw new Error("Expected operation to throw");
}

import { expect, test, type Page } from "@playwright/test";
import type { Phase3RunResource } from "@/src/radar/application/run-workflow";

const savedRunIdKey = "sponsor-radar-run-id";
const submitButtonName = "Find winback opportunities";

test("production-safe smoke renders empty intake without starting research", async ({
  page
}) => {
  const runRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/runs")) {
      runRequests.push(request.method());
    }
  });

  await page.goto("/");

  await expect(
    page.getByRole("heading", { level: 1, name: "Sponsor Winback Radar" })
  ).toBeVisible();
  await expect(page.getByLabel("Target YouTube channel")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: submitButtonName })
  ).toBeEnabled();
  await expectNoReviewUi(page);
  expect(runRequests).toEqual([]);
});

test("one click returns and restores only the Dell XPS lead", async ({
  page
}) => {
  const automaticActions: string[] = [];
  let releasePlanResolution!: () => void;
  const holdPlanResolution = new Promise<void>((resolve) => {
    releasePlanResolution = resolve;
  });
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.endsWith("/actions")) return;
    const body = request.postDataJSON() as { action?: string } | null;
    if (body?.action) automaticActions.push(body.action);
  });
  await page.route("**/api/runs/*/actions", async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action === "approve_plan") {
      await holdPlanResolution;
    }
    await route.continue();
  });

  await page.goto("/");
  await enterFixtureChannel(page);
  await page.getByRole("button", { name: submitButtonName }).click();
  await expect(
    page.getByRole("heading", { name: "Researching winback opportunities" })
  ).toBeVisible();
  await expectNoReviewUi(page);
  releasePlanResolution();

  await expectFixtureReport(page);
  expect(automaticActions).toEqual(["approve_plan", "approve_execution"]);
  await expectNoReviewUi(page);

  await expect(
    page.getByRole("heading", { name: "Dell", exact: true })
  ).toBeVisible();
  await expect(page.getByText("Strong product match")).toBeVisible();
  await expect(page.getByText("1 opportunity")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dave2D" })).toBeVisible();
  await expect(page.getByText(/sponsored Dave2D 33 days ago/)).toBeVisible();
  await expect(
    page.getByText(/found on the target channel was 191 days ago/)
  ).toBeVisible();
  await expect(page.getByText("3.69M subscribers")).toBeVisible();
  await expect(page.getByText(/Similar audience size/)).toBeVisible();
  await expect(page.getByText("Jun 16, 2026").first()).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "What this report can and cannot tell you"
    })
  ).toBeVisible();

  await page.getByText("Demo data and performance").click();
  await expect(
    page.getByText("credits estimated from returned rows").locator("..")
  ).toContainText("0");

  const savedRunId = await page.evaluate((key) => {
    return window.localStorage.getItem(key);
  }, savedRunIdKey);
  expect(savedRunId).toMatch(/^run_[a-f0-9]{32}$/);

  const restoreRequests: Array<{ method: string; pathname: string }> = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/runs")) {
      restoreRequests.push({ method: request.method(), pathname });
    }
  });
  await page.reload();
  await expectFixtureReport(page);
  await expect(
    page.getByRole("heading", { name: "Dell", exact: true })
  ).toBeVisible();
  await expectNoReviewUi(page);
  expect(restoreRequests.length).toBeGreaterThanOrEqual(1);
  expect(
    restoreRequests.every(
      (request) =>
        request.method === "GET" &&
        request.pathname === `/api/runs/${savedRunId}`
    )
  ).toBe(true);
});

test("an interrupted automatic step can be cancelled without sponsor research", async ({
  page
}) => {
  const actions: string[] = [];
  await page.route("**/api/runs/*/actions", async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action) actions.push(body.action);
    if (body.action !== "approve_plan") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Channel resolution is temporarily unavailable",
        code: "run_conflict",
        retryable: true
      })
    });
  });

  await page.goto("/");
  await enterFixtureChannel(page);
  await page.getByRole("button", { name: submitButtonName }).click();

  await expect(
    page.getByRole("heading", { name: "We couldn’t continue this search" })
  ).toBeVisible();
  await expect(page.locator(".workflow-issue")).toContainText(
    "This search changed while the page was open."
  );
  await expect(page.locator(".workspace > .error-panel")).toHaveCount(0);
  await expect(page.getByText("Research in progress", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Research paused safely", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
  await expectNoReviewUi(page);
  await page.getByRole("button", { name: "Cancel research" }).click();

  await expect(
    page.getByRole("heading", { name: "Run cancelled" })
  ).toBeVisible();
  await expect(
    page.getByText("Research was cancelled at the last safe checkpoint.")
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Dell", exact: true })
  ).toHaveCount(0);
  expect(actions).toEqual(["approve_plan", "cancel"]);
  await expectNoReviewUi(page);
});

test("a lost create response reuses the persisted idempotency key", async ({
  page
}) => {
  let firstKey: string | undefined;
  let secondKey: string | undefined;
  let firstRequest = true;
  await page.route("**/api/runs", async (route) => {
    const key = route.request().headers()["idempotency-key"];
    if (firstRequest) {
      firstRequest = false;
      firstKey = key;
      await route.fetch();
      await route.abort("failed");
      return;
    }
    secondKey = key;
    await route.continue();
  });

  await page.goto("/");
  await enterFixtureChannel(page);
  await page.getByRole("button", { name: submitButtonName }).click();
  await expect(page.locator(".form-error")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Target YouTube channel")).toHaveValue(
    "@UrAvgConsumer"
  );
  await page.getByRole("button", { name: submitButtonName }).click();
  await expectFixtureReport(page);
  expect(secondKey).toBe(firstKey);
  await expectNoReviewUi(page);
});

test("a transient restore failure keeps the saved run reference", async ({
  page
}) => {
  const runId = "run_0123456789abcdef0123456789abcdef";
  await page.addInitScript((savedRunId) => {
    window.localStorage.setItem("sponsor-radar-run-id", savedRunId);
  }, runId);
  await page.route(`**/api/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Quota 5f4b7f44e6924ad88f4ca4e19efd7da904b4264a4564d299c14016fc74851760 already has maximumUnits 150, not 200",
        code: "research_unavailable",
        retryable: false
      })
    });
  });

  await page.goto("/");
  await expect(
    page.getByText(
      "We can’t complete this search because the demo service needs attention. Please contact the demo owner.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(page.getByLabel("Target YouTube channel")).not.toHaveAttribute(
    "aria-invalid"
  );
  await expect(page.locator(".form-error")).not.toContainText("maximumUnits");
  await expect(page.locator(".form-error")).not.toContainText("150");
  await expect(page.locator(".form-error")).not.toContainText("200");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("sponsor-radar-run-id")
      )
    )
    .toBe(runId);
});

test("blank input is rejected accessibly without creating a run", async ({
  page
}) => {
  await page.goto("/");
  await page.getByLabel("Target YouTube channel").fill("   ");
  await page.getByRole("button", { name: submitButtonName }).click();

  await expect(page.locator(".form-error > p").first()).toHaveText(
    "Enter one exact YouTube @handle or channel URL."
  );
  await expect(page.getByLabel("Target YouTube channel")).toHaveAttribute(
    "aria-invalid",
    "true"
  );
  await expect(page.locator(".workflow-panel")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate((key) => window.localStorage.getItem(key), savedRunIdKey)
    )
    .toBeNull();
  await expectNoReviewUi(page);
});

test("arbitrary exact channels enter the one-click workflow without a review screen", async ({
  page
}) => {
  let submittedChannel: string | undefined;
  await page.route("**/api/runs", async (route) => {
    const body = route.request().postDataJSON() as { channel?: string };
    submittedChannel = body.channel;

    // The local E2E server deliberately runs the deterministic fixture gateway.
    // Rewrite only the server-side fixture input so this remains a zero-cost
    // browser contract test for arbitrary-channel intake.
    const response = await route.fetch({
      postData: JSON.stringify({ channel: "@UrAvgConsumer" })
    });
    await route.fulfill({ response });
  });

  await page.goto("/");
  await page.getByLabel("Target YouTube channel").fill("@MKBHD");
  await page.getByRole("button", { name: submitButtonName }).click();

  await expectFixtureReport(page);
  expect(submittedChannel).toBe("@MKBHD");
  await expect(page.locator(".error-panel")).toHaveCount(0);
  await expectNoReviewUi(page);
});

test("a completed run with no qualified leads renders the explicit empty state", async ({
  page
}) => {
  await rewriteExecutionResponse(page, (completed) => {
    if (!completed.report) {
      throw new Error("Expected the fixture execution to return a report");
    }
    return {
      ...completed,
      report: {
        ...completed.report,
        leads: []
      }
    };
  });

  await completeFixtureWorkflow(page);

  await expectFixtureReport(page);
  await expect(page.getByText("0 opportunities")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "No qualified winback opportunity found"
    })
  ).toBeVisible();
  await expect(
    page.getByText(/intentionally not padded with weak matches/)
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Dell", exact: true })
  ).toHaveCount(0);
});

test("partial peer coverage remains visible while verified leads are preserved", async ({
  page
}) => {
  await rewriteExecutionResponse(page, (completed) => {
    if (!completed.report) {
      throw new Error("Expected the fixture execution to return a report");
    }
    return {
      ...completed,
      status: "partial",
      state: {
        ...completed.state,
        state: "partial"
      },
      report: {
        ...completed.report,
        coverage: [
          ...completed.report.coverage,
          {
            code: "peer_research_partial",
            severity: "warning",
            numerator: 2,
            denominator: 3,
            message:
              "Sponsor research failed for Hayls World. Valid evidence from the remaining peers was preserved, but coverage is partial."
          }
        ]
      }
    };
  });

  await completeFixtureWorkflow(page);

  await expect(
    page.getByText(/preserves evidence from successful peers/)
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Dell", exact: true })
  ).toBeVisible();
  await expect(page.getByText(/Sponsor research failed for Hayls World/)).toBeVisible();
});

test("request rate limiting stops automatic work and remains explicitly retryable", async ({
  page
}) => {
  let executionAttempts = 0;
  await page.route("**/api/runs/*/actions", async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action !== "approve_execution") {
      await route.continue();
      return;
    }
    executionAttempts += 1;
    if (executionAttempts > 1) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Too many workflow requests. Wait briefly before trying again.",
        code: "rate_limited",
        retryable: true
      })
    });
  });

  await page.goto("/");
  await enterFixtureChannel(page);
  await page.getByRole("button", { name: submitButtonName }).click();

  await expect(page.locator(".workflow-issue")).toContainText(
    "Too many research requests were started at once."
  );
  await expect(page.locator(".workspace > .error-panel")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(executionAttempts).toBe(1);
  await expectNoReviewUi(page);
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();

  await page.getByRole("button", { name: "Try again" }).click();
  await expectFixtureReport(page);
  expect(executionAttempts).toBe(2);
  await expectNoReviewUi(page);
});

test("the per-run research limit is friendly and never offers a paid retry", async ({
  page
}) => {
  let planAttempts = 0;
  await page.route("**/api/runs/*/actions", async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action !== "approve_plan") {
      await route.continue();
      return;
    }
    planAttempts += 1;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error:
          "This search reached the demo’s per-run research limit. No additional provider research was started.",
        code: "run_credit_limit_reached",
        retryable: false
      })
    });
  });

  await page.goto("/");
  await enterFixtureChannel(page);
  await page.getByRole("button", { name: submitButtonName }).click();

  const panel = page.locator(".workflow-panel");
  await expect(
    panel.getByRole("heading", { name: "We couldn’t continue this search" })
  ).toBeVisible();
  await expect(panel).toContainText(
    "This search reached the demo’s per-run research limit. No additional provider research was started."
  );
  await expect(panel).toContainText(
    "No additional research was started after this issue."
  );
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to search" })).toBeEnabled();
  await page.waitForTimeout(300);
  expect(planAttempts).toBe(1);
});

test("a saved-capacity mismatch is safe, integrated, and not misleadingly retryable", async ({
  page
}) => {
  const quotaHash =
    "5f4b7f44e6924ad88f4ca4e19efd7da904b4264a4564d299c14016fc74851760";
  let planAttempts = 0;
  await page.route("**/api/runs/*/actions", async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action !== "approve_plan") {
      await route.continue();
      return;
    }
    planAttempts += 1;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: `Quota ${quotaHash} already has maximumUnits 150, not 200`,
        code: "research_unavailable",
        retryable: false
      })
    });
  });

  await page.goto("/");
  await enterFixtureChannel(page);
  await page.getByRole("button", { name: submitButtonName }).click();

  const panel = page.locator(".workflow-panel");
  await expect(
    panel.getByRole("heading", { name: "We couldn’t continue this search" })
  ).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(1);
  await expect(panel).toContainText(
    "We can’t complete this search because the demo service needs attention. Please contact the demo owner."
  );
  await expect(panel).toContainText(
    "No additional research was started after this issue."
  );
  await expect(page.locator(".workspace > .error-panel")).toHaveCount(0);
  await expect(page.getByText("Research in progress", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Research paused safely", { exact: true })).toHaveCount(0);
  await expect(panel).not.toContainText(quotaHash);
  await expect(panel).not.toContainText("maximumUnits");
  await expect(panel).not.toContainText("150");
  await expect(panel).not.toContainText("200");
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to search" })).toBeEnabled();
  await page.waitForTimeout(300);
  expect(planAttempts).toBe(1);

  await page.getByRole("button", { name: "Back to search" }).click();
  await expect(page.getByLabel("Target YouTube channel")).toBeVisible();
  await expect(page.locator(".workflow-panel")).toHaveCount(0);
});

test("mobile layout stays within the viewport and stacks the primary form", async ({
  page
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");

  const input = page.getByLabel("Target YouTube channel");
  await input.fill("@UrAvgConsumer");
  const createButton = page.getByRole("button", {
    name: submitButtonName
  });
  const inputBox = await input.boundingBox();
  const buttonBox = await createButton.boundingBox();

  expect(inputBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox!.y).toBeGreaterThan(inputBox!.y + inputBox!.height);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);

  await createButton.click();
  await expectFixtureReport(page);
  await expectNoReviewUi(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

test("core workflow controls have semantic labels and work from the keyboard", async ({
  page
}) => {
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Sponsor winback report" })
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Target YouTube channel")).toBeFocused();
  await page.keyboard.type("@UrAvgConsumer");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: submitButtonName })
  ).toBeFocused();
  await page.keyboard.press("Enter");

  await expectFixtureReport(page);
  await expect(page.locator(".workflow-panel")).toHaveCount(0);
  await expect(page.locator(".report")).toHaveAttribute("aria-live", "polite");
  await expectNoReviewUi(page);
});

async function completeFixtureWorkflow(page: Page): Promise<void> {
  await page.goto("/");
  await enterFixtureChannel(page);
  await page.getByRole("button", { name: submitButtonName }).click();
  await expectFixtureReport(page);
  await expectNoReviewUi(page);
}

async function expectFixtureReport(page: Page): Promise<void> {
  await expect(page.locator(".report")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator(".report-heading").getByRole("heading", {
      name: "UrAvgConsumer",
      exact: true
    })
  ).toBeVisible();
}

async function enterFixtureChannel(page: Page): Promise<void> {
  await page
    .getByLabel("Target YouTube channel")
    .fill("@UrAvgConsumer");
}

async function rewriteExecutionResponse(
  page: Page,
  rewrite: (completed: Phase3RunResource) => Phase3RunResource
): Promise<void> {
  await page.route("**/api/runs/*/actions", async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action !== "approve_execution") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    if (!response.ok()) {
      throw new Error(
        `Fixture execution failed with HTTP ${response.status()}`
      );
    }
    const completed = (await response.json()) as Phase3RunResource;
    await route.fulfill({
      response,
      json: rewrite(completed)
    });
  });
}

async function expectNoReviewUi(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Review the research plan" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "Review peers and approve the credit limit"
    })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Approve plan|Approve \d+ peers?/ })
  ).toHaveCount(0);
  await expect(page.getByText("Full run ceiling", { exact: true })).toHaveCount(
    0
  );
  await expect(
    page.getByText("Sponsor research ceiling", { exact: true })
  ).toHaveCount(0);
}

import { expect, test, type Page } from "@playwright/test";
import type { WorkflowRunResource } from "@/src/radar/application/run-workflow";

// Default journey (ADR 0008/0009): the autonomous engine finishes the whole
// run inside the create request, so submission goes straight to the report.

const savedRunIdKey = "sponsor-radar-run-id";
const channelInputLabel = "Channel handle or URL";
const submitButtonName = "Research channel";

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
  await expect(page.getByLabel(channelInputLabel)).toHaveValue("");
  await expect(
    page.getByRole("button", { name: submitButtonName })
  ).toBeEnabled();
  await expectNoReviewUi(page);
  await expectPublicSurfaceSafe(page);
  expect(runRequests).toEqual([]);
});

test("channel interpretation stays canonical, accessible, and editable", async ({
  page
}) => {
  await page.goto("/");

  const input = page.getByLabel(channelInputLabel);
  const interpretation = page.getByRole("status");
  await expect(interpretation).toHaveCount(0);

  await input.fill("dave2d");
  await expect(input).toBeEditable();
  await expect(interpretation).toHaveText(
    "We’ll research: youtube.com/@dave2d"
  );
  await expect(input).toHaveAccessibleDescription(
    /We’ll research: youtube\.com\/@dave2d/
  );

  await input.fill("m.youtube.com/@MKBHD");
  await expect(input).toHaveValue("m.youtube.com/@MKBHD");
  await expect(interpretation).toHaveText(
    "We’ll research: youtube.com/@MKBHD"
  );
  await expect(input).toHaveAccessibleDescription(
    /We’ll research: youtube\.com\/@MKBHD/
  );
});

test("rendered failures hide implementation vocabulary and diagnostics", async ({
  page
}) => {
  const internalHash =
    "5f4b7f44e6924ad88f4ca4e19efd7da904b4264a4564d299c14016fc74851760";
  await page.route("**/api/runs", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error:
          `Wording fixture provider payload at /Users/operator/.data/sponsor-radar: ` +
          `Quota quota_${internalHash} has maximumUnits 150; ` +
          "UPRIVER_API_KEY configuration failed.",
        code: "research_unavailable",
        retryable: false
      })
    });
  });

  await page.goto("/");
  await page.getByLabel(channelInputLabel).fill("@UrAvgConsumer");
  await page.getByRole("button", { name: submitButtonName }).click();

  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "We couldn’t complete this research right now. Start a new search or try again later."
  );
  await expectPublicSurfaceSafe(page);
  const publicText = (await page.getByRole("main").textContent()) ?? "";
  expect(publicText).not.toContain(internalHash);
  expect(publicText).not.toContain("maximumUnits");
  expect(publicText).not.toContain("UPRIVER_API_KEY");
  expect(publicText).not.toContain("/Users/operator/.data/sponsor-radar");
});

test("one click completes an autonomous run inline and restores only the Dell XPS lead", async ({
  page
}) => {
  const actionRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/actions")) {
      actionRequests.push(request.method());
    }
  });
  let releaseCreateResponse!: () => void;
  const holdCreateResponse = new Promise<void>((resolve) => {
    releaseCreateResponse = resolve;
  });
  await page.route("**/api/runs", async (route) => {
    const response = await route.fetch();
    await holdCreateResponse;
    await route.fulfill({ response });
  });

  await page.goto("/");
  await enterFixtureChannel(page);
  await page.getByRole("button", { name: submitButtonName }).click();

  // The whole run happens inside the create request: the intake stays busy
  // and no approval, review, or cancel controls ever surface.
  await expect(
    page.getByRole("button", { name: "Starting research…" })
  ).toBeDisabled();
  await expect(page.locator(".workflow-panel")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Cancel research" })
  ).toHaveCount(0);
  await expectNoReviewUi(page);
  releaseCreateResponse();

  await expectFixtureReport(page);
  expect(actionRequests).toEqual([]);
  await expectNoReviewUi(page);

  await expect(
    page.getByRole("heading", { name: "Dell", exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("Same sponsor · product unverified")
  ).toBeVisible();
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

  await page.getByText("How this research works").click();
  await expect(
    page.getByText(
      /confirm the exact YouTube channel, compare reach-comparable channels/
    )
  ).toBeVisible();
  await expect(page.getByText("Technical activity log")).toHaveCount(0);

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
  expect(actionRequests).toEqual([]);
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
  // The create request holds the connection for the whole inline run, so
  // the aborted response can take longer than the default expect timeout.
  await expect(page.locator(".form-error")).toBeVisible({ timeout: 20_000 });

  await page.reload();
  await expect(page.getByLabel(channelInputLabel)).toHaveValue(
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
      "We couldn’t complete this research right now. Start a new search or try again later.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(page.getByLabel(channelInputLabel)).not.toHaveAttribute(
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
  await page.getByLabel(channelInputLabel).fill("   ");
  await page.getByRole("button", { name: submitButtonName }).click();

  await expect(page.locator(".form-error > p").first()).toHaveText(
    "Enter a YouTube channel handle or URL."
  );
  await expect(page.getByLabel(channelInputLabel)).toHaveAttribute(
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

    // The local E2E server runs the agentic fixture engine. Rewrite only the
    // server-side fixture input so this remains a zero-cost browser contract
    // test for arbitrary-channel intake.
    const response = await route.fetch({
      postData: JSON.stringify({ channel: "@UrAvgConsumer" })
    });
    await route.fulfill({ response });
  });

  await page.goto("/");
  await page.getByLabel(channelInputLabel).fill("@MKBHD");
  await page.getByRole("button", { name: submitButtonName }).click();

  await expectFixtureReport(page);
  expect(submittedChannel).toBe("@MKBHD");
  await expect(page.locator(".error-panel")).toHaveCount(0);
  await expectNoReviewUi(page);
});

test("a completed run with no qualified leads renders the explicit empty state", async ({
  page
}) => {
  await rewriteCompletedRunResponse(page, (completed) => {
    if (!completed.report) {
      throw new Error("Expected the fixture run to return a report");
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
  await rewriteCompletedRunResponse(page, (completed) => {
    if (!completed.report) {
      throw new Error("Expected the fixture run to return a report");
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

test("request rate limiting stops research before it starts and remains explicitly retryable", async ({
  page
}) => {
  let createAttempts = 0;
  await page.route("**/api/runs", async (route) => {
    createAttempts += 1;
    if (createAttempts > 1) {
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

  await expect(page.locator(".form-error")).toContainText(
    "Too many research requests were started at once."
  );
  await expect(page.locator(".form-error")).toContainText(
    "Your request is saved. Try again when you’re ready."
  );
  await expect(page.locator(".workflow-panel")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(createAttempts).toBe(1);
  await expect
    .poll(() =>
      page.evaluate((key) => window.localStorage.getItem(key), savedRunIdKey)
    )
    .toBeNull();
  await expectNoReviewUi(page);
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();

  await page.getByRole("button", { name: "Try again" }).click();
  await expectFixtureReport(page);
  expect(createAttempts).toBe(2);
  await expectNoReviewUi(page);
});

test("the per-run research limit is friendly and never offers a paid retry", async ({
  page
}) => {
  let createAttempts = 0;
  await page.route("**/api/runs", async (route) => {
    createAttempts += 1;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error:
          "This research reached its safety limit. Start a new search.",
        code: "run_credit_limit_reached",
        retryable: false
      })
    });
  });

  await page.goto("/");
  await enterFixtureChannel(page);
  await page.getByRole("button", { name: submitButtonName }).click();

  await expect(page.locator(".form-error")).toContainText(
    "This research reached its safety limit. Start a new search."
  );
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: submitButtonName })
  ).toBeEnabled();
  await expect(page.locator(".workflow-panel")).toHaveCount(0);
  await expect(page.locator(".report")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(createAttempts).toBe(1);
  await expect
    .poll(() =>
      page.evaluate((key) => window.localStorage.getItem(key), savedRunIdKey)
    )
    .toBeNull();
});

test("a saved-capacity mismatch is safe, sanitized, and not misleadingly retryable", async ({
  page
}) => {
  const quotaHash =
    "5f4b7f44e6924ad88f4ca4e19efd7da904b4264a4564d299c14016fc74851760";
  let createAttempts = 0;
  await page.route("**/api/runs", async (route) => {
    createAttempts += 1;
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

  const formError = page.locator(".form-error");
  await expect(formError).toContainText(
    "We couldn’t complete this research right now. Start a new search or try again later."
  );
  await expect(formError).not.toContainText(quotaHash);
  await expect(formError).not.toContainText("maximumUnits");
  await expect(formError).not.toContainText("150");
  await expect(formError).not.toContainText("200");
  await expectPublicSurfaceSafe(page);
  await expect(page.getByText("Research in progress", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Research paused safely", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(page.locator(".workflow-panel")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(createAttempts).toBe(1);

  // The intake stays live, so the user is already back at search.
  const input = page.getByLabel(channelInputLabel);
  await expect(input).toBeEditable();
  await input.fill("@MKBHD");
  await expect(formError).toHaveCount(0);
});

test("mobile layout stays within the viewport and stacks the primary form", async ({
  page
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");

  const input = page.getByLabel(channelInputLabel);
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
  await expect(page.getByLabel(channelInputLabel)).toBeFocused();
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
  await expectPublicSurfaceSafe(page);
}

async function enterFixtureChannel(page: Page): Promise<void> {
  await page
    .getByLabel(channelInputLabel)
    .fill("@UrAvgConsumer");
}

// Rewrites the create response: the autonomous run completes inside the
// create request, so terminal-report shaping happens at this one boundary.
async function rewriteCompletedRunResponse(
  page: Page,
  rewrite: (completed: WorkflowRunResource) => WorkflowRunResource
): Promise<void> {
  await page.route("**/api/runs", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) {
      throw new Error(
        `Fixture research failed with HTTP ${response.status()}`
      );
    }
    const completed = (await response.json()) as WorkflowRunResource;
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
    page.getByRole("button", { name: /approve|review|confirm/i })
  ).toHaveCount(0);
  await expect(page.getByText("Full run ceiling", { exact: true })).toHaveCount(
    0
  );
  await expect(
    page.getByText("Sponsor research ceiling", { exact: true })
  ).toHaveCount(0);
}

async function expectPublicSurfaceSafe(page: Page): Promise<void> {
  const publicText = (await page.getByRole("main").textContent()) ?? "";
  const forbiddenPatterns = [
    /\b(?:demo|pilot|fixture)\b/i,
    /\bphase(?:[\s_-]?[1-5])\b/i,
    /\bprovider\b/i,
    /\bquota\b/i,
    /\bconfiguration\b/i,
    /\b(?:SPONSOR_RADAR|UPRIVER|OPENAI)_[A-Z0-9_]+\b/,
    /\bmaximumUnits\b/i,
    /\b[a-f0-9]{64}\b/i,
    /(?:\/Users\/|\/private\/(?:tmp|var)\/|\.data\/|app\/api\/|src\/)/i
  ];

  for (const pattern of forbiddenPatterns) {
    expect(publicText).not.toMatch(pattern);
  }
}

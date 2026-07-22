import { expect, test } from "@playwright/test";

/**
 * The agentic-engine browser journey (ADR 0008). Runs only via
 * `pnpm test:e2e:agentic`, which boots the server with
 * SPONSOR_RADAR_ENGINE=agentic. The autonomous engine finishes the whole
 * run inside the create request, so the UI goes straight from submission to
 * the report with zero action calls — same screens, same restore behavior.
 */

const savedRunIdKey = "sponsor-radar-run-id";
const channelInputLabel = "Channel handle or URL";
const submitButtonName = "Research channel";

test.skip(
  process.env.SPONSOR_RADAR_ENGINE !== "agentic",
  "requires the agentic server (pnpm test:e2e:agentic)"
);

test("one click completes an autonomous run and restores the Dell lead", async ({
  page
}) => {
  const actionRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/actions")) {
      actionRequests.push(request.method());
    }
  });

  await page.goto("/");
  await page.getByLabel(channelInputLabel).fill("@UrAvgConsumer");
  await page.getByRole("button", { name: submitButtonName }).click();

  await expect(
    page.getByRole("heading", { name: "Dell", exact: true })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("1 opportunity")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dave2D" })).toBeVisible();
  await expect(
    page.getByText("Same sponsor · product unverified")
  ).toBeVisible();

  // No approval choreography and no review screens ever surface.
  expect(actionRequests).toEqual([]);
  await expect(
    page.getByRole("button", { name: /approve|review|confirm/i })
  ).toHaveCount(0);
  await expect(page.getByText("Technical activity log")).toHaveCount(0);

  const savedRunId = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    savedRunIdKey
  );
  expect(savedRunId).toMatch(/^run_[a-f0-9]{32}$/);

  const restoreRequests: Array<{ method: string; pathname: string }> = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/runs")) {
      restoreRequests.push({ method: request.method(), pathname });
    }
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Dell", exact: true })
  ).toBeVisible();
  expect(restoreRequests.length).toBeGreaterThanOrEqual(1);
  expect(
    restoreRequests.every(
      (request) =>
        request.method === "GET" &&
        request.pathname === `/api/runs/${savedRunId}`
    )
  ).toBe(true);
});

test("blank input is rejected without starting any research", async ({
  page
}) => {
  const runRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/runs")) {
      runRequests.push(request.method());
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: submitButtonName }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(runRequests).toEqual([]);
});

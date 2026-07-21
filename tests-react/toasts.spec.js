const { test, expect } = require("./helpers/test");

async function openRenderMenu(page) {
  await page.getByRole("button", { name: "Render", exact: true }).click();
  return page.getByRole("dialog", { name: "Render" });
}

test("a failed render job raises a sticky global error toast", async ({ page }) => {
  await page.route("**/__cf/actions/render**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-t1" }) });
  });
  await page.route("**/__cf/actions/status/job-t1**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobId: "job-t1",
        status: "failed",
        built: 0,
        reused: 0,
        failed: 1,
        total: 10,
        error: "Builder exited with code 1.",
      }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await drawer.getByRole("button", { name: "▶ Render" }).click();

  const toast = page.getByTestId("toast").filter({ hasText: "Render failed" });
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(toast).toHaveAttribute("data-tone", "error");
  await expect(toast).toContainText("Builder exited with code 1.");

  // Sticky: still present after the popover closes and time passes.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1_000);
  await expect(toast).toBeVisible();
});

test("a completed render raises a success toast that can be dismissed", async ({ page }) => {
  await page.route("**/__cf/actions/render**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-t2" }) });
  });
  await page.route("**/__cf/actions/status/job-t2**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobId: "job-t2", status: "done", built: 10, reused: 0, failed: 0, total: 10 }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await drawer.getByRole("button", { name: "▶ Render" }).click();

  const toast = page.getByTestId("toast").filter({ hasText: "Render complete" });
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(toast).toHaveAttribute("data-tone", "success");

  await toast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(toast).toHaveCount(0);
});

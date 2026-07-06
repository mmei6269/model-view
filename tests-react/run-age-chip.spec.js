const { test, expect } = require("@playwright/test");

// Fixture cache (react-cache) ships a recent HRRR run; the chip must render an
// age label near the panel status and, for a deliberately old referenceTime,
// surface the "newer run" hint. We stub the manifest to control referenceTime.
test("panel shows a run-age chip derived from manifest referenceTime", async ({ page }) => {
  await page.route("**/__cf/manifests/**", async (route, request) => {
    // Only rewrite the run manifest (not runs.json/latest.json) to inject an old referenceTime.
    const url = request.url();
    if (/latest\.json|runs\.json/.test(url)) return route.continue();
    const response = await route.fetch();
    let body;
    try {
      body = await response.json();
    } catch {
      return route.fulfill({ response });
    }
    if (body && Array.isArray(body.frames)) {
      const old = new Date(Date.now() - 9 * 3600 * 1000).toISOString();
      body.referenceTime = old;
    }
    return route.fulfill({ response, body: JSON.stringify(body) });
  });

  await page.goto("/");
  const chip = page.getByTestId("run-age-chip").first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toContainText(/h old/i);
});

const { test, expect } = require("@playwright/test");

const viewports = [
  { width: 1920, height: 1080, name: "desktop-1920x1080" },
  { width: 1366, height: 768, name: "desktop-1366x768" },
  { width: 430, height: 932, name: "mobile-430x932" },
];

for (const vp of viewports) {
  test(`responsive layout ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/");
    await page.waitForTimeout(1800);

    const panel = page.locator("article").first();
    await expect(panel).toBeVisible();
    await expect(panel.locator(".leaflet-container")).toBeVisible();

    await page.screenshot({ path: `test-results/react/${vp.name}.png`, fullPage: true });
  });
}

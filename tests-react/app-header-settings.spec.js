const { test, expect } = require("@playwright/test");

// Playwright's visibility check treats clipped-but-laid-out elements as visible
// (they keep a non-empty bounding box), so the collapsed drawer's select still
// reports isVisible(). Probe real visibility (ancestor opacity) instead.
function isDrawerShown(zoneSelect) {
  return zoneSelect.evaluate((el) => el.checkVisibility({ checkOpacity: true, opacityProperty: true }));
}

async function openSettingsDrawer(page) {
  const zoneSelect = page.getByLabel("Time zone");
  await expect(zoneSelect).toBeAttached();
  // The drawer currently defaults to open; toggle it open if that ever changes.
  if (!(await isDrawerShown(zoneSelect))) {
    await page.getByRole("button", { name: "Settings" }).click();
  }
  await expect.poll(() => isDrawerShown(zoneSelect)).toBe(true);
  return zoneSelect;
}

test("settings drawer does not clip the timezone row on narrow windows", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto("/");
  const zoneSelect = await openSettingsDrawer(page);
  await page.waitForTimeout(400); // let the 300ms open transition settle
  const headerBox = await page.locator("header").first().boundingBox();
  const zoneBox = await zoneSelect.boundingBox();
  if (!headerBox || !zoneBox) {
    throw new Error("Header or timezone select bounding box is unavailable.");
  }
  expect(zoneBox.y + zoneBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height + 0.5);
});

test("settings drawer still collapses when toggled closed", async ({ page }) => {
  await page.goto("/");
  const zoneSelect = await openSettingsDrawer(page);
  const header = page.locator("header").first();
  const openBox = await header.boundingBox();
  if (!openBox) {
    throw new Error("Header bounding box is unavailable.");
  }
  await page.getByRole("button", { name: "Settings" }).click();
  // Assert the collapse through layout (the header shrinks back) plus opacity;
  // not.toBeVisible() would never pass because the clipped select keeps a box.
  await expect.poll(async () => (await header.boundingBox())?.height ?? 0).toBeLessThan(openBox.height - 20);
  await expect.poll(() => isDrawerShown(zoneSelect)).toBe(false);
});

test("a stored custom IANA zone renders as a labeled option and stays selected", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("modelview.timezone.v1", "Europe/Berlin");
  });
  await page.goto("/");
  const zoneSelect = await openSettingsDrawer(page);
  await expect(zoneSelect).toHaveValue("Europe/Berlin");
  await expect(zoneSelect.locator("option[value='Europe/Berlin']")).toHaveText("Europe/Berlin");
});

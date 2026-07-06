const { test, expect } = require("@playwright/test");

test("hover readout card stays mounted when the cursor moves onto it", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator("article").first();
  const map = panel.locator(".leaflet-container").first();
  await expect(map).toBeVisible();
  const mapBox = await map.boundingBox();
  if (!mapBox) {
    throw new Error("Map container bounding box is unavailable.");
  }

  await page.mouse.move(mapBox.x + mapBox.width * 0.5, mapBox.y + mapBox.height * 0.5);
  const coordLine = panel
    .locator("p")
    .filter({ hasText: /°[NS]\s+\d+(?:\.\d+)?°[EW]/ })
    .first();
  await expect(coordLine).toBeVisible();
  const card = coordLine.locator("xpath=..");
  const cardBox = await card.boundingBox();
  if (!cardBox) {
    throw new Error("Hover card bounding box is unavailable.");
  }

  // Moving the cursor onto the card must not unmount it: with pointer events
  // disabled the map underneath keeps receiving mousemove and never fires mouseout.
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2, { steps: 5 });
  await page.waitForTimeout(300);
  await expect(coordLine).toBeVisible();
  await expect(card).toHaveCSS("pointer-events", "none");
});

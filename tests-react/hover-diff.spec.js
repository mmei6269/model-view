const { test, expect } = require("./helpers/test");

// Two panels over the real fixture cache: hovering panel 1 (GFS) mirrors the
// cursor onto panel 2 (NAM 3km), which samples its own hover grid at the same
// point and shows Δ(panel 2 − panel 1) per shared layer.
test("hovering one panel mirrors the cursor and shows numeric diffs on the other", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add Map" }).click();
  await expect(page.locator("article")).toHaveCount(2);

  const source = page.locator("article").nth(0);
  const mirror = page.locator("article").nth(1);
  const sourceMap = source.locator('[data-testid="map-canvas-host"]').first();
  await expect(sourceMap).toBeVisible();
  const box = await sourceMap.boundingBox();
  if (!box) {
    throw new Error("Source map bounding box unavailable.");
  }

  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 3 });

  // The hovered panel shows its normal readout; the other panel mirrors.
  await expect(source.getByTestId("hover-readout")).toBeVisible();
  const mirrored = mirror.getByTestId("hover-readout-mirrored");
  await expect(mirrored).toBeVisible();
  await expect(mirrored).toContainText("Δ vs GFS");
  // Temperature is active in both panels, so a numeric Δ (or Δ0) renders.
  await expect(mirrored).toContainText(/Δ(0|[+−]\d)/);

  // The mirrored cursor renders as a crosshair marker on the other map.
  await expect(mirror.locator(".remote-hover-crosshair")).toHaveCount(1);

  // Leaving the source map clears the mirror everywhere.
  await page.mouse.move(box.x + box.width * 0.5, 4);
  await expect(mirrored).toHaveCount(0);
  await expect(mirror.locator(".remote-hover-crosshair")).toHaveCount(0);
});

const { test, expect } = require("./helpers/test");

// v2 = the native-zoom session schema (Task 6.2); writes only ever go here.
const KEY = "modelview.session.v2";

test("view key persists across reload", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("View").selectOption("na");
  await expect
    .poll(() => page.evaluate((k) => JSON.parse(window.localStorage.getItem(k) || "{}").viewKey, KEY))
    .toBe("na");
  await page.reload();
  await expect(page.getByLabel("View")).toHaveValue("na");
});

test("a stored session hydrates the view and synoptic toggles", async ({ page }) => {
  // Deliberately seeds the LEGACY v1 key: unit-less fields hydrate through
  // the Task 6.2 fallback loader unchanged (viewport-zoom conversion has its
  // own tests in url-state.spec.js + tests-node/zoom-persistence-migration).
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "modelview.session.v1",
      JSON.stringify({
        viewKey: "na",
        showIsobars: false,
        showCenters: false,
        showThickness: false,
        synopticDetailMode: "detailed",
        reflectivityGate: 20,
        settingsOpen: true,
      }),
    );
  });
  await page.goto("/");
  await expect(page.getByLabel("View")).toHaveValue("na");
  await expect(page.getByRole("button", { name: "Isobars" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Thickness" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Centers" })).toHaveAttribute("aria-pressed", "false");
});

test("toggling isobars off persists and rehydrates", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Isobars" }).click();
  await expect(page.getByRole("button", { name: "Isobars" })).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(page.getByRole("button", { name: "Isobars" })).toHaveAttribute("aria-pressed", "false");
});

test("timeline axis mode persists across reload", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Axis").selectOption("panel");
  await expect(page.getByLabel("Axis")).toHaveValue("panel");
  await page.reload();
  await expect(page.getByLabel("Axis")).toHaveValue("panel");
});

test("viewport link toggle persists across reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Link Viewports" }).click();
  await expect(page.getByRole("button", { name: "Link Viewports" })).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(page.getByRole("button", { name: "Link Viewports" })).toHaveAttribute("aria-pressed", "false");
});

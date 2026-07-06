"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

test("preview block mirrors the /__cf artifact proxy from the server block", async () => {
  const mod = await import("../vite.config.ts").catch(async () => {
    // If this Node can't import TS, fall back to reading the source and asserting shape.
    return null;
  });
  if (mod && typeof mod.default === "function") {
    const config = mod.default({ mode: "production", command: "serve" });
    assert.ok(config.server?.proxy?.["/__cf"], "server proxy should exist");
    assert.ok(config.preview?.proxy?.["/__cf"], "preview proxy must mirror server proxy");
    assert.equal(config.preview.proxy["/__cf"].target, config.server.proxy["/__cf"].target);
  } else {
    const fs = require("fs");
    const source = fs.readFileSync(require("path").resolve(__dirname, "..", "vite.config.ts"), "utf8");
    const previewBlock = source.slice(source.indexOf("preview:"));
    assert.match(previewBlock, /"\/__cf"/, "preview block must define the /__cf proxy");
  }
});

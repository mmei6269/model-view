#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const TRACKED_FILES = execFileSync("git", ["ls-files"], { cwd: ROOT_DIR, encoding: "utf8" })
  .trim()
  .split(/\n/)
  .filter(Boolean);

const SOURCE_EXTENSIONS = new Set([".js", ".ts", ".tsx", ".css", ".html"]);
const REPORT_IGNORES = [/^scripts\/geo-source\//, /^next\/public\/geo\//, /^package-lock\.json$/];

function shouldSkip(filePath) {
  return REPORT_IGNORES.some((pattern) => pattern.test(filePath));
}

function countMatches(source, pattern) {
  const matches = source.match(pattern);
  return matches ? matches.length : 0;
}

function inspectFile(filePath) {
  const fullPath = path.join(ROOT_DIR, filePath);
  const source = fs.readFileSync(fullPath, "utf8");
  const lines = source.length === 0 ? 0 : source.split(/\r\n|\r|\n/).length;
  return {
    file: filePath,
    lines,
    effects: countMatches(source, /\buse(?:Effect|LayoutEffect)\b/g),
    functions: countMatches(source, /\bfunction\b|=>/g),
    branches: countMatches(source, /\bif\b|\belse\b|\bswitch\b|\bcase\b|\bfor\b|\bwhile\b|\bcatch\b|\? /g),
  };
}

const sourceFiles = TRACKED_FILES.filter((filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath))).filter(
  (filePath) => !shouldSkip(filePath),
);

const inspected = sourceFiles.map(inspectFile).sort((left, right) => right.lines - left.lines);
const totals = inspected.reduce(
  (acc, entry) => {
    acc.files += 1;
    acc.lines += entry.lines;
    acc.effects += entry.effects;
    acc.functions += entry.functions;
    acc.branches += entry.branches;
    return acc;
  },
  { files: 0, lines: 0, effects: 0, functions: 0, branches: 0 },
);

console.log("Maintainability report");
console.log("======================");
console.log(`Files scanned: ${totals.files}`);
console.log(`Lines scanned: ${totals.lines}`);
console.log(`Functions/arrows: ${totals.functions}`);
console.log(`React effects: ${totals.effects}`);
console.log(`Branch markers: ${totals.branches}`);
console.log("");
console.log("Largest canonical files:");
for (const entry of inspected.slice(0, 12)) {
  console.log(
    `${String(entry.lines).padStart(5, " ")} lines  ${String(entry.functions).padStart(3, " ")} funcs  ${String(
      entry.effects,
    ).padStart(2, " ")} effects  ${entry.file}`,
  );
}

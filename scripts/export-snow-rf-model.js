#!/usr/bin/env node

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const EXPECTED_UTAHRFSLR_COMMIT = "2d35566fd41e99dcdc75a0f107ddb6bdc6a46b61";
const EXPECTED_MODEL_SHA256 = "1e53b00fb7cebb4bab2a3bffaccdfaacd3bedd483c4a4b29f7b8963d21718cbf";
const EXPECTED_KEYS_SHA256 = "40b236da30099c554e1dd893af57b989366d0c3007ab7a83dc011e8db0a7a774";
const EXPECTED_FEATURE_KEYS = Object.freeze([
  "SPD03K",
  "SPD06K",
  "SPD09K",
  "SPD12K",
  "SPD15K",
  "SPD18K",
  "SPD21K",
  "SPD24K",
  "T03K",
  "T06K",
  "T09K",
  "T12K",
  "T15K",
  "T18K",
  "T21K",
  "T24K",
  "R03K",
  "R06K",
  "R09K",
  "R12K",
  "R15K",
  "R18K",
  "R21K",
  "R24K",
  "elev",
  "lat",
  "lon",
]);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = path.resolve(args["source-dir"] || args.source || "tools/noaa-beta/snow-rf/utahrfslr");
  const outputPath = path.resolve(args.output || "output/noaa-beta-tools/snow-rf/conus-rf.json");
  const python = args.python || process.env.PYTHON || "python3";
  const modelPath = path.join(sourceDir, "models/rf/rf_slr_model.pkl");
  const keysPath = path.join(sourceDir, "models/rf/rf_slr_model_keys.npy");

  assertFileHash(modelPath, EXPECTED_MODEL_SHA256, "Pletcher RF model");
  assertFileHash(keysPath, EXPECTED_KEYS_SHA256, "Pletcher RF feature keys");
  assertGitCommit(sourceDir, EXPECTED_UTAHRFSLR_COMMIT);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const exporterPath = writePythonExporter();
  const result = spawnSync(python, [exporterPath, modelPath, keysPath, outputPath, EXPECTED_UTAHRFSLR_COMMIT], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, EXPECTED_FEATURE_KEYS: JSON.stringify(EXPECTED_FEATURE_KEYS) },
  });
  fs.rmSync(exporterPath, { force: true });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `RF export failed. Install Python packages scikit-learn, joblib, and numpy in the selected Python, then retry.`,
    );
  }
  console.log(`[snow-rf] wrote ${outputPath}`);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) {
      continue;
    }
    const trimmed = token.slice(2);
    const eq = trimmed.indexOf("=");
    if (eq >= 0) {
      out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    } else {
      out[trimmed] = argv[index + 1];
      index += 1;
    }
  }
  return out;
}

function assertFileHash(filePath, expectedHash, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} is missing at ${filePath}`);
  }
  const hash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  if (hash !== expectedHash) {
    throw new Error(`${label} hash mismatch for ${filePath}: expected ${expectedHash}, got ${hash}`);
  }
}

function assertGitCommit(sourceDir, expectedCommit) {
  const manifestPath = path.join(sourceDir, "source-manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const commit = String(manifest.commit || "").trim();
    if (commit !== expectedCommit) {
      throw new Error(`utahrfslr manifest commit mismatch: expected ${expectedCommit}, got ${commit}`);
    }
    return;
  }
  if (!fs.existsSync(path.join(sourceDir, ".git"))) {
    throw new Error(`Unable to verify utahrfslr source commit in ${sourceDir}; missing source-manifest.json or .git`);
  }
  const result = spawnSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Unable to verify utahrfslr git commit in ${sourceDir}`);
  }
  const commit = result.stdout.trim();
  if (commit !== expectedCommit) {
    throw new Error(`utahrfslr commit mismatch: expected ${expectedCommit}, got ${commit}`);
  }
}

function writePythonExporter() {
  const body = String.raw`
import json
import os
import sys

try:
    import joblib
    import numpy as np
except Exception as exc:
    raise SystemExit(f"Missing Python RF export dependency: {exc}")

model_path, keys_path, output_path, source_commit = sys.argv[1:5]
expected_keys = json.loads(os.environ["EXPECTED_FEATURE_KEYS"])
model = joblib.load(model_path)
keys = [str(item) for item in np.load(keys_path, allow_pickle=True).tolist()]
if keys != expected_keys:
    raise SystemExit(f"Feature key mismatch: {keys}")
trees = []
for estimator in model.estimators_:
    tree = estimator.tree_
    trees.append({
        "childrenLeft": tree.children_left.astype(int).tolist(),
        "childrenRight": tree.children_right.astype(int).tolist(),
        "feature": tree.feature.astype(int).tolist(),
        "threshold": tree.threshold.astype(float).tolist(),
        "value": tree.value.reshape((tree.value.shape[0], -1))[:, 0].astype(float).tolist(),
    })
payload = {
    "kind": "sklearn-random-forest-regressor",
    "source": "mdpletcher/utahrfslr",
    "sourceCommit": source_commit,
    "featureKeys": keys,
    "trees": trees,
}
tmp = f"{output_path}.tmp"
with open(tmp, "w", encoding="utf8") as handle:
    json.dump(payload, handle, separators=(",", ":"))
os.replace(tmp, output_path)
`;
  const filePath = path.join(os.tmpdir(), `snow-rf-export-${process.pid}-${Date.now()}.py`);
  fs.writeFileSync(filePath, body);
  return filePath;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error);
    process.exit(1);
  }
}

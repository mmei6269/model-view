"use strict";

const fs = require("fs");
const path = require("path");

async function readJsonIfExists(filePath) {
  // No exists pre-check: cache prune/clear can delete the file between a
  // check and the read, and access-denied must surface instead of reading
  // as "missing". ENOENT is the only condition that means "not there".
  let content;
  try {
    content = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return JSON.parse(content);
}

async function pathExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(filePath, payload, options = {}) {
  await writeBufferAtomic(filePath, Buffer.from(JSON.stringify(payload)), options);
}

async function writeBufferAtomic(filePath, body, options = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (options.ensureDir !== false) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  }
  if (options.atomic === false) {
    await fs.promises.writeFile(filePath, buffer);
    return;
  }
  const tempPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.promises.writeFile(tempPath, buffer);
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    // Manifests/pointers/markers are not best-effort, so the failure still
    // propagates — but never leave the orphaned temp file behind (ENOSPC
    // failures would otherwise self-amplify by eating more disk).
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
}

module.exports = {
  pathExists,
  readJsonIfExists,
  writeBufferAtomic,
  writeJsonAtomic,
};

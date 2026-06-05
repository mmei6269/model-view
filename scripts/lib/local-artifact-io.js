"use strict";

const fs = require("fs");
const path = require("path");

async function readJsonIfExists(filePath) {
  if (!(await pathExists(filePath))) {
    return null;
  }
  const content = await fs.promises.readFile(filePath, "utf8");
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
  await fs.promises.writeFile(tempPath, buffer);
  await fs.promises.rename(tempPath, filePath);
}

module.exports = {
  pathExists,
  readJsonIfExists,
  writeBufferAtomic,
  writeJsonAtomic,
};

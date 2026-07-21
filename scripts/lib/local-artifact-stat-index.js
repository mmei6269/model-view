"use strict";

const fs = require("fs");
const path = require("path");

// Per-sweep index of frame-directory entries. One readdir({ withFileTypes })
// per directory replaces the per-key access() probes of a completeness sweep;
// entry stats (byte refreshes, symlink targets) are fetched lazily, once per
// path, and memoized alongside. An instance must not outlive the sweep that
// created it: presence answers are as fresh as the readdir at first touch of
// a directory, the same observation instant the per-key probes they replace
// would have had. Completeness stays snapshot-safe across a concurrently
// rendering frame because persistence writes the .complete.json marker LAST —
// a listing taken before the marker lands reads the frame as incomplete, and
// the next sweep's fresh listing sees every artifact that preceded it.
class FrameStatIndex {
  constructor() {
    this.listings = new Map();
    this.entries = new Map();
  }

  // Resolves to a Map of dirents, or null when the directory exists but
  // cannot be listed. Only a directory that is not there (or not a
  // directory) indexes as empty — the same verdict every per-key probe
  // against it would reach. Any other readdir failure (e.g. a
  // search-only/execute-only directory whose children still stat fine) must
  // NOT read as "no artifacts": has()/stat() fall back to the per-key probes
  // the index replaces, so a listing-denied directory never flips complete
  // frames to pending or zeroes their byte counts.
  listing(frameDir) {
    let listing = this.listings.get(frameDir);
    if (!listing) {
      listing = fs.promises.readdir(frameDir, { withFileTypes: true }).then(
        (dirents) => new Map(dirents.map((dirent) => [dirent.name, dirent])),
        (error) => (error?.code === "ENOENT" || error?.code === "ENOTDIR" ? new Map() : null),
      );
      this.listings.set(frameDir, listing);
    }
    return listing;
  }

  async has(frameDir, name) {
    const dirents = await this.listing(frameDir);
    if (!dirents) {
      // Listing denied: per-key fallback (stat resolves symlink targets the
      // same way the access() probe this replaces did).
      return (await this.stat(frameDir, name)) !== null;
    }
    const dirent = dirents.get(name);
    if (!dirent) {
      return false;
    }
    // access(F_OK) succeeds on anything readdir surfaces except a dangling
    // symlink, whose target must resolve — one stat, and only for links.
    if (!dirent.isSymbolicLink()) {
      return true;
    }
    return (await this.stat(frameDir, name)) !== null;
  }

  stat(frameDir, name) {
    const entryPath = path.join(frameDir, name);
    let entry = this.entries.get(entryPath);
    if (!entry) {
      entry = this.listing(frameDir).then(async (dirents) => {
        if (dirents && !dirents.has(name)) {
          return null;
        }
        try {
          return await fs.promises.stat(entryPath);
        } catch {
          return null;
        }
      });
      this.entries.set(entryPath, entry);
    }
    return entry;
  }
}

module.exports = { FrameStatIndex };

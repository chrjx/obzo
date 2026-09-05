#!/usr/bin/env node
/**
 * Bump the plugin version across the repo. Usage:
 *   node scripts/version-bump.mjs 0.2.0
 *
 * Updates the root manifest.json version, adds a versions.json entry mapping the
 * new version -> current minAppVersion, and mirrors the version into the
 * obsidian-plugin package.json. Commit + tag `<version>` to trigger a release.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(target ?? "")) {
  console.error("Usage: node scripts/version-bump.mjs <x.y.z>");
  process.exit(1);
}

const manifestPath = join(root, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = target;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const versionsPath = join(root, "versions.json");
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
versions[target] = manifest.minAppVersion;
writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n");

const pkgPath = join(root, "obsidian-plugin", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = target;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`Bumped to ${target}. Next:`);
console.log(`  git commit -am "${target}" && git tag ${target} && git push --follow-tags`);

// Run by `npm version <patch|minor|major>`: copies the new package.json version
// into manifest.json and records its minAppVersion in versions.json.
import { readFileSync, writeFileSync } from "fs";

const version = process.env.npm_package_version;
if (!version) throw new Error("Run this through `npm version`.");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[version] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

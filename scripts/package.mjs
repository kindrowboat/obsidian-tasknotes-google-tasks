// Package the built plugin into dist/<id>/ and dist/<id>-<version>.zip.
// The folder can be copied straight into <vault>/.obsidian/plugins/.
// Run `npm run package` (which builds first).
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";

const ASSETS = ["main.js", "manifest.json", "styles.css"];

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.version !== pkg.version) {
	throw new Error(`manifest.json version ${manifest.version} does not match package.json ${pkg.version}. Use \`npm version\`.`);
}

for (const f of ASSETS) if (!existsSync(f)) throw new Error(`${f} is missing. Run \`npm run build\` first.`);

const outDir = join("dist", manifest.id);
rmSync("dist", { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const f of ASSETS) copyFileSync(f, join(outDir, f));

const zip = `${manifest.id}-${manifest.version}.zip`;
try {
	execFileSync("zip", ["-r", "-q", zip, manifest.id], { cwd: "dist", stdio: "inherit" });
	console.log(`Packaged dist/${manifest.id}/ and dist/${zip}`);
} catch {
	console.log(`Packaged dist/${manifest.id}/ (zip not available, skipped dist/${zip})`);
}

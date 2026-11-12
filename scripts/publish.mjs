// Publish a release of the plugin.
//
//   npm run publish-plugin                 release the current version on GitHub
//   npm run publish-plugin -- --submit     also open the community-plugin submission PR (first release only)
//   npm run publish-plugin -- --dry-run    print what would happen
//
// Requirements: a clean git tree on the default branch, a GitHub remote named
// `origin`, and the GitHub CLI (`gh`) signed in. See docs/PUBLISHING.md.
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const submit = args.has("--submit");
const RELEASES_REPO = "obsidianmd/obsidian-releases";

function run(cmd, cmdArgs, opts = {}) {
	console.log(`$ ${cmd} ${cmdArgs.join(" ")}`);
	if (dryRun && !opts.readOnly) return "";
	try {
		return (execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: opts.inherit ? "inherit" : ["inherit", "pipe", "inherit"], cwd: opts.cwd }) ?? "").trim();
	} catch (e) {
		if (e.code === "ENOENT") {
			console.error(`\`${cmd}\` is not installed.${cmd === "gh" ? " Install the GitHub CLI: https://cli.github.com/" : ""}`);
			process.exit(1);
		}
		throw e;
	}
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
const version = manifest.version;

// --- Preflight -------------------------------------------------------------
if (pkg.version !== version) throw new Error(`package.json (${pkg.version}) and manifest.json (${version}) disagree. Use \`npm version\`.`);
if (!versions[version]) throw new Error(`versions.json has no entry for ${version}.`);
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Obsidian requires x.y.z versions; got ${version}.`);
run("gh", ["auth", "status"], { readOnly: true });
const dirty = run("git", ["status", "--porcelain"], { readOnly: true });
if (dirty && !dryRun) throw new Error("Working tree is not clean. Commit or stash first.");
const repo = run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { readOnly: true });

// --- Build, tag, release ---------------------------------------------------
run("npm", ["test"], { inherit: true });
run("npm", ["run", "package"], { inherit: true });

const tags = run("git", ["tag", "--list", version], { readOnly: true });
if (!tags) {
	// Obsidian looks up releases by a tag equal to the version, with no "v" prefix.
	run("git", ["tag", "-a", version, "-m", version]);
}
run("git", ["push", "origin", "HEAD"], { inherit: true });
run("git", ["push", "origin", version], { inherit: true });

const notes = `Release ${version} of ${manifest.name}.`;
run("gh", ["release", "create", version, "main.js", "manifest.json", "styles.css",
	"--title", version, "--notes", notes, "--verify-tag"], { inherit: true });
console.log(`Released ${version} at https://github.com/${repo}/releases/tag/${version}`);

// --- Community plugin submission (first release only) -----------------------
if (!submit) {
	console.log("Skipping community-plugin submission (pass --submit for the first release).");
	process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "obsidian-releases-"));
run("gh", ["repo", "fork", RELEASES_REPO, "--clone", "--remote", "--default-branch-only", "--", work], { inherit: true });
const branch = `add-${manifest.id}`;
run("git", ["checkout", "-b", branch], { cwd: work });

const listPath = join(work, "community-plugins.json");
if (!dryRun) {
	const list = JSON.parse(readFileSync(listPath, "utf8"));
	if (list.some((p) => p.id === manifest.id)) throw new Error(`${manifest.id} is already listed in ${RELEASES_REPO}.`);
	list.push({ id: manifest.id, name: manifest.name, author: manifest.author, description: manifest.description, repo });
	writeFileSync(listPath, JSON.stringify(list, null, "\t") + "\n");
}
run("git", ["commit", "-am", `Add plugin: ${manifest.name}`], { cwd: work });
run("git", ["push", "-u", "origin", branch], { cwd: work, inherit: true });
run("gh", ["pr", "create", "--repo", RELEASES_REPO, "--title", `Add plugin: ${manifest.name}`,
	"--body", `Adds [${manifest.name}](https://github.com/${repo}).\n\nPlease complete the checklist in the PR template before review.`,
	"--web"], { cwd: work, inherit: true });
console.log("Finish the submission checklist in the browser window that opened.");

# Publishing

How to cut a release and get the plugin into Obsidian's Community Plugins directory.

## One-time setup

1. **Host the repository on GitHub.** It must be public. Obsidian downloads release assets from GitHub.
   ```bash
   git init && git add -A && git commit -m "Initial commit"
   gh repo create <you>/obsidian-tasknotes-google-tasks --public --source . --push
   ```
2. **Install and sign in to the GitHub CLI**: `gh auth login`. The publish script uses it for releases and for the submission PR.
3. **Check `manifest.json`:**
   - `id` (`tasknotes-google-tasks`) must be unique in the directory, must not contain "obsidian", and can never change after submission.
   - `name` and `description` must not contain "Obsidian". The description should be a short sentence ending in a period.
   - `author` and `authorUrl` are yours.
   - `minAppVersion` is the oldest Obsidian version you support.
4. **Review Obsidian's [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines) and [developer policies](https://docs.obsidian.md/Developers/Policies).** Network use and account requirements must be disclosed in the README; this one already covers Google sign-in and that data goes to Google.

## Releasing a version

Versions follow `x.y.z` and the git tag must equal the version exactly, with **no `v` prefix**.

```bash
npm version patch          # or minor / major
npm run publish-plugin
```

`npm version` bumps `package.json`. It then runs `scripts/version-bump.mjs`, which copies the version into `manifest.json` and adds a `version → minAppVersion` entry to `versions.json`. Finally it commits the change and tags it. The project's `.npmrc` sets `tag-version-prefix=""`, so the tag is `0.1.1`, not `v0.1.1`.

`npm run publish-plugin` (`scripts/publish.mjs`) then:

1. Checks that versions agree, the tree is clean, and `gh` is signed in.
2. Runs the tests and `npm run package`.
3. Creates the tag if `npm version` didn't, then pushes the branch and the tag.
4. Creates a GitHub release named after the version, with `main.js`, `manifest.json` and `styles.css` attached as individual assets. Obsidian needs these three files as separate assets; a zip doesn't work.

Use `npm run publish-plugin -- --dry-run` to see the commands without running them.

## Submitting to Community Plugins (first release only)

After the first release exists:

```bash
npm run publish-plugin -- --submit
```

After releasing, this forks [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases), adds an entry to `community-plugins.json`:

```json
{
	"id": "tasknotes-google-tasks",
	"name": "TaskNotes Google Tasks Sync",
	"author": "Ko-op Dunlap",
	"description": "Two-way sync between TaskNotes tasks and Google Tasks, mapping each Google Tasks list to a TaskNotes context.",
	"repo": "<you>/obsidian-tasknotes-google-tasks"
}
```

and opens the pull request in your browser. Fill in the PR template's checklist there; the review bot checks it.

To do it by hand instead: fork `obsidian-releases`, append the same object to the end of `community-plugins.json`, and open a PR titled `Add plugin: TaskNotes Google Tasks Sync`.

### Review

- An automated check runs first: manifest fields, release assets, and the ID not already taken. Fix whatever it reports by pushing a new release. The PR picks up the latest release.
- A human review follows and can take a while. Address comments with new releases, not by editing the PR, unless they ask you to.
- Once merged, the plugin shows up in **Browse** within a few hours.

## Later releases

Only `npm version …` and `npm run publish-plugin` are needed. Obsidian reads `manifest.json` from the default branch and fetches the matching release. For users on older Obsidian versions, it uses `versions.json` to pick the newest compatible release.

## Beta testing

Before submitting, or for pre-releases, testers can install through [BRAT](https://github.com/TfTHacker/obsidian42-brat) using the repository URL. Mark such releases as pre-release on GitHub (`gh release edit <version> --prerelease`).

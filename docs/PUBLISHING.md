# Publishing

How to cut a release and get the plugin into Obsidian's Community Plugins directory.

The repository lives at <https://github.com/kindrowboat/obsidian-tasknotes-google-tasks>. Releasing needs the GitHub CLI (`gh`) signed in to an account that can push there.

## Before the first release

1. **Check `manifest.json`:**
   - `id` (`tasknotes-google-tasks`) must be unique in the directory, must not contain "obsidian", and can never change after submission.
   - `name` and `description` must not contain "Obsidian". The description should be a short sentence ending in a period.
   - `author` and `authorUrl` are yours.
   - `minAppVersion` is the oldest Obsidian version you support.
2. **Review Obsidian's [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines) and [developer policies](https://docs.obsidian.md/Developers/Policies).** The README must disclose network use and account requirements. Ours already says that you sign in to Google and that task data is sent to Google.

## Cutting a release

Versions follow `x.y.z`. The release's tag must equal the version exactly, with **no `v` prefix**.

```bash
npm version patch          # or minor / major
npm run publish-plugin
```

**`npm version`** prepares the version:

1. Bumps `package.json`.
2. Runs `scripts/version-bump.mjs`, which copies the version into `manifest.json` and adds a `version → minAppVersion` entry to `versions.json`.
3. Commits and tags the change. The project's `.npmrc` sets `tag-version-prefix=""`, so the tag is `0.1.1`, not `v0.1.1`.

**`npm run publish-plugin`** (`scripts/publish.mjs`) publishes it:

1. Checks that the versions agree, the working tree is clean, and `gh` is signed in.
2. Runs the tests and `npm run package`.
3. Creates the tag if `npm version` didn't, then sends the version commit and tag to GitHub.
4. Creates a GitHub release named after the version, with `main.js`, `manifest.json` and `styles.css` attached as separate files. Obsidian needs these three files individually; a zip doesn't work.

Add `-- --dry-run` to print the commands without running them:

```bash
npm run publish-plugin -- --dry-run
```

## Submitting to Community Plugins (first release only)

Once a release exists, run:

```bash
npm run publish-plugin -- --submit
```

After releasing, this forks [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases) and adds this entry to the end of its `community-plugins.json`:

```json
{
	"id": "tasknotes-google-tasks",
	"name": "TaskNotes Google Tasks Sync",
	"author": "Ko-op Dunlap",
	"description": "Two-way sync between TaskNotes tasks and Google Tasks, mapping each Google Tasks list to a TaskNotes context.",
	"repo": "kindrowboat/obsidian-tasknotes-google-tasks"
}
```

It then opens the pull request in your browser. Fill in the checklist in the PR template there; the review bot checks it.

To submit by hand instead, fork `obsidian-releases`, append the same object to the end of `community-plugins.json`, and open a PR titled `Add plugin: TaskNotes Google Tasks Sync`.

### Review

- **Automated check:** runs first. It checks the manifest fields, the release assets, and that the plugin ID isn't taken. Fix anything it reports by publishing a new release; the PR always uses the latest one.
- **Human review:** follows, and can take a while. Address comments by publishing new releases, not by editing the PR, unless the reviewer asks you to.
- **Merge:** once the PR is merged, the plugin appears in **Browse** within a few hours.

## Later releases

After the plugin is listed, each release is just:

```bash
npm version patch          # or minor / major
npm run publish-plugin
```

Obsidian reads `manifest.json` from the default branch and downloads the matching release. Users on older Obsidian versions get the newest release that `versions.json` says is compatible.

## Beta testing

Before submitting, or for pre-releases, testers can install the plugin with [BRAT](https://github.com/TfTHacker/obsidian42-brat) using the repository URL. Mark such releases as pre-releases on GitHub:

```bash
gh release edit <version> --prerelease
```

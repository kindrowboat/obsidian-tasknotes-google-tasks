# Architecture

This document explains how the plugin is put together and why. For user-facing behaviour, see the [README](../README.md).

## Layout

```
src/
  main.ts              Plugin entry: commands, ribbon, status bar, timer, token refresh, sync lock
  settings.ts          Settings types and defaults (persisted to data.json)
  settingsTab.ts       Settings UI: account, sync, list ↔ context mapping, behaviour, TaskNotes, advanced
  util.ts              Small shared helpers
  google/
    auth.ts            OAuth 2.0 (authorization code + PKCE, loopback redirect), refresh, revoke
    tasksApi.ts        Thin Google Tasks REST v1 client built on Obsidian's requestUrl
  tasknotes/
    config.ts          Resolves TaskNotes conventions (folder, tag, field names, statuses)
    repository.ts      Reads and writes task notes (frontmatter + body)
  sync/
    model.ts           Pure logic: field normalisation, fingerprints, conflict resolution, status marker
    lists.ts           Pure logic: merging fetched lists into mappings, validating mappings
    engine.ts          Orchestrates one sync run
tests/
  model.test.ts        Unit tests for the pure modules (node:test via tsx)
scripts/
  package.mjs          Copies build output to dist/<id>/ and zips it
  version-bump.mjs     Keeps manifest.json / versions.json in step with `npm version`
  publish.mjs          Tags, creates the GitHub release, optionally opens the community-plugin PR
```

`sync/model.ts` and `sync/lists.ts` import nothing from Obsidian, so they can be unit tested in plain Node. Everything that touches the vault or the network sits behind `TaskNoteRepository` and `TasksApi`.

## Data model

### Identity

A linked pair is identified by the **Google task ID**, which is stored in the note's frontmatter:

```yaml
googleTaskId: <task id>
googleTaskListId: <list id>
```

(Both key names are configurable.) Frontmatter is used, not file paths, for two reasons:

- Obsidian renames and moves keep frontmatter, so local renames don't break the link.
- Google task IDs are stable across title edits, so remote renames don't break it either.

With a title-in-filename setup (the TaskNotes default), a remote rename results in a file rename through `FileManager.renameFile`, which also updates links to the note.

### Sync records

`settings.records` maps each Google task ID to a `SyncRecord`:

```ts
{ googleTaskId, listId, path, fingerprint }
```

`fingerprint` is a hash of the normalised `SyncFields` (`title`, `status`, `due`, `notes`, `context`) as they were after the last successful sync. It is a three-way-merge base without storing full copies. The engine compares each side's current fingerprint with it to tell which side changed. `path` is informational only.

`settings.ignoredRemoteIds` holds Google tasks whose local note was deleted while **Propagate deletions** was off. They are never re-imported.

### Status mapping

Google Tasks has two states. TaskNotes has user-defined statuses, each flagged completed or not. The mapping is:

- A completed TaskNotes status ↔ Google `completed`.
- The default open status ↔ Google `needsAction` with no marker.
- Any other open status (for example `in-progress`) ↔ `needsAction`, plus a line at the end of the Google notes:

  ```
  [tasknotes: status=in-progress]
  ```

On the way in, `decodeGoogleNotes` strips the marker from the free text. `statusFromGoogle` then combines it with Google's status. If the user completes or reopens the task in Google, that wins over a marker that disagrees. This keeps the Google app authoritative for the one thing it can express.

The marker is in the notes rather than a hidden field because Google Tasks has no custom fields. The notes are also the only field users see, so the marker shows the status to them as well.

### Contexts and lists

`ListMapping` entries (`listId`, `listTitle`, `context`, `enabled`, `present`) are the single source of truth for which lists sync. `mergeLists` is called on every sync and on "Refresh". It adds new lists as disabled and unmapped, refreshes titles, and marks vanished lists `present: false` instead of dropping them, so a temporarily missing list doesn't lose its mapping. `activeMappings` filters to enabled, present and mapped lists, and refuses to run if two lists share a context. That makes the mapping a bijection between synced lists and their contexts.

A note's list is the first of its contexts that is mapped (`pickMappedContext`). When pulling a context change, the repository replaces the old mapped context in the `contexts` array with the new one and keeps any unmapped contexts.

## A sync run (`SyncEngine.run`)

1. **Resolve config.** `resolveConfig` reads TaskNotes' live settings object (`app.plugins.plugins.tasknotes.settings`) for the tasks folder, identification (tag or property), field mapping, default status and completed statuses. If TaskNotes isn't loaded, or the user opted out, it uses the fallback values from our settings. Only read-only access is used, so TaskNotes version changes degrade gracefully to the fallbacks.
2. **Refresh lists** and compute the active mappings.
3. **Snapshot remote.** Fetch every task in every active list with `showCompleted`, `showHidden` and `showDeleted`. Deleted tasks are needed to tell "deleted in Google" apart from "never seen".
4. **Snapshot local.** Scan markdown files whose cached frontmatter identifies them as tasks. If two notes carry the same Google ID (a copied note), the second one is treated as unlinked.
5. **Linked notes.** For each local note with an ID in an active list:
   - Remote present: `resolve()` returns `none`, `push` or `pull`. A push of a context change calls `tasks.move` with `destinationTasklist`. If that is rejected, it falls back to insert + delete and relinks under the new ID.
   - Remote deleted, or missing although we have a record: queue a local deletion.
   - Remote missing and no record: a stale ID, for example from a restored backup. Treat the note as unlinked.
6. **Unlinked notes** with a mapped context: create the Google task, then write the ID into the note.
7. **Unlinked remote tasks**: if we have a record, the note was deleted locally, so queue a remote deletion. Otherwise create a note in the tasks folder. Completed tasks are skipped unless "Include completed tasks when linking" is on.
8. **Deletions.** Deletions are planned and applied after everything else, so a safety check can veto them as a batch: more than 5 deletions, and more than half of all linked tasks, aborts them with an error. Local deletions use `FileManager.trashFile`, which respects the user's trash preference.
9. **Clean up** records for tasks gone from both sides, then set `lastSync`. `main.ts` saves settings afterwards.

Each per-task step runs inside `guard()`, so one failing task is reported and doesn't abort the run.

### Change detection details

- Fingerprints are computed from normalised values: trimmed title, date-only due, notes with normalised line endings, and context without `@`. Cosmetic differences such as a TaskNotes datetime due versus a Google date-only due don't cause ping-pong.
- After a push, the record stores the local fingerprint. After a pull, it stores the remote one. Since both sides are then equal, the next run sees `none`.
- The local modification time is the later of the file `mtime` and the `dateModified` frontmatter. The remote time is Google's `updated`. These are only consulted when both sides changed.

### Scheduling and concurrency

- `main.ts` holds a single `syncing` flag. Overlapping triggers (timer, command, startup) are dropped, not queued.
- Startup sync waits for the metadata cache's `resolved` event, bounded at 10 seconds. An unindexed vault would otherwise look like "all notes deleted". The deletion guard is the second line of defence.
- The interval is a `window.setInterval`, registered with the plugin so Obsidian clears it on unload. It is restarted whenever its settings change.

## Authentication

`google/auth.ts` implements Google's [installed-app flow](https://developers.google.com/identity/protocols/oauth2/native-app):

1. Start a Node `http` server on `127.0.0.1` on a random port (desktop only).
2. Open the consent URL with PKCE (`S256`), `access_type=offline` and `prompt=consent`, so a refresh token is always issued.
3. Receive the code on the loopback redirect, check `state`, and exchange the code plus verifier for tokens.

Tokens live in `settings.tokens`. `getAccessToken()` refreshes them about 60 seconds before expiry and persists any rotated refresh token. All HTTP goes through Obsidian's `requestUrl`, which avoids CORS and works on mobile. That is why only the initial sign-in needs the desktop app.

Users bring their own OAuth client. A shared client ID would need Google's verification for the Tasks scope, and would share quota across every user.

## Known limitations

- Google subtasks are flattened. The `parent` relationship is neither preserved on import nor created on export.
- Recurrence, priority, projects, reminders and time tracking aren't synced. Google Tasks has no equivalents in its public API.
- Each run fetches every active list in full. That's simple and correct, and fine for the hundreds-of-tasks scale the API is designed for. An `updatedMin`-based incremental fetch would be the next optimisation.
- Google's due dates are date-only. A due time set in TaskNotes is kept locally as long as the date doesn't change, but it isn't sent to Google.

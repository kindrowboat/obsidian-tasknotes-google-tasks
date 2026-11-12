# TaskNotes Google Tasks Sync

An [Obsidian](https://obsidian.md) plugin that keeps [TaskNotes](https://github.com/callumalpass/tasknotes) tasks and [Google Tasks](https://tasks.google.com) in sync, in both directions.

- Each Google Tasks list maps to one TaskNotes **context** (and each context to one list).
- New tasks on either side show up on the other side.
- Titles, status, dates and note bodies sync both ways. Renaming a task on either side doesn't break the link.
- Google Tasks only knows "needs action" and "completed". Other TaskNotes statuses, such as `in-progress`, are stored in a small marker line at the end of the Google task's notes.
- Sync runs on demand, on startup, every 5 minutes by default, and a few seconds after you change a task note.

## Requirements

- Obsidian 1.5 or later.
- The TaskNotes plugin. It isn't strictly required, but this plugin reads TaskNotes' settings to find your tasks.
- A Google account, plus a Google Cloud OAuth client that you create yourself. It's free; see below.
- The **desktop** app for the one-time sign-in. After that, syncing also works on mobile if your plugin settings sync between devices.

## Installation

### From Community Plugins (once published)

1. Open **Settings → Community plugins → Browse**.
2. Search for **TaskNotes Google Tasks Sync**, then install and enable it.

### Manually

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest). You can also run `npm run package` and use `dist/tasknotes-google-tasks/`.
2. Copy them into `<your vault>/.obsidian/plugins/tasknotes-google-tasks/`.
3. Reload Obsidian, then enable the plugin under **Settings → Community plugins**.

### With BRAT

Add this repository's URL in [BRAT](https://github.com/TfTHacker/obsidian42-brat) to get pre-release builds.

## Setting up Google access

Google requires every app that reads your tasks to have its own OAuth client. You only do this once.

1. Go to <https://console.cloud.google.com/> and create a project, or pick an existing one.
2. Open **APIs & Services → Library**, search for **Google Tasks API** and click **Enable**.
3. Open **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - Fill in an app name and your email address.
   - Scopes: add `https://www.googleapis.com/auth/tasks`.
   - Test users: add your own Google account.
   - You can leave the app in **Testing** mode. In that mode Google expires refresh tokens after 7 days, so you'd sign in again weekly. To avoid that, click **Publish app**; a personal app with only you as a user doesn't need verification.
4. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Desktop app**.
   - Copy the **Client ID** and **Client secret**.
5. In Obsidian, go to **Settings → TaskNotes Google Tasks Sync**, paste both values, and click **Sign in**. A browser tab opens. Approve access, and you'll see "Signed in" there and in Obsidian.

The secret of a "Desktop app" client isn't truly confidential (Google says so itself). It's stored in the plugin's `data.json` in your vault. Your access and refresh tokens are stored there too, so treat that file like a password.

## Mapping lists to contexts

After you sign in (or after any sync), **Settings → Lists and contexts** shows every Google Tasks list on your account. For each list you want to sync:

1. Type the TaskNotes context it corresponds to, for example `work`. A leading `@` is ignored.
2. Turn on the toggle.

Rules:

- An enabled list must have a context, and a context can be used by only one list. Problems are shown in orange.
- Under **Contexts without a list**, you'll see every context used by your task notes that no list maps to. Click **Create list in Google** to create a list with the same name and map it in one step.
- A Google task can only be in one list. If a task note has several mapped contexts, the **first** one in its `contexts` list decides where the task goes, and the others stay on the note untouched. For example, `contexts: [home, school]` puts the task in the `home` list.
- Task notes with no mapped context are not synced.
- Lists that are turned off, or that have no context, are never touched.

## Syncing

- **Command palette → "Sync with Google Tasks"**, the ribbon icon, or **Sync now** in the settings.
- **Sync automatically** runs every *X* minutes (5 by default). You can change the interval in the settings.
- **Sync when tasks change** (on by default) syncs about 3 seconds after you create, edit, rename or delete a task note, so you don't have to wait for the interval. Edits made by the sync itself don't trigger another sync.
- **Sync when Obsidian starts** runs a sync once the vault has finished indexing.
- The status bar shows when the last sync happened.

### What syncs

| TaskNotes                       | Google Tasks                                        |
| ------------------------------- | --------------------------------------------------- |
| Title (file name or `title`)    | Title                                               |
| `status` in a completed status  | Completed                                           |
| `status` = default open status  | Needs action                                        |
| any other `status`              | Needs action + `[tasknotes: status=…]` in the notes |
| `due`, or `scheduled` if no due (date part; configurable) | Date                                    |
| Note body                       | Notes (up to 8192 characters)                       |
| First mapped context in `contexts` | Which list the task is in                        |

Priority, projects, tags, time tracking, recurrence and reminders stay in Obsidian and aren't sent to Google. Google subtasks are imported as ordinary tasks.

### Dates

Google's API gives each task a single date: the day it's scheduled for. Google calls the field `due`, but its documentation says it isn't a deadline. The separate deadline you can set in the Google Tasks app isn't available to plugins, so it can't be synced.

The **Google Tasks date** setting chooses which TaskNotes date maps to Google's date:

- **Due date, or scheduled date if there's no due date** (default). A note sends its `due` date, or its `scheduled` date if it has no due date. A date changed in Google goes back to the property it came from; new notes from Google get a `due` date. Clearing the date in Google clears both `due` and `scheduled`, so the other one doesn't take its place.
- **Due date only** or **Scheduled date only**. The other date stays in Obsidian.

Only the date is synced. A time of day set in TaskNotes stays in the note as long as the date doesn't change.

### How tasks stay linked

When a pair is linked, the note gets two frontmatter properties:

```yaml
googleTaskId: MTIzNDU2Nzg5
googleTaskListId: MDk4NzY1NDMy
```

Google's task ID never changes when you rename a task, and frontmatter moves with the file when you rename it in Obsidian. Renaming either side therefore just syncs the new title across. Don't copy these properties to another note. If two notes share an ID, the second one becomes a new task.

### Conflicts

For each linked pair, the plugin remembers what both sides looked like after the last sync:

- If only one side changed, that side's version is copied to the other side.
- If both sides changed, the most recently modified side wins.

### Moving tasks between lists

- Changing a note's first mapped context (for example `work` → `home`) moves the Google task to the `home` list. Reordering `contexts` so a different mapped context comes first counts as a move too.
- Moving the task to another synced list in Google Tasks swaps the old list's context on the note for the new list's context, in the same position. Other contexts, mapped or not, are kept. This works as long as Google keeps the task's ID. If a Google client re-creates the task instead (new ID), the old note is removed and the moved task is imported as a new note.
- Removing every mapped context from a note leaves the Google task where it is, and later changes from Google won't add a context back.
- Edits from Google that don't move the task between lists (title, status, date, notes) never change the note's contexts.

### Deletions

With **Propagate deletions** on (the default), deleting a synced task on one side deletes it on the other. Deleted notes go to Obsidian's trash, so you can recover them. With it off, the pair is just unlinked.

As a safety net, a sync refuses to delete more than half of your linked tasks at once (above 5). This protects you if the vault wasn't fully indexed, or if a list was emptied by accident.

### Other options

- **Google Tasks date**: which TaskNotes date maps to the task's date in Google (see below).
- **Sync note body**: turn this off to sync only the title, status and date. The marker line is still maintained.
- **Include completed tasks when linking**: by default, completed tasks that have never been synced are skipped in both directions, so your Google history doesn't flood the vault.
- **Use TaskNotes settings**: reads the tasks folder, task tag or property, property names and statuses from TaskNotes. Turn it off to set them yourself.
- **Reset sync state**: forgets the last-sync snapshot without unlinking anything. Use it if you hit the deletion safety net on purpose.

## Troubleshooting

- **"Not signed in" after a week**: your OAuth app is in Testing mode. Publish it (see step 3 above) and sign in again.
- **"Google did not return a refresh token"**: remove the app at <https://myaccount.google.com/permissions> and sign in again.
- **A task doesn't sync**: check that the note is a TaskNotes task (it has the task tag or property) and has a context mapped to an enabled list.
- Detailed logs go to the developer console (`Ctrl/Cmd+Shift+I`), prefixed with `[tasknotes-google-tasks]`. Debug-level messages may need "Verbose" enabled in the console.

## Development

```bash
npm install
npm run dev        # rebuild main.js on change
npm test           # unit tests
npm run build      # type-check and production build
npm run package    # build and write dist/tasknotes-google-tasks/ and a zip
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the code is organised, and [docs/PUBLISHING.md](docs/PUBLISHING.md) for releases.

## License

[Moby Dick General Public License](LICENSE).

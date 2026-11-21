import { Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import { refresh, revoke, signIn } from "./google/auth";
import { TasksApi } from "./google/tasksApi";
import { DEFAULT_SETTINGS, PluginSettings } from "./settings";
import { SettingsTab } from "./settingsTab";
import { SyncEngine, SyncSummary } from "./sync/engine";
import { resolveConfig } from "./tasknotes/config";
import { TaskNoteRepository } from "./tasknotes/repository";
import { errorMessage } from "./util";

const INDEX_WAIT_MS = 10_000;
/** Quiet period after the last local change before a change-triggered sync. */
const CHANGE_DEBOUNCE_MS = 3_000;
/** How long to ignore change events for files the sync itself just wrote. */
const OWN_WRITE_GRACE_MS = 5_000;
/** Device-local key (not in data.json, so it doesn't follow the vault to other devices). */
const SYNC_HERE_KEY = "tasknotes-google-tasks:sync-on-this-device";

export default class TaskNotesGoogleTasksPlugin extends Plugin {
	settings!: PluginSettings;
	api!: TasksApi;
	private syncing = false;
	private intervalId: number | null = null;
	private statusBar!: HTMLElement;
	private changeTimer: number | null = null;
	/** A change arrived during a sync; run again when it finishes. */
	private resyncPending = false;
	/** Path → time until which change events for it are our own writes. */
	private ownWrites = new Map<string, number>();
	private runningEngine: SyncEngine | null = null;
	/** Whether automatic syncs run on this device. Stored per device, not in plugin settings. */
	syncHere = true;

	async onload() {
		await this.loadSettings();
		this.syncHere = this.loadLocal(SYNC_HERE_KEY) !== false;
		this.api = new TasksApi(() => this.getAccessToken());

		this.statusBar = this.addStatusBarItem();
		this.updateStatusBar();

		this.addRibbonIcon("refresh-cw", "Sync with Google Tasks", () => void this.sync(true));
		this.addCommand({ id: "sync", name: "Sync with Google Tasks", callback: () => void this.sync(true) });
		this.addCommand({ id: "refresh-lists", name: "Refresh Google Tasks lists", callback: () => void this.refreshLists() });
		this.addCommand({ id: "sign-in", name: "Sign in to Google", callback: () => void this.signIn() });
		this.addCommand({ id: "toggle-sync-here", name: "Toggle automatic sync on this device", callback: () => void this.setSyncHere(!this.syncHere) });
		this.addCommand({ id: "toggle-status-bar", name: "Toggle status bar sync time", callback: () => void this.setStatusBarVisible(!this.settings.showStatusBar) });

		this.addSettingTab(new SettingsTab(this.app, this));

		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.onTaskChanged(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onTaskChanged(file, oldPath)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.onTaskChanged(file)));

		this.app.workspace.onLayoutReady(async () => {
			this.restartInterval();
			if (this.syncHere && this.settings.syncOnStartup && this.settings.tokens) {
				await this.waitForIndex();
				void this.sync(false);
			}
		});
	}

	onunload() {
		this.clearInterval();
		if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
	}

	/** Queue a sync after a task note is created, edited, renamed or deleted. */
	private onTaskChanged(file: TAbstractFile, oldPath?: string) {
		if (!this.syncHere || !this.settings.syncOnChange || !this.settings.tokens) return;
		if (!(file instanceof TFile) || file.extension !== "md") return;
		const now = Date.now();
		if ((this.ownWrites.get(file.path) ?? 0) > now || (oldPath && (this.ownWrites.get(oldPath) ?? 0) > now)) return;
		if (!this.isSyncedTask(file, oldPath)) return;
		if (this.syncing) {
			const touched = this.runningEngine?.touchedPaths;
			if (touched?.has(file.path) || (oldPath && touched?.has(oldPath))) return;
			this.resyncPending = true;
			return;
		}
		this.scheduleChangeSync();
	}

	/** A note we should react to: a task note now, or a note that was linked before (deleted or untagged). */
	private isSyncedTask(file: TFile, oldPath?: string): boolean {
		const known = Object.values(this.settings.records).some((r) => r.path === file.path || r.path === oldPath);
		if (known) return true;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const cfg = resolveConfig(this.app, this.settings);
		return new TaskNoteRepository(this.app, cfg, this.settings.idProperty, this.settings.listIdProperty).isTaskFrontmatter(fm);
	}

	private scheduleChangeSync() {
		if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
		this.changeTimer = window.setTimeout(() => {
			this.changeTimer = null;
			void this.sync(false);
		}, CHANGE_DEBOUNCE_MS);
	}

	async loadSettings() {
		const data = (await this.loadData()) ?? {};
		this.settings = { ...DEFAULT_SETTINGS, ...data, fallback: { ...DEFAULT_SETTINGS.fallback, ...(data.fallback ?? {}) } };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Restart the periodic sync timer from current settings. */
	restartInterval() {
		this.clearInterval();
		if (!this.syncHere || !this.settings.autoSync) return;
		const minutes = Math.max(1, Number(this.settings.syncIntervalMinutes) || DEFAULT_SETTINGS.syncIntervalMinutes);
		this.intervalId = window.setInterval(() => void this.sync(false), minutes * 60_000);
		this.registerInterval(this.intervalId);
	}

	private clearInterval() {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.intervalId = null;
	}

	/** Wait (bounded) for the metadata cache to finish indexing so no task note looks missing. */
	private waitForIndex(): Promise<void> {
		return new Promise((resolve) => {
			const timer = window.setTimeout(done, INDEX_WAIT_MS);
			const ref = this.app.metadataCache.on("resolved", done);
			const self = this;
			function done() {
				window.clearTimeout(timer);
				self.app.metadataCache.offref(ref);
				resolve();
			}
		});
	}

	async getAccessToken(): Promise<string> {
		const t = this.settings.tokens;
		if (!t) throw new Error("Not signed in to Google.");
		if (Date.now() < t.expiresAt) return t.accessToken;
		this.settings.tokens = await refresh(this.client(), t);
		await this.saveSettings();
		return this.settings.tokens.accessToken;
	}

	private client() {
		return { clientId: this.settings.clientId.trim(), clientSecret: this.settings.clientSecret.trim() };
	}

	async signIn() {
		try {
			new Notice("Opening Google sign-in in your browser…");
			this.settings.tokens = await signIn(this.client());
			await this.saveSettings();
			new Notice("Signed in to Google Tasks.");
			await this.refreshLists();
		} catch (e) {
			new Notice(`Google sign-in failed: ${errorMessage(e)}`, 10_000);
		}
	}

	async signOut() {
		if (this.settings.tokens) await revoke(this.settings.tokens).catch(() => {});
		this.settings.tokens = null;
		await this.saveSettings();
	}

	async refreshLists() {
		try {
			await new SyncEngine(this.app, this.api, this.settings).refreshLists();
			await this.saveSettings();
			new Notice(`Found ${this.settings.listMappings.filter((m) => m.present).length} Google Tasks lists.`);
		} catch (e) {
			new Notice(`Could not load Google Tasks lists: ${errorMessage(e)}`, 10_000);
		}
	}

	/** Turn automatic syncing on or off for this device only. */
	setSyncHere(on: boolean) {
		this.syncHere = on;
		this.saveLocal(SYNC_HERE_KEY, on);
		this.restartInterval();
		if (!on && this.changeTimer !== null) {
			window.clearTimeout(this.changeTimer);
			this.changeTimer = null;
		}
		this.updateStatusBar();
		new Notice(on ? "Google Tasks: automatic sync is on for this device." : "Google Tasks: automatic sync is paused on this device. Manual syncs still work.");
	}

	/** Vault-scoped localStorage; falls back to window.localStorage before Obsidian 1.8.7. */
	private loadLocal(key: string): unknown {
		const app = this.app as unknown as { loadLocalStorage?: (k: string) => unknown };
		if (app.loadLocalStorage) return app.loadLocalStorage(key);
		const raw = window.localStorage.getItem(`${this.app.vault.getName()}:${key}`);
		try {
			return raw === null ? null : JSON.parse(raw);
		} catch {
			return null;
		}
	}

	private saveLocal(key: string, value: unknown) {
		const app = this.app as unknown as { saveLocalStorage?: (k: string, v: unknown) => void };
		if (app.saveLocalStorage) return app.saveLocalStorage(key, value);
		window.localStorage.setItem(`${this.app.vault.getName()}:${key}`, JSON.stringify(value));
	}

	/** `interactive` syncs (command, ribbon, button) run even when automatic sync is paused on this device. */
	async sync(interactive: boolean): Promise<SyncSummary | null> {
		if (!interactive && !this.syncHere) return null;
		if (this.syncing) {
			if (interactive) new Notice("A Google Tasks sync is already running.");
			return null;
		}
		if (!this.settings.tokens) {
			if (interactive) new Notice("Sign in to Google in the TaskNotes Google Tasks settings first.");
			return null;
		}
		this.syncing = true;
		this.resyncPending = false;
		this.updateStatusBar("syncing…");
		const engine = new SyncEngine(this.app, this.api, this.settings, (m) => console.debug(`[tasknotes-google-tasks] ${m}`));
		this.runningEngine = engine;
		try {
			const s = await engine.run();
			await this.saveSettings();
			const changed = s.pushed + s.pulled + s.createdLocal + s.createdRemote + s.deletedLocal + s.deletedRemote;
			if (s.errors.length) {
				new Notice(`Google Tasks sync finished with ${s.errors.length} error(s). See the developer console.`, 10_000);
				console.warn("[tasknotes-google-tasks] sync errors", s.errors);
			} else if (interactive || changed) {
				new Notice(describe(s));
			}
			return s;
		} catch (e) {
			console.error("[tasknotes-google-tasks]", e);
			new Notice(`Google Tasks sync failed: ${errorMessage(e)}`, 10_000);
			return null;
		} finally {
			this.syncing = false;
			this.runningEngine = null;
			const until = Date.now() + OWN_WRITE_GRACE_MS;
			for (const [path, t] of this.ownWrites) if (t <= Date.now()) this.ownWrites.delete(path);
			for (const path of engine.touchedPaths) this.ownWrites.set(path, until);
			this.updateStatusBar();
			if (this.resyncPending) {
				this.resyncPending = false;
				this.scheduleChangeSync();
			}
		}
	}

	async setStatusBarVisible(visible: boolean) {
		this.settings.showStatusBar = visible;
		await this.saveSettings();
		this.updateStatusBar();
	}

	private updateStatusBar(text?: string) {
		this.statusBar.toggle(this.settings.showStatusBar);
		const last = this.settings.lastSync ? new Date(this.settings.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "never";
		this.statusBar.setText(`Google Tasks: ${text ?? (this.syncHere ? last : `paused here (last ${last})`)}`);
	}
}

function describe(s: SyncSummary): string {
	const parts: string[] = [];
	if (s.createdLocal) parts.push(`${s.createdLocal} imported`);
	if (s.createdRemote) parts.push(`${s.createdRemote} exported`);
	if (s.pulled) parts.push(`${s.pulled} updated from Google`);
	if (s.pushed) parts.push(`${s.pushed} updated in Google`);
	if (s.deletedLocal) parts.push(`${s.deletedLocal} removed locally`);
	if (s.deletedRemote) parts.push(`${s.deletedRemote} removed from Google`);
	return `Google Tasks sync: ${parts.length ? parts.join(", ") : "everything up to date"}.`;
}

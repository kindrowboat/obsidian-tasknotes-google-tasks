import { Notice, Plugin } from "obsidian";
import { refresh, revoke, signIn } from "./google/auth";
import { TasksApi } from "./google/tasksApi";
import { DEFAULT_SETTINGS, PluginSettings } from "./settings";
import { SettingsTab } from "./settingsTab";
import { SyncEngine, SyncSummary } from "./sync/engine";
import { errorMessage } from "./util";

const INDEX_WAIT_MS = 10_000;

export default class TaskNotesGoogleTasksPlugin extends Plugin {
	settings!: PluginSettings;
	api!: TasksApi;
	private syncing = false;
	private intervalId: number | null = null;
	private statusBar!: HTMLElement;

	async onload() {
		await this.loadSettings();
		this.api = new TasksApi(() => this.getAccessToken());

		this.statusBar = this.addStatusBarItem();
		this.updateStatusBar();

		this.addRibbonIcon("refresh-cw", "Sync with Google Tasks", () => void this.sync(true));
		this.addCommand({ id: "sync", name: "Sync with Google Tasks", callback: () => void this.sync(true) });
		this.addCommand({ id: "refresh-lists", name: "Refresh Google Tasks lists", callback: () => void this.refreshLists() });
		this.addCommand({ id: "sign-in", name: "Sign in to Google", callback: () => void this.signIn() });

		this.addSettingTab(new SettingsTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => {
			this.restartInterval();
			if (this.settings.syncOnStartup && this.settings.tokens) {
				await this.waitForIndex();
				void this.sync(false);
			}
		});
	}

	onunload() {
		this.clearInterval();
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
		if (!this.settings.autoSync) return;
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

	async sync(interactive: boolean): Promise<SyncSummary | null> {
		if (this.syncing) {
			if (interactive) new Notice("A Google Tasks sync is already running.");
			return null;
		}
		if (!this.settings.tokens) {
			if (interactive) new Notice("Sign in to Google in the TaskNotes Google Tasks settings first.");
			return null;
		}
		this.syncing = true;
		this.updateStatusBar("syncing…");
		try {
			const engine = new SyncEngine(this.app, this.api, this.settings, (m) => console.debug(`[tasknotes-google-tasks] ${m}`));
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
			this.updateStatusBar();
		}
	}

	private updateStatusBar(text?: string) {
		const last = this.settings.lastSync ? new Date(this.settings.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "never";
		this.statusBar.setText(`Google Tasks: ${text ?? last}`);
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

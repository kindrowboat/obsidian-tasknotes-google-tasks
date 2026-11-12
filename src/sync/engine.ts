import type { App } from "obsidian";
import type { GoogleTask, TasksApi, TaskWrite } from "../google/tasksApi";
import type { PluginSettings } from "../settings";
import { activeMappings, mergeLists } from "./lists";
export { activeMappings, mergeLists };
import { resolveConfig, TaskNotesConfig } from "../tasknotes/config";
import { LocalTask, TaskNoteRepository } from "../tasknotes/repository";
import {
	dateTargets,
	decodeGoogleNotes,
	dueFromGoogle,
	dueToGoogle,
	effectiveDate,
	encodeGoogleNotes,
	fingerprint,
	isCompleted,
	pickMappedContext,
	resolve,
	statusFromGoogle,
	SyncFields,
} from "./model";

export interface SyncSummary {
	pushed: number;
	pulled: number;
	createdLocal: number;
	createdRemote: number;
	deletedLocal: number;
	deletedRemote: number;
	errors: string[];
}

/** Refuse to delete more than this share of linked tasks in one run (guards against an unindexed vault). */
const MAX_DELETE_FRACTION = 0.5;
const MAX_DELETE_FLOOR = 5;

interface RemoteEntry {
	task: GoogleTask;
	listId: string;
	context: string;
}

export class SyncEngine {
	private cfg!: TaskNotesConfig;
	private repo!: TaskNoteRepository;
	private summary!: SyncSummary;
	/** Google IDs linked during this run; absent from the remote snapshot, so cleanup must skip them. */
	private linkedThisRun = new Set<string>();

	constructor(
		private app: App,
		private api: TasksApi,
		private settings: PluginSettings,
		private log: (msg: string) => void = () => {},
	) {}

	/** Vault paths the last run wrote to. */
	get touchedPaths(): ReadonlySet<string> {
		return this.repo?.touched ?? new Set();
	}

	/** Fetch lists from Google and store them in settings (does not save). */
	async refreshLists(): Promise<void> {
		const lists = await this.api.listTaskLists();
		this.settings.listMappings = mergeLists(this.settings.listMappings, lists);
	}

	async run(): Promise<SyncSummary> {
		this.linkedThisRun = new Set();
		this.summary = { pushed: 0, pulled: 0, createdLocal: 0, createdRemote: 0, deletedLocal: 0, deletedRemote: 0, errors: [] };
		this.cfg = resolveConfig(this.app, this.settings);
		this.repo = new TaskNoteRepository(this.app, this.cfg, this.settings.idProperty, this.settings.listIdProperty);

		await this.refreshLists();
		const active = activeMappings(this.settings.listMappings);
		if (active.length === 0) {
			this.log("No lists are mapped to contexts; nothing to sync.");
			return this.summary;
		}
		const contextToList = new Map(active.map((m) => [m.context.trim().replace(/^@/, ""), m.listId]));
		const listToContext = new Map(active.map((m) => [m.listId, m.context.trim().replace(/^@/, "")]));
		const mappedContexts = new Set(contextToList.keys());

		// Remote snapshot
		const remote = new Map<string, RemoteEntry>();
		for (const m of active) {
			for (const t of await this.api.listTasks(m.listId)) {
				remote.set(t.id, { task: t, listId: m.listId, context: listToContext.get(m.listId)! });
			}
		}

		// Local snapshot, de-duplicating copied notes that carry the same Google ID.
		const locals = await this.repo.listTasks(this.settings.syncBody);
		const localById = new Map<string, LocalTask>();
		const unlinked: LocalTask[] = [];
		for (const t of locals) {
			if (t.googleTaskId && !localById.has(t.googleTaskId)) localById.set(t.googleTaskId, t);
			else {
				if (t.googleTaskId) {
					this.log(`${t.file.path} duplicates Google task ${t.googleTaskId}; treating it as a new task.`);
					t.googleTaskId = null;
				}
				unlinked.push(t);
			}
		}

		const records = this.settings.records;
		const ignored = new Set(this.settings.ignoredRemoteIds);
		const activeListIds = new Set(listToContext.keys());

		// Plan deletions first so the safety guard can veto them all at once.
		const localDeletes: LocalTask[] = [];
		const remoteDeletes: RemoteEntry[] = [];

		// 1. Linked local notes
		for (const [id, local] of localById) {
			const listId = local.listId ?? records[id]?.listId ?? null;
			if (listId && !activeListIds.has(listId)) continue; // list no longer synced; leave alone
			const r = remote.get(id);
			if (!r || r.task.deleted) {
				if (r?.task.deleted || records[id]) {
					localDeletes.push(local);
				} else {
					// Stale ID (unknown to us and not in Google): relink as a new task.
					local.googleTaskId = null;
					unlinked.push(local);
				}
				continue;
			}
			await this.guard(local.file.path, () => this.reconcile(local, r, contextToList, mappedContexts));
		}

		// 2. Unlinked local notes with a mapped context → create in Google
		for (const local of unlinked) {
			const ctx = pickMappedContext(local.contexts, mappedContexts);
			if (!ctx) continue;
			if (!this.settings.includeCompletedOnLink && isCompleted(local.status, this.cfg)) continue;
			await this.guard(local.file.path, () => this.createRemote(local, ctx, contextToList.get(ctx)!));
		}

		// 3. Remote tasks without a local note
		for (const [id, r] of remote) {
			if (localById.has(id) || r.task.deleted) continue;
			if (ignored.has(id)) continue;
			if (records[id]) {
				remoteDeletes.push(r);
				continue;
			}
			if (r.task.status === "completed" && !this.settings.includeCompletedOnLink) continue;
			if (!r.task.title?.trim()) continue; // Google keeps empty placeholder tasks around
			await this.guard(r.task.title, () => this.createLocal(r, mappedContexts));
		}

		await this.applyDeletes(localDeletes, remoteDeletes);

		// Forget records for tasks gone from both sides.
		for (const id of Object.keys(records)) {
			const rec = records[id];
			if (!activeListIds.has(rec.listId) || this.linkedThisRun.has(id)) continue;
			const r = remote.get(id);
			if ((!r || r.task.deleted) && !localById.has(id)) delete records[id];
		}

		this.settings.lastSync = Date.now();
		return this.summary;
	}

	private async guard(label: string, fn: () => Promise<void>) {
		try {
			await fn();
		} catch (e) {
			const msg = `${label}: ${e instanceof Error ? e.message : String(e)}`;
			this.summary.errors.push(msg);
			this.log(msg);
		}
	}

	private localFields(local: LocalTask, context: string): SyncFields {
		return {
			title: local.title,
			status: local.status,
			date: effectiveDate(local.due, local.scheduled, this.settings.dateMapping),
			notes: this.settings.syncBody ? local.notes : "",
			context,
		};
	}

	private remoteFields(r: RemoteEntry): SyncFields {
		const { notes, status } = decodeGoogleNotes(r.task.notes);
		return {
			title: r.task.title ?? "",
			status: statusFromGoogle(r.task.status, status, this.cfg),
			date: dueFromGoogle(r.task.due),
			notes: this.settings.syncBody ? notes : "",
			context: r.context,
		};
	}

	private toGoogle(f: SyncFields): TaskWrite {
		const done = isCompleted(f.status, this.cfg);
		const w: TaskWrite = {
			title: f.title,
			status: done ? "completed" : "needsAction",
			due: dueToGoogle(f.date),
			completed: done ? undefined : null,
			notes: encodeGoogleNotes(f, this.cfg),
		};
		return w;
	}

	private async reconcile(
		local: LocalTask,
		r: RemoteEntry,
		contextToList: Map<string, string>,
		mappedContexts: Set<string>,
	) {
		const id = r.task.id;
		// A note with no mapped context stays in its current list.
		const localCtx = pickMappedContext(local.contexts, mappedContexts) ?? r.context;
		const lf = this.localFields(local, localCtx);
		const rf = this.remoteFields(r);
		const rec = this.settings.records[id];
		const decision = resolve(lf, rf, rec?.fingerprint, local.modified, Date.parse(r.task.updated) || 0);

		if (decision.kind === "push") {
			let listId = r.listId;
			let taskId = id;
			const write = this.toGoogle(lf);
			if (!this.settings.syncBody) write.notes = this.mergeMarkerOnly(r, lf);
			if (lf.context !== r.context) {
				const target = contextToList.get(lf.context)!;
				const moved = await this.api.moveTask(r.listId, id, target, write);
				listId = target;
				taskId = moved.id;
			}
			await this.api.patchTask(listId, taskId, write);
			if (taskId !== id) {
				delete this.settings.records[id];
				this.linkedThisRun.add(taskId);
			}
			await this.repo.link(local.file, taskId, listId);
			this.settings.records[taskId] = { googleTaskId: taskId, listId, path: local.file.path, fingerprint: fingerprint(lf) };
			this.summary.pushed++;
			this.log(`→ ${lf.title}`);
		} else if (decision.kind === "pull") {
			const dateTarget = dateTargets(this.settings.dateMapping, !!local.due, !!local.scheduled, rf.date);
			const file = await this.repo.update(local, { ...rf, googleTaskId: id, listId: r.listId, completedAt: r.task.completed, dateTarget }, mappedContexts, this.settings.syncBody);
			this.settings.records[id] = { googleTaskId: id, listId: r.listId, path: file.path, fingerprint: fingerprint(rf) };
			this.summary.pulled++;
			this.log(`← ${rf.title}`);
		} else {
			if (local.listId !== r.listId) await this.repo.link(local.file, id, r.listId);
			this.settings.records[id] = { googleTaskId: id, listId: r.listId, path: local.file.path, fingerprint: fingerprint(lf) };
		}
	}

	/** When the body isn't synced, keep Google's free text and only rewrite the status marker. */
	private mergeMarkerOnly(r: RemoteEntry, lf: SyncFields): string {
		const { notes } = decodeGoogleNotes(r.task.notes);
		return encodeGoogleNotes({ ...lf, notes }, this.cfg);
	}

	private async createRemote(local: LocalTask, ctx: string, listId: string) {
		const lf = this.localFields(local, ctx);
		const created = await this.api.insertTask(listId, this.toGoogle(lf));
		await this.repo.link(local.file, created.id, listId);
		this.settings.records[created.id] = { googleTaskId: created.id, listId, path: local.file.path, fingerprint: fingerprint(lf) };
		this.linkedThisRun.add(created.id);
		this.summary.createdRemote++;
		this.log(`+→ ${lf.title}`);
	}

	private async createLocal(r: RemoteEntry, mappedContexts: Set<string>) {
		const rf = this.remoteFields(r);
		const dateTarget = dateTargets(this.settings.dateMapping, false, false, rf.date);
		const file = await this.repo.create({ ...rf, googleTaskId: r.task.id, listId: r.listId, completedAt: r.task.completed, dateTarget }, mappedContexts, this.settings.syncBody);
		this.settings.records[r.task.id] = { googleTaskId: r.task.id, listId: r.listId, path: file.path, fingerprint: fingerprint(rf) };
		this.summary.createdLocal++;
		this.log(`+← ${rf.title}`);
	}

	private async applyDeletes(localDeletes: LocalTask[], remoteDeletes: RemoteEntry[]) {
		const total = localDeletes.length + remoteDeletes.length;
		if (total === 0) return;
		const linked = Object.keys(this.settings.records).length;
		if (total > MAX_DELETE_FLOOR && total > linked * MAX_DELETE_FRACTION) {
			const msg = `Refusing to delete ${total} of ${linked} linked tasks in one sync. If this is intended, use "Reset sync state" and sync again.`;
			this.summary.errors.push(msg);
			this.log(msg);
			return;
		}
		for (const local of localDeletes) {
			const id = local.googleTaskId!;
			await this.guard(local.file.path, async () => {
				if (this.settings.propagateDeletions) {
					await this.repo.trash(local.file);
					this.summary.deletedLocal++;
					this.log(`✕← ${local.title}`);
				} else {
					await this.repo.unlink(local.file);
				}
				delete this.settings.records[id];
			});
		}
		for (const r of remoteDeletes) {
			await this.guard(r.task.title ?? r.task.id, async () => {
				if (this.settings.propagateDeletions) {
					await this.api.deleteTask(r.listId, r.task.id);
					this.summary.deletedRemote++;
					this.log(`✕→ ${r.task.title}`);
				} else {
					this.settings.ignoredRemoteIds.push(r.task.id);
				}
				delete this.settings.records[r.task.id];
			});
		}
	}
}

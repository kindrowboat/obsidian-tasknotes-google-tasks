import { App, normalizePath, TFile, TFolder } from "obsidian";
import type { TaskNotesConfig } from "./config";
import { DateProperty, normaliseContext, normaliseDue, sanitiseFilename, SyncFields } from "../sync/model";

/** A task note as seen by the sync engine. */
export interface LocalTask {
	file: TFile;
	title: string;
	status: string;
	due: string | null;
	scheduled: string | null;
	notes: string;
	/** All contexts on the note, normalised (no "@"). */
	contexts: string[];
	googleTaskId: string | null;
	listId: string | null;
	/** Epoch ms of the last local modification. */
	modified: number;
}

/**
 * Fields to write to a note. `context` replaces whichever mapped context the
 * note had; `dateTarget` says which date property receives `date`.
 */
export interface LocalWrite extends SyncFields {
	googleTaskId: string;
	listId: string;
	completedAt?: string | null;
	dateTarget: { set: DateProperty | null; clear: DateProperty[] };
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

function asStringArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((x) => typeof x === "string" || typeof x === "number").map(String);
	if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim()).filter(Boolean);
	return [];
}

function splitBody(content: string): { frontmatter: string; body: string } {
	const m = FRONTMATTER_RE.exec(content);
	if (!m) return { frontmatter: "", body: content };
	return { frontmatter: m[0], body: content.slice(m[0].length) };
}

/**
 * Reads and writes TaskNotes task files. Only touches the frontmatter keys it
 * syncs plus its own ID keys; everything else in the note is preserved.
 */
export class TaskNoteRepository {
	/** Paths this repository wrote to, so callers can ignore the resulting change events. */
	readonly touched = new Set<string>();

	constructor(
		private app: App,
		private cfg: TaskNotesConfig,
		private idProperty: string,
		private listIdProperty: string,
	) {}

	isTaskFrontmatter(fm: Record<string, unknown> | undefined): boolean {
		if (!fm) return false;
		const id = this.cfg.identification;
		if (id.kind === "property") {
			const v = fm[id.name];
			if (Array.isArray(v)) return v.map(String).includes(id.value);
			return String(v) === id.value;
		}
		return asStringArray(fm.tags).some((t) => t.replace(/^#/, "") === id.tag);
	}

	async listTasks(readBody: boolean): Promise<LocalTask[]> {
		const out: LocalTask[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!this.isTaskFrontmatter(fm)) continue;
			out.push(await this.read(file, fm as Record<string, unknown>, readBody));
		}
		return out;
	}

	private async read(file: TFile, fm: Record<string, unknown>, readBody: boolean): Promise<LocalTask> {
		const f = this.cfg.fields;
		const title = this.cfg.storeTitleInFilename || typeof fm[f.title] !== "string" || !fm[f.title]
			? file.basename
			: String(fm[f.title]);
		const notes = readBody ? splitBody(await this.app.vault.cachedRead(file)).body.trim() : "";
		const modifiedFm = typeof fm[f.dateModified] === "string" ? Date.parse(fm[f.dateModified] as string) : NaN;
		return {
			file,
			title,
			status: typeof fm[f.status] === "string" || typeof fm[f.status] === "boolean"
				? String(fm[f.status])
				: this.cfg.defaultOpenStatus,
			due: normaliseDue(fm[f.due]),
			scheduled: normaliseDue(fm[f.scheduled]),
			notes,
			contexts: asStringArray(fm[f.contexts]).map(normaliseContext),
			googleTaskId: typeof fm[this.idProperty] === "string" ? (fm[this.idProperty] as string) : null,
			listId: typeof fm[this.listIdProperty] === "string" ? (fm[this.listIdProperty] as string) : null,
			modified: Math.max(file.stat.mtime, Number.isNaN(modifiedFm) ? 0 : modifiedFm),
		};
	}

	async create(w: LocalWrite, mappedContexts: Set<string>, writeBody: boolean): Promise<TFile> {
		await this.ensureFolder(this.cfg.tasksFolder);
		const path = this.availablePath(this.cfg.tasksFolder, sanitiseFilename(w.title));
		this.touched.add(path);
		const file = await this.app.vault.create(path, writeBody && w.notes ? w.notes.trim() + "\n" : "");
		const now = new Date().toISOString();
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			const f = this.cfg.fields;
			if (!this.cfg.storeTitleInFilename) fm[f.title] = w.title;
			fm[f.priority] = this.cfg.defaultPriority;
			fm[f.dateCreated] = now;
			if (this.cfg.identification.kind === "tag") {
				fm.tags = [this.cfg.identification.tag];
			} else {
				fm[this.cfg.identification.name] = coerce(this.cfg.identification.value);
			}
			this.applyFields(fm, w, mappedContexts, now);
		});
		return file;
	}

	async update(task: LocalTask, w: LocalWrite, mappedContexts: Set<string>, writeBody: boolean): Promise<TFile> {
		let file = task.file;
		this.touched.add(file.path);
		if (writeBody && w.notes.trim() !== task.notes.trim()) {
			await this.app.vault.process(file, (content) => {
				const { frontmatter } = splitBody(content);
				return frontmatter + (w.notes.trim() ? w.notes.trim() + "\n" : "");
			});
		}
		const now = new Date().toISOString();
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			if (!this.cfg.storeTitleInFilename || this.cfg.fields.title in fm) fm[this.cfg.fields.title] = w.title;
			this.applyFields(fm, w, mappedContexts, now);
		});
		if (this.cfg.storeTitleInFilename && w.title !== task.title) {
			const folder = file.parent?.path ?? "";
			const target = this.availablePath(folder, sanitiseFilename(w.title), file.path);
			if (target !== file.path) {
				this.touched.add(target);
				await this.app.fileManager.renameFile(file, target);
				file = this.app.vault.getAbstractFileByPath(target) as TFile;
			}
		}
		return file;
	}

	/** Write only the link keys (after creating the remote task). */
	async link(file: TFile, googleTaskId: string, listId: string): Promise<void> {
		this.touched.add(file.path);
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm[this.idProperty] = googleTaskId;
			fm[this.listIdProperty] = listId;
		});
	}

	async unlink(file: TFile): Promise<void> {
		this.touched.add(file.path);
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			delete fm[this.idProperty];
			delete fm[this.listIdProperty];
		});
	}

	async trash(file: TFile): Promise<void> {
		this.touched.add(file.path);
		await this.app.fileManager.trashFile(file);
	}

	private applyFields(fm: Record<string, unknown>, w: LocalWrite, mappedContexts: Set<string>, now: string) {
		const f = this.cfg.fields;
		fm[f.status] = w.status;
		for (const p of w.dateTarget.clear) delete fm[f[p]];
		// Keep a local time if the date itself is unchanged (Google only stores dates).
		const target = w.dateTarget.set;
		if (target && w.date && normaliseDue(fm[f[target]]) !== w.date) fm[f[target]] = w.date;

		if (this.cfg.completedStatuses.includes(w.status)) {
			if (!fm[f.completedDate]) fm[f.completedDate] = (w.completedAt ?? now).slice(0, 10);
		} else {
			delete fm[f.completedDate];
		}

		// Replace any mapped context with the new one; keep unmapped contexts as they are.
		const existing = asStringArray(fm[f.contexts]);
		const kept = existing.filter((c) => !mappedContexts.has(normaliseContext(c)));
		fm[f.contexts] = [w.context, ...kept];

		fm[f.dateModified] = now;
		fm[this.idProperty] = w.googleTaskId;
		fm[this.listIdProperty] = w.listId;
	}

	private async ensureFolder(path: string) {
		const p = normalizePath(path);
		if (!p || p === "/") return;
		const existing = this.app.vault.getAbstractFileByPath(p);
		if (existing instanceof TFolder) return;
		await this.app.vault.createFolder(p);
	}

	private availablePath(folder: string, name: string, current?: string): string {
		const prefix = folder && folder !== "/" ? `${folder}/` : "";
		for (let i = 1; ; i++) {
			const candidate = normalizePath(`${prefix}${name}${i === 1 ? "" : ` ${i}`}.md`);
			if (candidate === current) return candidate;
			if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
		}
	}
}

function coerce(v: string): unknown {
	if (v === "true") return true;
	if (v === "false") return false;
	return v;
}

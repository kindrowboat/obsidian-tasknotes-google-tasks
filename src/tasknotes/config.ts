import type { App } from "obsidian";
import type { PluginSettings } from "../settings";
import type { StatusConfig } from "../sync/model";

/** The TaskNotes conventions the sync needs, resolved from TaskNotes or our fallback settings. */
export interface TaskNotesConfig extends StatusConfig {
	tasksFolder: string;
	identification: { kind: "tag"; tag: string } | { kind: "property"; name: string; value: string };
	fields: {
		title: string;
		status: string;
		due: string;
		scheduled: string;
		contexts: string;
		completedDate: string;
		dateModified: string;
		dateCreated: string;
		priority: string;
	};
	defaultPriority: string;
	storeTitleInFilename: boolean;
	/** Where this config came from, shown in settings. */
	source: "tasknotes" | "fallback";
}

/** Shape of the parts of TaskNotes' settings we read. All optional: TaskNotes versions differ. */
interface TaskNotesSettingsLike {
	tasksFolder?: string;
	taskTag?: string;
	taskIdentificationMethod?: "tag" | "property";
	taskPropertyName?: string;
	taskPropertyValue?: string;
	defaultTaskStatus?: string;
	defaultTaskPriority?: string;
	storeTitleInFilename?: boolean;
	fieldMapping?: Partial<Record<string, string>>;
	customStatuses?: { value: string; isCompleted?: boolean }[];
}

export function getTaskNotesSettings(app: App): TaskNotesSettingsLike | null {
	// `app.plugins` is not part of the public typings.
	const plugins = (app as unknown as { plugins?: { plugins?: Record<string, { settings?: unknown }> } }).plugins;
	const settings = plugins?.plugins?.["tasknotes"]?.settings;
	return settings && typeof settings === "object" ? (settings as TaskNotesSettingsLike) : null;
}

export function resolveConfig(app: App, s: PluginSettings): TaskNotesConfig {
	const f = s.fallback;
	const fallbackCompleted = f.completedStatuses.split(",").map((x) => x.trim()).filter(Boolean);
	const base: TaskNotesConfig = {
		tasksFolder: f.tasksFolder,
		identification: { kind: "tag", tag: f.taskTag.replace(/^#/, "") },
		fields: {
			title: f.titleField,
			status: f.statusField,
			due: f.dueField,
			scheduled: f.scheduledField,
			contexts: f.contextsField,
			completedDate: f.completedDateField,
			dateModified: f.dateModifiedField,
			dateCreated: f.dateCreatedField,
			priority: f.priorityField,
		},
		defaultOpenStatus: f.defaultStatus,
		doneStatus: f.doneStatus,
		completedStatuses: fallbackCompleted.length ? fallbackCompleted : [f.doneStatus],
		defaultPriority: f.defaultPriority,
		storeTitleInFilename: f.storeTitleInFilename,
		source: "fallback",
	};
	if (!s.useTaskNotesSettings) return base;
	const tn = getTaskNotesSettings(app);
	if (!tn) return base;

	const fm = tn.fieldMapping ?? {};
	const pick = (key: string, dflt: string) => (typeof fm[key] === "string" && fm[key] ? (fm[key] as string) : dflt);
	const completed = (tn.customStatuses ?? []).filter((x) => x.isCompleted).map((x) => x.value);
	const identification: TaskNotesConfig["identification"] =
		tn.taskIdentificationMethod === "property" && tn.taskPropertyName
			? { kind: "property", name: tn.taskPropertyName, value: tn.taskPropertyValue ?? "" }
			: { kind: "tag", tag: (tn.taskTag ?? f.taskTag).replace(/^#/, "") };

	return {
		tasksFolder: tn.tasksFolder ?? base.tasksFolder,
		identification,
		fields: {
			title: pick("title", base.fields.title),
			status: pick("status", base.fields.status),
			due: pick("due", base.fields.due),
			scheduled: pick("scheduled", base.fields.scheduled),
			contexts: pick("contexts", base.fields.contexts),
			completedDate: pick("completedDate", base.fields.completedDate),
			dateModified: pick("dateModified", base.fields.dateModified),
			dateCreated: pick("dateCreated", base.fields.dateCreated),
			priority: pick("priority", base.fields.priority),
		},
		defaultOpenStatus: tn.defaultTaskStatus ?? base.defaultOpenStatus,
		// TaskNotes has no single "done" status; use the first completed one.
		doneStatus: completed[0] ?? base.doneStatus,
		completedStatuses: completed.length ? completed : base.completedStatuses,
		defaultPriority: tn.defaultTaskPriority ?? base.defaultPriority,
		storeTitleInFilename: tn.storeTitleInFilename ?? base.storeTitleInFilename,
		source: "tasknotes",
	};
}

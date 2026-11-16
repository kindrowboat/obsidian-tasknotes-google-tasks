import type { TokenSet } from "./google/auth";
import type { DateMapping, SyncRecord } from "./sync/model";

/** One Google Tasks list as known to the plugin, and the context it maps to. */
export interface ListMapping {
	listId: string;
	listTitle: string;
	/** TaskNotes context (without "@"). Required for the list to sync. */
	context: string;
	enabled: boolean;
	/** False if the list was not returned by Google on the last refresh. */
	present: boolean;
}

/** Overrides for TaskNotes settings; used when TaskNotes' own settings can't be read. */
export interface TaskNotesFallback {
	tasksFolder: string;
	taskTag: string;
	titleField: string;
	statusField: string;
	dueField: string;
	scheduledField: string;
	contextsField: string;
	completedDateField: string;
	dateModifiedField: string;
	dateCreatedField: string;
	priorityField: string;
	defaultStatus: string;
	doneStatus: string;
	completedStatuses: string;
	defaultPriority: string;
	storeTitleInFilename: boolean;
	/** File name for new notes when the title isn't the file name, e.g. "_{{title}}". */
	filenameTemplate: string;
}

export interface PluginSettings {
	clientId: string;
	clientSecret: string;
	tokens: TokenSet | null;

	autoSync: boolean;
	syncIntervalMinutes: number;
	syncOnStartup: boolean;
	/** Sync shortly after a task note is created, edited, renamed or deleted. */
	syncOnChange: boolean;
	/** Show the last sync time in the status bar. */
	showStatusBar: boolean;

	listMappings: ListMapping[];

	/** Read folder, tag, field names and statuses from the installed TaskNotes plugin. */
	useTaskNotesSettings: boolean;
	fallback: TaskNotesFallback;

	/** Frontmatter keys this plugin owns. */
	idProperty: string;
	listIdProperty: string;

	/** Which TaskNotes date maps to Google's date. */
	dateMapping: DateMapping;
	syncBody: boolean;
	propagateDeletions: boolean;
	/** Link already-completed tasks that have never been synced (both directions). */
	includeCompletedOnLink: boolean;

	/** Keyed by Google task ID. */
	records: Record<string, SyncRecord>;
	/** Google task IDs the user unlinked; never re-imported. */
	ignoredRemoteIds: string[];
	lastSync: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	clientId: "",
	clientSecret: "",
	tokens: null,

	autoSync: true,
	syncIntervalMinutes: 5,
	syncOnStartup: true,
	syncOnChange: true,
	showStatusBar: true,

	listMappings: [],

	useTaskNotesSettings: true,
	fallback: {
		tasksFolder: "TaskNotes/Tasks",
		taskTag: "task",
		titleField: "title",
		statusField: "status",
		dueField: "due",
		scheduledField: "scheduled",
		contextsField: "contexts",
		completedDateField: "completedDate",
		dateModifiedField: "dateModified",
		dateCreatedField: "dateCreated",
		priorityField: "priority",
		defaultStatus: "open",
		doneStatus: "done",
		completedStatuses: "done",
		defaultPriority: "normal",
		storeTitleInFilename: true,
		filenameTemplate: "{{title}}",
	},

	idProperty: "googleTaskId",
	listIdProperty: "googleTaskListId",

	dateMapping: "due-or-scheduled",
	syncBody: true,
	propagateDeletions: true,
	includeCompletedOnLink: false,

	records: {},
	ignoredRemoteIds: [],
	lastSync: 0,
};

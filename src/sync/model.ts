/**
 * Pure sync model: no Obsidian or network imports, so it can be unit tested.
 *
 * Both sides are normalised into a `SyncFields` shape. Change detection is done
 * by comparing fingerprints of those fields against the fingerprint recorded at
 * the last successful sync.
 */

/** Fields that are kept in sync between a task note and a Google task. */
export interface SyncFields {
	title: string;
	/** TaskNotes status value, e.g. "open", "in-progress", "done". */
	status: string;
	/** The date Google stores (its "scheduled" date), as YYYY-MM-DD, or null. */
	date: string | null;
	/** Free-text description (note body / Google task notes), without the metadata line. */
	notes: string;
	/** The context this task belongs to (determines the Google list). */
	context: string;
}

/** What we remember about a linked pair after a successful sync. */
export interface SyncRecord {
	googleTaskId: string;
	listId: string;
	/** Vault path at last sync; informational only (identity lives in frontmatter). */
	path: string;
	/** Fingerprint of the fields as they were after the last sync. */
	fingerprint: string;
}

export type Side = "local" | "remote";

export type Resolution =
	| { kind: "none" }
	| { kind: "push" }
	| { kind: "pull" };

/** Prefix of the metadata line appended to Google task notes. */
export const META_PREFIX = "[tasknotes:";

/** Google Tasks limits notes to 8192 characters. */
export const GOOGLE_NOTES_LIMIT = 8192;

export function fingerprint(f: SyncFields): string {
	// Stable, order-fixed serialisation. Not cryptographic; it only needs to change when a field changes.
	const s = JSON.stringify([f.title.trim(), f.status, f.date ?? "", normaliseNotes(f.notes), f.context]);
	let h1 = 0xdeadbeef ^ s.length;
	let h2 = 0x41c6ce57 ^ s.length;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 2654435761);
		h2 = Math.imul(h2 ^ c, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

export function normaliseNotes(notes: string): string {
	return notes.replace(/\r\n/g, "\n").trim();
}

/**
 * Decide which way a linked pair should flow.
 *
 * - neither side changed since last sync → nothing
 * - only one side changed → copy that side over the other
 * - both changed → the side with the newer modification time wins
 */
export function resolve(
	local: SyncFields,
	remote: SyncFields,
	lastFingerprint: string | undefined,
	localModified: number,
	remoteModified: number,
): Resolution {
	const lf = fingerprint(local);
	const rf = fingerprint(remote);
	if (lf === rf) return { kind: "none" };
	const localChanged = lf !== lastFingerprint;
	const remoteChanged = rf !== lastFingerprint;
	if (localChanged && !remoteChanged) return { kind: "push" };
	if (remoteChanged && !localChanged) return { kind: "pull" };
	return localModified >= remoteModified ? { kind: "push" } : { kind: "pull" };
}

// ---- Status <-> Google -----------------------------------------------------

export interface StatusConfig {
	/** Status used for incomplete tasks coming from Google with no marker. */
	defaultOpenStatus: string;
	/** Status written when a Google task is completed. */
	doneStatus: string;
	/** All TaskNotes statuses that count as completed. */
	completedStatuses: string[];
}

export function isCompleted(status: string, cfg: StatusConfig): boolean {
	return cfg.completedStatuses.includes(status);
}

/**
 * Build the Google notes field: the free-text notes, then (for non-default
 * statuses that Google can't represent) a metadata line on its own.
 *
 *   Buy oat milk
 *
 *   [tasknotes: status=in-progress]
 */
export function encodeGoogleNotes(fields: SyncFields, cfg: StatusConfig): string {
	const notes = normaliseNotes(fields.notes);
	const needsMarker = !isCompleted(fields.status, cfg) && fields.status !== cfg.defaultOpenStatus;
	const meta = needsMarker ? `${META_PREFIX} status=${fields.status}]` : "";
	const room = GOOGLE_NOTES_LIMIT - (meta ? meta.length + 2 : 0);
	const body = notes.length > room ? notes.slice(0, Math.max(0, room - 1)) + "…" : notes;
	if (!meta) return body;
	return body ? `${body}\n\n${meta}` : meta;
}

/** Split Google notes into free text and the status recorded in the metadata line (if any). */
export function decodeGoogleNotes(raw: string | undefined): { notes: string; status: string | null } {
	const text = (raw ?? "").replace(/\r\n/g, "\n");
	const lines = text.split("\n");
	let status: string | null = null;
	const kept: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith(META_PREFIX) && trimmed.endsWith("]")) {
			const m = /status=([^\s\]]+)/.exec(trimmed);
			if (m) status = m[1];
			continue;
		}
		kept.push(line);
	}
	return { notes: kept.join("\n").trim(), status };
}

/** TaskNotes status for a Google task. */
export function statusFromGoogle(
	googleStatus: "needsAction" | "completed",
	markerStatus: string | null,
	cfg: StatusConfig,
): string {
	if (googleStatus === "completed") {
		// Keep a specific completed status if the marker names one; otherwise the default.
		return markerStatus && isCompleted(markerStatus, cfg) ? markerStatus : cfg.doneStatus;
	}
	if (markerStatus && !isCompleted(markerStatus, cfg)) return markerStatus;
	return cfg.defaultOpenStatus;
}

// ---- Dates -----------------------------------------------------------------

/**
 * Which TaskNotes date Google's single date maps to. Google's API only exposes
 * one date (shown as the task's date in Google Tasks; not its deadline).
 *
 * - "due-or-scheduled": the note's due date if it has one, otherwise its scheduled date
 * - "due" / "scheduled": always that property
 */
export type DateMapping = "due-or-scheduled" | "due" | "scheduled";
export type DateProperty = "due" | "scheduled";

/** The date a note sends to Google. */
export function effectiveDate(due: string | null, scheduled: string | null, mode: DateMapping): string | null {
	if (mode === "due") return due;
	if (mode === "scheduled") return scheduled;
	return due ?? scheduled;
}

/**
 * Which note properties to write when a date comes in from Google.
 * In fallback mode the date goes back to whichever property it came from
 * (due for new notes), and clearing it clears both so neither resurfaces.
 */
export function dateTargets(
	mode: DateMapping,
	hasDue: boolean,
	hasScheduled: boolean,
	date: string | null,
): { set: DateProperty | null; clear: DateProperty[] } {
	if (mode !== "due-or-scheduled") return date ? { set: mode, clear: [] } : { set: null, clear: [mode] };
	if (!date) return { set: null, clear: ["due", "scheduled"] };
	return { set: hasDue || !hasScheduled ? "due" : "scheduled", clear: [] };
}

/** Google stores due as RFC 3339 at midnight UTC; only the date part is meaningful. */
export function dueFromGoogle(due: string | undefined): string | null {
	if (!due) return null;
	const m = /^(\d{4}-\d{2}-\d{2})/.exec(due);
	return m ? m[1] : null;
}

export function dueToGoogle(due: string | null): string | null {
	if (!due) return null;
	const m = /^(\d{4}-\d{2}-\d{2})/.exec(due);
	return m ? `${m[1]}T00:00:00.000Z` : null;
}

/** Normalise any TaskNotes due value (date or datetime) to YYYY-MM-DD. */
export function normaliseDue(value: unknown): string | null {
	if (typeof value !== "string" && !(value instanceof Date)) return null;
	const s = value instanceof Date ? value.toISOString() : value;
	const m = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim());
	return m ? m[1] : null;
}

// ---- Contexts --------------------------------------------------------------

export function normaliseContext(c: string): string {
	return c.trim().replace(/^@/, "");
}

/** First of a task's contexts that is mapped to a list, or null. */
export function pickMappedContext(contexts: string[], mapped: Set<string>): string | null {
	for (const c of contexts) {
		const n = normaliseContext(c);
		if (mapped.has(n)) return n;
	}
	return null;
}

// ---- Filenames -------------------------------------------------------------

export function sanitiseFilename(title: string): string {
	const cleaned = title
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
	return cleaned || "Untitled task";
}

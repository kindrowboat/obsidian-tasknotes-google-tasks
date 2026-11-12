import { test } from "node:test";
import assert from "node:assert/strict";
import {
	dateTargets,
	decodeGoogleNotes,
	dueFromGoogle,
	dueToGoogle,
	effectiveDate,
	encodeGoogleNotes,
	fingerprint,
	moveContext,
	normaliseDue,
	pickMappedContext,
	resolve,
	sanitiseFilename,
	statusFromGoogle,
	StatusConfig,
	SyncFields,
	GOOGLE_NOTES_LIMIT,
} from "../src/sync/model";
import { activeMappings, mergeLists } from "../src/sync/lists";

const cfg: StatusConfig = { defaultOpenStatus: "open", doneStatus: "done", completedStatuses: ["done", "cancelled"] };
const base: SyncFields = { title: "Buy milk", status: "open", date: "2026-11-20", notes: "Oat", context: "home" };

test("fingerprint changes with any synced field", () => {
	const f = fingerprint(base);
	assert.equal(f, fingerprint({ ...base }));
	for (const k of ["title", "status", "date", "notes", "context"] as const) {
		assert.notEqual(fingerprint({ ...base, [k]: "x" }), f, k);
	}
	assert.equal(fingerprint({ ...base, notes: "Oat\r\n" }), f, "line endings and trailing whitespace ignored");
});

test("resolve picks the side that changed", () => {
	const last = fingerprint(base);
	const changed = { ...base, title: "Buy oat milk" };
	assert.deepEqual(resolve(base, base, last, 0, 0), { kind: "none" });
	assert.deepEqual(resolve(changed, base, last, 0, 0), { kind: "push" });
	assert.deepEqual(resolve(base, changed, last, 0, 0), { kind: "pull" });
});

test("resolve uses modification time when both changed", () => {
	const last = fingerprint(base);
	const a = { ...base, title: "A" };
	const b = { ...base, title: "B" };
	assert.deepEqual(resolve(a, b, last, 200, 100), { kind: "push" });
	assert.deepEqual(resolve(a, b, last, 100, 200), { kind: "pull" });
	assert.deepEqual(resolve(a, b, undefined, 100, 200), { kind: "pull" }, "no record counts as both changed");
});

test("in-progress status round-trips through Google notes", () => {
	const encoded = encodeGoogleNotes({ ...base, status: "in-progress" }, cfg);
	assert.equal(encoded, "Oat\n\n[tasknotes: status=in-progress]");
	const decoded = decodeGoogleNotes(encoded);
	assert.deepEqual(decoded, { notes: "Oat", status: "in-progress" });
	assert.equal(statusFromGoogle("needsAction", decoded.status, cfg), "in-progress");
});

test("default and completed statuses need no marker", () => {
	assert.equal(encodeGoogleNotes(base, cfg), "Oat");
	assert.equal(encodeGoogleNotes({ ...base, status: "done" }, cfg), "Oat");
	assert.equal(encodeGoogleNotes({ ...base, notes: "", status: "waiting" }, cfg), "[tasknotes: status=waiting]");
});

test("Google status mapping", () => {
	assert.equal(statusFromGoogle("completed", null, cfg), "done");
	assert.equal(statusFromGoogle("completed", "cancelled", cfg), "cancelled");
	assert.equal(statusFromGoogle("completed", "in-progress", cfg), "done", "completing in Google overrides an open marker");
	assert.equal(statusFromGoogle("needsAction", null, cfg), "open");
	assert.equal(statusFromGoogle("needsAction", "done", cfg), "open", "reopening in Google overrides a done marker");
});

test("notes are truncated to Google's limit", () => {
	const long = "x".repeat(GOOGLE_NOTES_LIMIT + 100);
	const encoded = encodeGoogleNotes({ ...base, notes: long, status: "in-progress" }, cfg);
	assert.ok(encoded.length <= GOOGLE_NOTES_LIMIT);
	assert.equal(decodeGoogleNotes(encoded).status, "in-progress");
});

test("due dates", () => {
	assert.equal(dueFromGoogle("2026-11-20T00:00:00.000Z"), "2026-11-20");
	assert.equal(dueFromGoogle(undefined), null);
	assert.equal(dueToGoogle("2026-11-20"), "2026-11-20T00:00:00.000Z");
	assert.equal(dueToGoogle(null), null);
	assert.equal(normaliseDue("2026-11-20T17:00:00"), "2026-11-20");
	assert.equal(normaliseDue(42), null);
});

test("contexts", () => {
	const mapped = new Set(["home", "work"]);
	assert.equal(pickMappedContext(["errands", "@work", "home"], mapped), "work");
	assert.equal(pickMappedContext(["errands"], mapped), null);
});

test("filenames", () => {
	assert.equal(sanitiseFilename("a/b: c?"), "a b c");
	assert.equal(sanitiseFilename("  "), "Untitled task");
});

test("mergeLists keeps mappings and flags missing lists", () => {
	const merged = mergeLists(
		[{ listId: "1", listTitle: "Old", context: "home", enabled: true, present: true },
			{ listId: "2", listTitle: "Gone", context: "work", enabled: true, present: true }],
		[{ id: "1", title: "Home", updated: "" }, { id: "3", title: "New", updated: "" }],
	);
	assert.deepEqual(merged, [
		{ listId: "1", listTitle: "Home", context: "home", enabled: true, present: true },
		{ listId: "3", listTitle: "New", context: "", enabled: false, present: true },
		{ listId: "2", listTitle: "Gone", context: "work", enabled: true, present: false },
	]);
	assert.equal(activeMappings(merged).length, 1);
});

test("activeMappings rejects a context used twice", () => {
	assert.throws(() => activeMappings([
		{ listId: "1", listTitle: "A", context: "home", enabled: true, present: true },
		{ listId: "2", listTitle: "B", context: "@home", enabled: true, present: true },
	]), /mapped to both/);
});

test("effective date per mapping", () => {
	assert.equal(effectiveDate("2026-11-20", "2026-11-13", "due-or-scheduled"), "2026-11-20");
	assert.equal(effectiveDate(null, "2026-11-13", "due-or-scheduled"), "2026-11-13");
	assert.equal(effectiveDate(null, null, "due-or-scheduled"), null);
	assert.equal(effectiveDate("2026-11-20", "2026-11-13", "scheduled"), "2026-11-13");
	assert.equal(effectiveDate(null, "2026-11-13", "due"), null);
});

test("incoming date goes back to the property it came from", () => {
	const d = "2026-11-21";
	assert.deepEqual(dateTargets("due-or-scheduled", true, true, d), { set: "due", clear: [] });
	assert.deepEqual(dateTargets("due-or-scheduled", false, true, d), { set: "scheduled", clear: [] });
	assert.deepEqual(dateTargets("due-or-scheduled", false, false, d), { set: "due", clear: [] }, "new notes get a due date");
	assert.deepEqual(dateTargets("due-or-scheduled", true, true, null), { set: null, clear: ["due", "scheduled"] });
	assert.deepEqual(dateTargets("scheduled", true, false, d), { set: "scheduled", clear: [] });
	assert.deepEqual(dateTargets("due", true, true, null), { set: null, clear: ["due"] });
});

test("contexts are left alone when the list doesn't change", () => {
	const existing = ["@home", "school", "errands"];
	assert.equal(moveContext(existing, "home", "home"), existing, "same object: nothing rewritten");
	assert.equal(moveContext(existing, null, "work"), existing, "no mapped context: membership untouched");
});

test("a list move swaps only the old list's context, in place", () => {
	assert.deepEqual(moveContext(["errands", "home", "school"], "home", "work"), ["errands", "work", "school"]);
	assert.deepEqual(moveContext(["home", "school"], "home", "school"), ["school"], "new context already present");
	assert.deepEqual(moveContext(["@home"], "home", "work"), ["work"]);
});

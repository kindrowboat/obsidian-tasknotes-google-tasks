import type { GoogleTaskList } from "../google/tasksApi";
import type { ListMapping } from "../settings";

/**
 * Merge the Google Tasks lists returned by the API into the stored mappings.
 * New lists are added disabled with no context; missing lists are flagged.
 */
export function mergeLists(existing: ListMapping[], lists: GoogleTaskList[]): ListMapping[] {
	const byId = new Map(existing.map((m) => [m.listId, m]));
	const seen = new Set<string>();
	const out: ListMapping[] = [];
	for (const l of lists) {
		seen.add(l.id);
		const prev = byId.get(l.id);
		out.push(prev
			? { ...prev, listTitle: l.title, present: true }
			: { listId: l.id, listTitle: l.title, context: "", enabled: false, present: true });
	}
	for (const m of existing) if (!seen.has(m.listId)) out.push({ ...m, present: false });
	return out;
}

/** Active mappings: enabled, present, with a context. Throws if two lists share a context. */
export function activeMappings(mappings: ListMapping[]): ListMapping[] {
	const active = mappings.filter((m) => m.enabled && m.present && m.context.trim());
	const seen = new Map<string, string>();
	for (const m of active) {
		const ctx = m.context.trim().replace(/^@/, "");
		const other = seen.get(ctx);
		if (other) throw new Error(`Context "${ctx}" is mapped to both "${other}" and "${m.listTitle}". Each context must map to one list.`);
		seen.set(ctx, m.listTitle);
	}
	return active;
}

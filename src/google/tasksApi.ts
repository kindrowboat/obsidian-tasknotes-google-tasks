import { requestUrl, RequestUrlParam } from "obsidian";

/** Minimal Google Tasks REST v1 client. See https://developers.google.com/workspace/tasks/reference/rest */

const BASE = "https://tasks.googleapis.com/tasks/v1";

export interface GoogleTaskList {
	id: string;
	title: string;
	updated: string;
}

export interface GoogleTask {
	id: string;
	title?: string;
	notes?: string;
	status: "needsAction" | "completed";
	/** RFC 3339, date part only is meaningful. */
	due?: string;
	completed?: string;
	updated: string;
	parent?: string;
	deleted?: boolean;
	hidden?: boolean;
	etag?: string;
}

export type TaskWrite = Partial<Pick<GoogleTask, "title" | "notes" | "status">> & {
	due?: string | null;
	completed?: string | null;
};

export class GoogleApiError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

export class TasksApi {
	constructor(private getAccessToken: () => Promise<string>) {}

	private async call<T>(method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<T> {
		const qs = query ? "?" + new URLSearchParams(query).toString() : "";
		const req: RequestUrlParam = {
			url: `${BASE}${path}${qs}`,
			method,
			headers: { Authorization: `Bearer ${await this.getAccessToken()}` },
			throw: false,
		};
		if (body !== undefined) {
			req.contentType = "application/json";
			req.body = JSON.stringify(body);
		}
		const res = await requestUrl(req);
		if (res.status >= 400) {
			let msg = res.text;
			try {
				msg = (res.json as { error?: { message?: string } })?.error?.message ?? msg;
			} catch {
				/* not JSON */
			}
			throw new GoogleApiError(res.status, `Google Tasks ${method} ${path} failed (${res.status}): ${msg}`);
		}
		if (res.status === 204 || !res.text) return undefined as T;
		return res.json as T;
	}

	async listTaskLists(): Promise<GoogleTaskList[]> {
		const out: GoogleTaskList[] = [];
		let pageToken: string | undefined;
		do {
			const q: Record<string, string> = { maxResults: "100" };
			if (pageToken) q.pageToken = pageToken;
			const page = await this.call<{ items?: GoogleTaskList[]; nextPageToken?: string }>("GET", "/users/@me/lists", q);
			out.push(...(page.items ?? []));
			pageToken = page.nextPageToken;
		} while (pageToken);
		return out;
	}

	async createTaskList(title: string): Promise<GoogleTaskList> {
		return this.call("POST", "/users/@me/lists", undefined, { title });
	}

	/** All tasks in a list, including completed, hidden (cleared) and deleted ones. */
	async listTasks(listId: string): Promise<GoogleTask[]> {
		const out: GoogleTask[] = [];
		let pageToken: string | undefined;
		do {
			const q: Record<string, string> = {
				maxResults: "100",
				showCompleted: "true",
				showHidden: "true",
				showDeleted: "true",
			};
			if (pageToken) q.pageToken = pageToken;
			const page = await this.call<{ items?: GoogleTask[]; nextPageToken?: string }>(
				"GET", `/lists/${encodeURIComponent(listId)}/tasks`, q);
			out.push(...(page.items ?? []));
			pageToken = page.nextPageToken;
		} while (pageToken);
		return out;
	}

	async insertTask(listId: string, task: TaskWrite): Promise<GoogleTask> {
		return this.call("POST", `/lists/${encodeURIComponent(listId)}/tasks`, undefined, task);
	}

	async patchTask(listId: string, taskId: string, task: TaskWrite): Promise<GoogleTask> {
		return this.call("PATCH", `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, undefined, task);
	}

	async deleteTask(listId: string, taskId: string): Promise<void> {
		await this.call("DELETE", `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`);
	}

	/**
	 * Move a task to another list. The task keeps its ID. Falls back to
	 * insert + delete (new ID) if the server rejects cross-list moves.
	 */
	async moveTask(fromListId: string, taskId: string, toListId: string, current: TaskWrite): Promise<GoogleTask> {
		try {
			return await this.call<GoogleTask>(
				"POST",
				`/lists/${encodeURIComponent(fromListId)}/tasks/${encodeURIComponent(taskId)}/move`,
				{ destinationTasklist: toListId },
			);
		} catch (e) {
			if (!(e instanceof GoogleApiError) || e.status >= 500) throw e;
			const created = await this.insertTask(toListId, current);
			await this.deleteTask(fromListId, taskId);
			return created;
		}
	}
}

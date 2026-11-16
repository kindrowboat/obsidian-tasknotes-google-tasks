import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TaskNotesGoogleTasksPlugin from "./main";
import { errorMessage } from "./util";
import { DEFAULT_SETTINGS, TaskNotesFallback } from "./settings";
import { getTaskNotesSettings, resolveConfig } from "./tasknotes/config";
import { TaskNoteRepository } from "./tasknotes/repository";

export class SettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: TaskNotesGoogleTasksPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.accountSection(containerEl);
		this.syncSection(containerEl);
		this.listsSection(containerEl);
		this.behaviourSection(containerEl);
		this.taskNotesSection(containerEl);
		this.advancedSection(containerEl);
	}

	private get s() {
		return this.plugin.settings;
	}

	private save = async () => {
		await this.plugin.saveSettings();
	};

	private accountSection(el: HTMLElement) {
		new Setting(el).setName("Google account").setHeading();
		el.createEl("p", {
			cls: "setting-item-description",
			text: "Create an OAuth client of type “Desktop app” in Google Cloud Console with the Google Tasks API enabled, then paste its ID and secret here. See the README for step-by-step instructions.",
		});
		new Setting(el).setName("OAuth client ID").addText((t) =>
			t.setPlaceholder("…apps.googleusercontent.com").setValue(this.s.clientId).onChange(async (v) => {
				this.s.clientId = v.trim();
				await this.save();
			}));
		new Setting(el).setName("OAuth client secret").addText((t) => {
			t.inputEl.type = "password";
			t.setValue(this.s.clientSecret).onChange(async (v) => {
				this.s.clientSecret = v.trim();
				await this.save();
			});
		});
		const signedIn = !!this.s.tokens;
		new Setting(el)
			.setName(signedIn ? "Signed in" : "Not signed in")
			.setDesc(signedIn ? "This vault can access your Google Tasks." : "Sign in to allow syncing. Requires the desktop app.")
			.addButton((b) =>
				signedIn
					? b.setButtonText("Sign out").onClick(async () => {
						await this.plugin.signOut();
						this.display();
					})
					: b.setButtonText("Sign in").setCta().onClick(async () => {
						await this.plugin.signIn();
						this.display();
					}));
	}

	private syncSection(el: HTMLElement) {
		new Setting(el).setName("Sync").setHeading();
		new Setting(el).setName("Sync automatically").addToggle((t) =>
			t.setValue(this.s.autoSync).onChange(async (v) => {
				this.s.autoSync = v;
				await this.save();
				this.plugin.restartInterval();
			}));
		new Setting(el)
			.setName("Sync interval (minutes)")
			.setDesc(`Default ${DEFAULT_SETTINGS.syncIntervalMinutes}.`)
			.addText((t) => {
				t.inputEl.type = "number";
				t.inputEl.min = "1";
				t.setValue(String(this.s.syncIntervalMinutes)).onChange(async (v) => {
					const n = Number(v);
					if (!Number.isFinite(n) || n < 1) return;
					this.s.syncIntervalMinutes = n;
					await this.save();
					this.plugin.restartInterval();
				});
			});
		new Setting(el)
			.setName("Sync when tasks change")
			.setDesc("Sync a few seconds after a task note is created, edited, renamed or deleted, instead of waiting for the next interval.")
			.addToggle((t) =>
				t.setValue(this.s.syncOnChange).onChange(async (v) => {
					this.s.syncOnChange = v;
					await this.save();
				}));
		new Setting(el).setName("Sync when Obsidian starts").addToggle((t) =>
			t.setValue(this.s.syncOnStartup).onChange(async (v) => {
				this.s.syncOnStartup = v;
				await this.save();
			}));
		new Setting(el)
			.setName("Show last sync time in status bar")
			.setDesc("Also available as the \"Toggle status bar sync time\" command.")
			.addToggle((t) =>
				t.setValue(this.s.showStatusBar).onChange(async (v) => {
					await this.plugin.setStatusBarVisible(v);
				}));
		new Setting(el)
			.setName("Sync now")
			.setDesc(this.s.lastSync ? `Last sync: ${new Date(this.s.lastSync).toLocaleString()}` : "Never synced.")
			.addButton((b) => b.setButtonText("Sync").onClick(async () => {
				await this.plugin.sync(true);
				this.display();
			}));
	}

	private listsSection(el: HTMLElement) {
		new Setting(el).setName("Lists and contexts").setHeading();
		el.createEl("p", {
			cls: "setting-item-description",
			text: "Each synced Google Tasks list needs exactly one TaskNotes context, and each context maps to one list. Tasks are synced only if they have a mapped context. A Google task can only be in one list, so if a note has several mapped contexts, the first one decides the list; the others stay on the note. The list of available lists is filled in when you sign in or sync.",
		});
		new Setting(el).setName("Refresh lists from Google").addButton((b) =>
			b.setButtonText("Refresh").setDisabled(!this.s.tokens).onClick(async () => {
				await this.plugin.refreshLists();
				this.display();
			}));

		if (this.s.listMappings.length === 0) {
			el.createEl("p", { cls: "tngt-empty", text: "No lists yet. Sign in, then refresh or sync." });
		}

		const counts = new Map<string, number>();
		for (const m of this.s.listMappings) {
			const c = m.context.trim().replace(/^@/, "");
			if (m.enabled && c) counts.set(c, (counts.get(c) ?? 0) + 1);
		}

		for (const m of this.s.listMappings) {
			const ctx = m.context.trim().replace(/^@/, "");
			const problems: string[] = [];
			if (!m.present) problems.push("List no longer exists in Google Tasks.");
			if (m.enabled && !ctx) problems.push("Needs a context to sync.");
			if (m.enabled && ctx && (counts.get(ctx) ?? 0) > 1) problems.push(`Context “${ctx}” is used by another list.`);
			const setting = new Setting(el)
				.setName(m.listTitle)
				.setDesc(problems.join(" ") || (m.enabled ? `Syncs with context “${ctx}”.` : "Not synced."))
				.addText((t) =>
					t.setPlaceholder("context").setValue(m.context).onChange(async (v) => {
						m.context = v.trim().replace(/^@/, "");
						await this.save();
					}))
				.addToggle((t) =>
					t.setTooltip("Sync this list").setValue(m.enabled).onChange(async (v) => {
						m.enabled = v;
						await this.save();
						this.display();
					}));
			if (problems.length) setting.descEl.addClass("tngt-warning");
			if (!m.present) {
				setting.addExtraButton((b) => b.setIcon("trash").setTooltip("Forget this list").onClick(async () => {
					this.s.listMappings = this.s.listMappings.filter((x) => x !== m);
					await this.save();
					this.display();
				}));
			}
		}

		this.unmappedContexts(el);
	}

	/** Contexts used in the vault that no list maps to, with a button to create a matching list. */
	private unmappedContexts(el: HTMLElement) {
		const cfg = resolveConfig(this.app, this.s);
		const repo = new TaskNoteRepository(this.app, cfg, this.s.idProperty, this.s.listIdProperty);
		const mapped = new Set(this.s.listMappings.filter((m) => m.enabled).map((m) => m.context.trim()));
		const used = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!repo.isTaskFrontmatter(fm)) continue;
			const raw = fm?.[cfg.fields.contexts];
			const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
			for (const c of list) {
				const n = String(c).trim().replace(/^@/, "");
				if (n && !mapped.has(n)) used.add(n);
			}
		}
		if (used.size === 0) return;
		new Setting(el)
			.setName("Contexts without a list")
			.setDesc("Tasks with only these contexts are not synced. Create a Google Tasks list for a context, or map it to an existing list above.");
		for (const ctx of [...used].sort()) {
			new Setting(el).setName(ctx).setClass("tngt-indent").addButton((b) =>
				b.setButtonText("Create list in Google").setDisabled(!this.s.tokens).onClick(async () => {
					try {
						const list = await this.plugin.api.createTaskList(ctx);
						this.s.listMappings.push({ listId: list.id, listTitle: list.title, context: ctx, enabled: true, present: true });
						await this.save();
						new Notice(`Created Google Tasks list “${ctx}”.`);
						this.display();
					} catch (e) {
						new Notice(`Could not create list: ${errorMessage(e)}`, 10_000);
					}
				}));
		}
	}

	private behaviourSection(el: HTMLElement) {
		new Setting(el).setName("Behaviour").setHeading();
		new Setting(el)
			.setName("Google Tasks date")
			.setDesc("Google's API exposes one date per task: the date it's scheduled for. The deadline shown in Google Tasks isn't available to plugins. Choose which TaskNotes date it maps to.")
			.addDropdown((d) => d
				.addOption("due-or-scheduled", "Due date, or scheduled date if there's no due date")
				.addOption("due", "Due date only")
				.addOption("scheduled", "Scheduled date only")
				.setValue(this.s.dateMapping)
				.onChange(async (v) => {
					this.s.dateMapping = v as typeof this.s.dateMapping;
					await this.save();
				}));
		new Setting(el)
			.setName("Sync note body")
			.setDesc("Sync the note body with the Google task's notes (Google limits notes to 8192 characters).")
			.addToggle((t) => t.setValue(this.s.syncBody).onChange(async (v) => {
				this.s.syncBody = v;
				await this.save();
			}));
		new Setting(el)
			.setName("Propagate deletions")
			.setDesc("Deleting a synced task on one side deletes it on the other (notes go to Obsidian's trash). When off, the pair is simply unlinked.")
			.addToggle((t) => t.setValue(this.s.propagateDeletions).onChange(async (v) => {
				this.s.propagateDeletions = v;
				await this.save();
			}));
		new Setting(el)
			.setName("Include completed tasks when linking")
			.setDesc("Also import completed Google tasks, and export completed task notes, that have never been synced.")
			.addToggle((t) => t.setValue(this.s.includeCompletedOnLink).onChange(async (v) => {
				this.s.includeCompletedOnLink = v;
				await this.save();
			}));
	}

	private taskNotesSection(el: HTMLElement) {
		new Setting(el).setName("TaskNotes").setHeading();
		const detected = !!getTaskNotesSettings(this.app);
		new Setting(el)
			.setName("Use TaskNotes settings")
			.setDesc(detected
				? "Read the tasks folder, task tag, property names and statuses from the TaskNotes plugin."
				: "TaskNotes is not loaded; the values below are used.")
			.addToggle((t) => t.setValue(this.s.useTaskNotesSettings).onChange(async (v) => {
				this.s.useTaskNotesSettings = v;
				await this.save();
				this.display();
			}));

		const cfg = resolveConfig(this.app, this.s);
		if (cfg.source === "tasknotes") {
			const idText = cfg.identification.kind === "tag" ? `tag #${cfg.identification.tag}` : `property ${cfg.identification.name}: ${cfg.identification.value}`;
			el.createEl("p", {
				cls: "setting-item-description",
				text: `In use: folder “${cfg.tasksFolder}”, tasks identified by ${idText}, open status “${cfg.defaultOpenStatus}”, completed statuses ${cfg.completedStatuses.map((s) => `“${s}”`).join(", ")}.`,
			});
			return;
		}

		const field = (key: keyof TaskNotesFallback, name: string, desc?: string) => {
			const st = new Setting(el).setName(name);
			if (desc) st.setDesc(desc);
			const value = this.s.fallback[key];
			if (typeof value === "boolean") {
				st.addToggle((t) => t.setValue(value).onChange(async (v) => {
					(this.s.fallback[key] as boolean) = v;
					await this.save();
				}));
			} else {
				st.addText((t) => t.setValue(value).onChange(async (v) => {
					(this.s.fallback[key] as string) = v.trim();
					await this.save();
				}));
			}
		};
		field("tasksFolder", "Tasks folder", "New task notes from Google are created here.");
		field("taskTag", "Task tag");
		field("storeTitleInFilename", "Title is the file name");
		field("filenameTemplate", "File name template", "Used for new notes when the title isn't the file name. {{title}}, {{date}}, {{year}}, {{month}}, {{day}} and other TaskNotes variables work.");
		field("titleField", "Title property");
		field("statusField", "Status property");
		field("dueField", "Due property");
		field("scheduledField", "Scheduled property");
		field("contextsField", "Contexts property");
		field("priorityField", "Priority property");
		field("completedDateField", "Completed date property");
		field("dateCreatedField", "Date created property");
		field("dateModifiedField", "Date modified property");
		field("defaultStatus", "Default open status");
		field("doneStatus", "Done status");
		field("completedStatuses", "Completed statuses", "Comma-separated.");
		field("defaultPriority", "Default priority");
	}

	private advancedSection(el: HTMLElement) {
		new Setting(el).setName("Advanced").setHeading();
		new Setting(el)
			.setName("Google task ID property")
			.setDesc("Frontmatter key that links a note to its Google task. Changing it unlinks existing notes.")
			.addText((t) => t.setValue(this.s.idProperty).onChange(async (v) => {
				if (!v.trim()) return;
				this.s.idProperty = v.trim();
				await this.save();
			}));
		new Setting(el)
			.setName("Google list ID property")
			.addText((t) => t.setValue(this.s.listIdProperty).onChange(async (v) => {
				if (!v.trim()) return;
				this.s.listIdProperty = v.trim();
				await this.save();
			}));
		new Setting(el)
			.setName("Reset sync state")
			.setDesc("Forget what was last synced. Links in note frontmatter are kept; the next sync treats every pair as changed on both sides and the newer side wins. No deletions happen on the next sync.")
			.addButton((b) => b.setButtonText("Reset").setWarning().onClick(async () => {
				this.s.records = {};
				this.s.ignoredRemoteIds = [];
				this.s.lastSync = 0;
				await this.save();
				new Notice("Sync state reset.");
				this.display();
			}));
	}
}

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import type { SettingEntry, SettingsSchemaResult } from "../src/shared/rpc-types";
import { exitApp, launchApp, pressShortcutUntilVisible } from "./harness";

type JsonRecord = Record<string, unknown>;

interface SettingAuditRow {
	path: string;
	type: SettingEntry["type"];
	tab?: string;
	condition?: string;
	tuiOnly: boolean;
	restartRequired: boolean;
	secret: boolean;
	initial: unknown;
	rowFound: boolean;
	control: {
		buttons: string[];
		inputs: Array<{ type: string; value: string; ariaLabel: string | null }>;
		selects: Array<{ value: string; optionCount: number; ariaLabel: string | null }>;
		textareas: number;
	};
	visibility:
		| "visible"
		| "advanced"
		| "hidden-by-condition"
		| "filtered-tui-only"
		| "filtered-terminal-only"
		| "no-gui-metadata";
	write: "passed" | "skipped-secret" | "skipped-unsafe" | "skipped-no-control" | "failed" | "not-run";
	readback: "passed" | "not-run" | "failed";
	restore: "passed" | "rpc-fallback" | "not-run" | "failed";
	initialAfter?: unknown;
	changedTo?: unknown;
	readbackValue?: unknown;
	error?: string;
	notes: string[];
	/** Wall time this row took in its shard; the shard cost model is derived from it. */
	durationMs?: number;
}

interface SurfaceControl {
	page: string;
	kind: string;
	name: string;
	disabled: boolean;
	role: string | null;
	selectorHint: string;
}

interface DeepAuditEvidence {
	startedAt: string;
	finishedAt?: string;
	profile: string;
	runtime: JsonRecord;
	schema: { entryCount: number; tabCount: number; entriesWithUi: number; advanced: number; tuiOnly: number };
	settingsPages: Array<{ group: string; page: string; controls: SurfaceControl[] }>;
	settings: SettingAuditRow[];
	commands: {
		availableCount: number;
		names: string[];
		paletteTopLevelCount: number;
		paletteSearchMissing: string[];
		tuiOnlyNames: string[];
		nestedSurfaces: Array<{ name: string; controls: SurfaceControl[]; status: "opened" | "failed"; error?: string }>;
		error?: string;
	};
	limitations: string[];
}

const TERMINAL_DISPLAY_PATHS = new Set([
	"tui.resizeScrollback",
	"statusLine.preset",
	"display.showTurnTime",
	"theme.dark",
	"theme.light",
	"tui.tight",
	"colorBlindMode",
	"hideThinkingBlock",
	"proseOnlyThinking",
	"display.showTokenUsage",
	"display.collapseCompacted",
	"tui.titleState",
	"goal.statusInFooter",
	"terminal.showProgress",
	"emojiAutocomplete",
	"paste.largeMenuThreshold",
	"spelling.typoDetection",
	"spelling.autocomplete",
	"spelling.autocorrect",
	"tui.vimModeDisplay",
	"tui.mouse",
	"tui.maxInlineImageColumns",
	"tui.maxInlineImageRows",
	"tui.maxInlineImages",
	"statusLine.leftSegments",
	"statusLine.rightSegments",
	"statusLine.segmentOptions",
]);

function settingRow(page: Page, pathName: string): Locator {
	const custom: Record<string, string> = {
		modelRoles: "settings-models-roles",
		"task.agentAccountPools": "settings-models-account-pools",
		"compaction.modelThresholds": "settings-models-compaction-limits",
		disabledExtensions: "settings-tools-other-extensions",
	};
	return page.locator(custom[pathName] ? `#${custom[pathName]}` : `#setting-${pathName.replaceAll(".", "\\.")}`);
}

async function readSetting(page: Page, pathName: string): Promise<unknown> {
	const response = await page.evaluate(async pathValue => window.omp.rpc.getSettings([pathValue]), pathName);
	if (!response.success) throw new Error(response.error);
	return (response.data as { values?: JsonRecord } | undefined)?.values?.[pathName];
}

async function writeSetting(page: Page, pathName: string, value: unknown): Promise<JsonRecord> {
	const response = await page.evaluate(async ({ pathValue, next }) => window.omp.rpc.setSetting(pathValue, next), {
		pathValue: pathName,
		next: value,
	});
	if (!response.success) throw new Error(response.error);
	return (response.data as JsonRecord | undefined) ?? {};
}

async function pollSetting(page: Page, pathName: string, expected: unknown): Promise<unknown> {
	await expect.poll(async () => readSetting(page, pathName), { timeout: 8_000 }).toEqual(expected);
	return readSetting(page, pathName);
}

async function restoreInitial(page: Page, pathName: string, initial: unknown): Promise<"passed"> {
	if (initial === undefined) {
		const reset = settingRow(page, pathName).getByRole("button", { name: "Remove global override", exact: true });
		await expect(reset).toBeVisible();
		await expect(reset).toBeEnabled();
		await reset.click();
		await pollSetting(page, pathName, undefined);
	}
	return "passed";
}

async function inspectRow(row: Locator): Promise<SettingAuditRow["control"]> {
	return row.evaluate(element => ({
		buttons: Array.from(element.querySelectorAll("button")).map(
			button => button.getAttribute("aria-label") ?? button.innerText.trim(),
		),
		inputs: Array.from(element.querySelectorAll("input")).map(input => ({
			type: input.type,
			value: input.value,
			ariaLabel: input.getAttribute("aria-label"),
		})),
		selects: Array.from(element.querySelectorAll("select")).map(select => ({
			value: select.value,
			optionCount: select.options.length,
			ariaLabel: select.getAttribute("aria-label"),
		})),
		textareas: element.querySelectorAll("textarea").length,
	}));
}

function equalJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function alternateOption(entry: SettingEntry, value: unknown): unknown {
	const options = entry.options ?? [];
	const current = typeof value === "string" || typeof value === "number" ? String(value) : "";
	const alternate = options.find(option => option.value !== current);
	if (!alternate) return undefined;
	if (entry.type === "number") return Number(alternate.value);
	return alternate.value;
}

function alternateNumber(input: {
	value: string;
	min: string | null;
	max: string | null;
	step: string | null;
}): number | undefined {
	const current = Number(input.value);
	const min = input.min === null || input.min === "" ? Number.NEGATIVE_INFINITY : Number(input.min);
	const max = input.max === null || input.max === "" ? Number.POSITIVE_INFINITY : Number(input.max);
	const step =
		input.step === null || input.step === "" || input.step === "any" ? 1 : Math.abs(Number(input.step)) || 1;
	const candidates = [current + step, current - step, 1, 0];
	return candidates.find(
		candidate => Number.isFinite(candidate) && candidate >= min && candidate <= max && candidate !== current,
	);
}

function safeStringValue(entry: SettingEntry, profile: string): string {
	if (entry.path.includes("Url") || entry.path.toLowerCase().includes("url")) return "http://127.0.0.1:9/gui-audit";
	if (entry.path.toLowerCase().includes("path") || entry.path.includes("directory")) return profile;
	if (entry.path.includes("interpreter")) return "/usr/bin/python3";
	return `__gui_audit__${entry.path.replaceAll(".", "_")}`;
}

function isUnsafeString(entry: SettingEntry): boolean {
	return entry.secret === true || entry.path === "images.urls.command" || entry.path === "collab.relayUrl";
}

function conditionGate(condition: string | undefined): Array<{ path: string; value: unknown }> {
	const gates: Record<string, Array<{ path: string; value: unknown }>> = {
		advisorEnabled: [{ path: "advisor.enabled", value: true }],
		autoThinkingActive: [{ path: "defaultThinkingLevel", value: "auto" }],
		usageAwareFallbackEnabled: [{ path: "retry.usageAwareFallback", value: true }],
		planModeEnabled: [{ path: "plan.enabled", value: true }],
		planAutosaveEnabled: [
			{ path: "plan.enabled", value: true },
			{ path: "plan.autosave", value: true },
		],
		unexpectedStopDetection: [{ path: "features.unexpectedStopDetection", value: true }],
	};
	return condition === undefined ? [] : (gates[condition] ?? []);
}

async function clickSearchResult(page: Page, pathName: string): Promise<boolean> {
	const search = page.locator("[data-settings-page]").getByRole("searchbox", { name: /Search settings/ });
	await search.fill(pathName);
	// A key has one canonical result, including dedicated structured editors.
	const result = page.locator(`[data-search-path="${pathName}"]`);
	if ((await result.count()) === 0) return false;
	await expect(result).toHaveCount(1);
	await result.getByRole("button").click();
	return true;
}

async function captureSurfaceControls(page: Page, pageName: string): Promise<SurfaceControl[]> {
	return page
		.locator(
			".settings-content button, .settings-content input, .settings-content select, .settings-content textarea",
		)
		.evaluateAll(
			(elements, currentPage) =>
				elements.map((element, index) => ({
					page: currentPage,
					kind: element.tagName.toLowerCase(),
					name:
						element.getAttribute("aria-label") ??
						(element instanceof HTMLInputElement && element.placeholder ? element.placeholder : null) ??
						element.textContent?.trim() ??
						"",
					disabled:
						element instanceof HTMLButtonElement ||
						element instanceof HTMLInputElement ||
						element instanceof HTMLSelectElement ||
						element instanceof HTMLTextAreaElement
							? element.disabled
							: element.hasAttribute("disabled"),
					role: element.getAttribute("role"),
					selectorHint: `${element.tagName.toLowerCase()}[data-audit-index="${index}"]`,
				})),
			pageName,
		);
}

async function mutateEntry(
	page: Page,
	row: Locator,
	entry: SettingEntry,
	initial: unknown,
	profile: string,
): Promise<
	Pick<SettingAuditRow, "write" | "readback" | "restore" | "changedTo" | "readbackValue" | "error" | "notes">
> {
	const notes: string[] = [];
	if (entry.secret === true) {
		const reveal = row.getByRole("button", { name: /Reveal/ });
		if ((await reveal.count()) > 0) {
			await reveal.click();
			notes.push("secret reveal control opened; value was not written");
		}
		return { write: "skipped-secret", readback: "not-run", restore: "not-run", notes };
	}
	if (isUnsafeString(entry)) {
		return {
			write: "skipped-unsafe",
			readback: "not-run",
			restore: "not-run",
			notes: ["write skipped to avoid starting an external uploader/relay from an audit run"],
		};
	}
	try {
		if (entry.type === "boolean") {
			const toggle = row.locator('button[role="switch"]').first();
			if ((await toggle.count()) === 0)
				return { write: "skipped-no-control", readback: "not-run", restore: "not-run", notes };
			const next = initial !== true;
			// A risky value (secret masking off, git guard off) waits for Accept risk.
			const acceptRisk = row.locator("[data-risk-accept]");
			await toggle.click();
			if (await acceptRisk.isVisible()) await acceptRisk.click();
			const readbackValue = await pollSetting(page, entry.path, next);
			if (initial === undefined) {
				const restore = await restoreInitial(page, entry.path, initial);
				return { write: "passed", readback: "passed", restore, changedTo: next, readbackValue, notes };
			}
			await toggle.click();
			if (await acceptRisk.isVisible()) await acceptRisk.click();
			await pollSetting(page, entry.path, initial);
			return { write: "passed", readback: "passed", restore: "passed", changedTo: next, readbackValue, notes };
		}

		const select = row.locator("select").first();
		if (
			entry.type === "enum" ||
			(entry.type === "number" && entry.options && entry.options.length > 0 && (await select.count()) > 0)
		) {
			const next = alternateOption(entry, initial);
			if (next === undefined) return { write: "skipped-no-control", readback: "not-run", restore: "not-run", notes };
			await select.selectOption(String(next));
			const readbackValue = await pollSetting(page, entry.path, next);
			if (initial === undefined) {
				const restore = await restoreInitial(page, entry.path, initial);
				return { write: "passed", readback: "passed", restore, changedTo: next, readbackValue, notes };
			}
			await select.selectOption(initial === undefined ? "" : String(initial));
			await pollSetting(page, entry.path, initial);
			return { write: "passed", readback: "passed", restore: "passed", changedTo: next, readbackValue, notes };
		}

		if (entry.type === "number") {
			const input = row.locator('input[type="number"], input[inputmode="numeric"]').first();
			if ((await input.count()) === 0)
				return { write: "skipped-no-control", readback: "not-run", restore: "not-run", notes };
			const metadata = await input.evaluate(element => ({
				value: (element as HTMLInputElement).value,
				min: element.getAttribute("min"),
				max: element.getAttribute("max"),
				step: element.getAttribute("step"),
			}));
			const next = alternateNumber(metadata);
			if (next === undefined) return { write: "skipped-no-control", readback: "not-run", restore: "not-run", notes };
			await input.fill(String(next));
			await input.press("Enter");
			const readbackValue = await pollSetting(page, entry.path, next);
			if (initial === undefined) {
				const restore = await restoreInitial(page, entry.path, initial);
				return { write: "passed", readback: "passed", restore, changedTo: next, readbackValue, notes };
			}
			await input.fill(String(initial));
			await input.press("Enter");
			await pollSetting(page, entry.path, initial);
			return { write: "passed", readback: "passed", restore: "passed", changedTo: next, readbackValue, notes };
		}

		if (entry.type === "string") {
			// Model/provider references use the searchable picker, which supports a
			// custom value even when the isolated audit profile has no catalog rows.
			if (/(model|provider)$/i.test(entry.path) || entry.path === "shellPath") {
				const trigger = row.locator('button[aria-haspopup="listbox"]').first();
				if ((await trigger.count()) > 0) {
					const marker =
						entry.path === "shellPath" ? "/bin/sh" : `__gui_audit__/${entry.path.replaceAll(".", "_")}`;
					await trigger.click();
					const pickerInput = row.locator("input").last();
					await expect(pickerInput).toBeVisible();
					if ((await pickerInput.count()) > 0) {
						await pickerInput.fill(marker);
						const custom = row.locator('[role="listbox"] button').filter({ hasText: marker });
						await expect(custom.last()).toBeVisible();
						if ((await custom.count()) > 0) {
							await custom.last().click();
							const readbackValue = await pollSetting(page, entry.path, marker);
							if (initial === undefined) {
								const restore = await restoreInitial(page, entry.path, initial);
								return {
									write: "passed",
									readback: "passed",
									restore,
									changedTo: marker,
									readbackValue,
									notes,
								};
							}
							await trigger.click();
							if (initial === "") {
								await row.getByRole("option", { name: /Clear/ }).click();
							} else {
								await pickerInput.fill(String(initial));
								await row
									.locator('[role="listbox"] button')
									.filter({ hasText: String(initial) })
									.last()
									.click();
							}
							await pollSetting(page, entry.path, initial == null ? "" : initial);
							return {
								write: "passed",
								readback: "passed",
								restore: "passed",
								changedTo: marker,
								readbackValue,
								notes,
							};
						}
					}
					await page.keyboard.press("Escape");
				}
			}
			const input = row.locator("input, textarea").first();
			if ((await input.count()) === 0)
				return { write: "skipped-no-control", readback: "not-run", restore: "not-run", notes };
			const next = safeStringValue(entry, profile);
			await input.fill(next);
			await input.press("Enter").catch(() => input.blur());
			const readbackValue = await pollSetting(page, entry.path, next);
			const restore = await restoreInitial(page, entry.path, initial);
			if (initial === undefined)
				return { write: "passed", readback: "passed", restore, changedTo: next, readbackValue, notes };
			await input.fill(initial == null ? "" : String(initial));
			await input.press("Enter").catch(() => input.blur());
			await pollSetting(page, entry.path, initial == null ? "" : initial);
			return { write: "passed", readback: "passed", restore: "passed", changedTo: next, readbackValue, notes };
		}

		if (entry.type === "array") {
			const input = row.locator("input").first();
			const selectControl = row.locator("select").first();
			const textarea = row.locator("textarea").first();
			if ((await textarea.count()) > 0) {
				const changed =
					entry.path === "bash.patterns"
						? [{ match: "echo gui-audit-block", approval: "deny" }]
						: ["__gui_audit__"];
				await textarea.fill(JSON.stringify(changed, null, 2));
				await row.getByRole("button", { name: /Apply/ }).click();
				const readbackValue = await pollSetting(page, entry.path, changed);
				await textarea.fill(JSON.stringify(initial ?? [], null, 2));
				await row.getByRole("button", { name: /Apply/ }).click();
				await pollSetting(page, entry.path, initial ?? []);
				return { write: "passed", readback: "passed", restore: "passed", changedTo: changed, readbackValue, notes };
			}
			if (Array.isArray(initial) && initial.length > 0) {
				const first = String(initial[0]);
				const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const remove = row.getByRole("button", { name: new RegExp(`Remove ${escaped}`) }).first();
				if ((await remove.count()) > 0) {
					await remove.click();
					const changed = initial.slice(1);
					await pollSetting(page, entry.path, changed);
					// Chip editors append new values, so adding the removed first chip
					// back would change an ordered list. Restore the exact order through
					// the same RPC used by the row after proving the UI removal/readback.
					await writeSetting(page, entry.path, initial);
					await pollSetting(page, entry.path, initial);
					return {
						write: "passed",
						readback: "passed",
						restore: "rpc-fallback",
						changedTo: changed,
						readbackValue: changed,
						notes: ["restore used RPC to preserve ordered chip position"],
					};
				}
			}
			const down = row.getByRole("button", { name: /Move .* down/ }).first();
			if ((await down.count()) > 0 && !(await down.isDisabled()) && Array.isArray(initial) && initial.length > 1) {
				const changed = [...initial];
				[changed[0], changed[1]] = [changed[1], changed[0]];
				await down.click();
				const readbackValue = await pollSetting(page, entry.path, changed);
				const up = row.getByRole("button", { name: new RegExp(`Move ${String(changed[1])} up`) }).first();
				if ((await up.count()) > 0) await up.click();
				else await writeSetting(page, entry.path, initial);
				await pollSetting(page, entry.path, initial);
				return { write: "passed", readback: "passed", restore: "passed", changedTo: changed, readbackValue, notes };
			}
			if ((await selectControl.count()) > 0 && !(await selectControl.isDisabled())) {
				const options = await selectControl
					.locator("option")
					.evaluateAll(options => options.map(option => (option as HTMLOptionElement).value).filter(Boolean));
				const current = Array.isArray(initial) ? initial.map(value => String(value)) : [];
				const next = options.find(option => !current.includes(option));
				if (!next)
					return {
						write: "skipped-no-control",
						readback: "not-run",
						restore: "not-run",
						notes: ["ordered/fixed options already exhausted"],
					};
				await selectControl.selectOption(next);
				const changed = [...current, next];
				const readbackValue = await pollSetting(page, entry.path, changed);
				await writeSetting(page, entry.path, initial);
				await pollSetting(page, entry.path, initial);
				return {
					write: "passed",
					readback: "passed",
					restore: "rpc-fallback",
					changedTo: changed,
					readbackValue,
					notes: ["restore used RPC because the chip remove label is localized"],
				};
			}
			if ((await input.count()) > 0) {
				const marker = `__gui_audit__${entry.path.replaceAll(".", "_")}`;
				await input.fill(marker);
				await input.press("Enter");
				const changed = [...(Array.isArray(initial) ? initial : []), marker];
				const readbackValue = await pollSetting(page, entry.path, changed);
				const remove = row.getByRole("button", { name: new RegExp(marker) });
				if ((await remove.count()) > 0) {
					await remove.click();
					await pollSetting(page, entry.path, initial);
					return {
						write: "passed",
						readback: "passed",
						restore: "passed",
						changedTo: changed,
						readbackValue,
						notes,
					};
				}
				await writeSetting(page, entry.path, initial);
				await pollSetting(page, entry.path, initial);
				return {
					write: "passed",
					readback: "passed",
					restore: "rpc-fallback",
					changedTo: changed,
					readbackValue,
					notes,
				};
			}
		}

		if (entry.type === "record") {
			const textarea = row.locator("textarea").first();
			if ((await textarea.count()) > 0) {
				const changed = {
					...(initial && typeof initial === "object" && !Array.isArray(initial) ? initial : {}),
					__gui_audit__: "ok",
				};
				await textarea.fill(JSON.stringify(changed, null, 2));
				const apply = row.getByRole("button", { name: /Apply/ });
				await apply.click();
				const readbackValue = await pollSetting(page, entry.path, changed);
				await textarea.fill(JSON.stringify(initial ?? {}, null, 2));
				await apply.click();
				await pollSetting(page, entry.path, initial ?? {});
				return { write: "passed", readback: "passed", restore: "passed", changedTo: changed, readbackValue, notes };
			}
			if (entry.path === "providers.maxInFlightRequests") {
				const trigger = row.getByRole("button", { name: /Add provider/ }).first();
				if ((await trigger.count()) > 0) {
					const marker = "__gui_audit_provider__";
					await trigger.click();
					const pickerInput = row.locator("input").last();
					await expect(pickerInput).toBeVisible();
					if ((await pickerInput.count()) > 0) {
						await pickerInput.fill(marker);
						const custom = row.getByRole("option", { name: new RegExp(marker) });
						await expect(custom.last()).toBeVisible();
						if ((await custom.count()) > 0) {
							await custom.last().click();
							const changed = { [marker]: 1 };
							const readbackValue = await pollSetting(page, entry.path, changed);
							const remove = row.getByRole("button", { name: /Remove/ }).last();
							if ((await remove.count()) > 0) await remove.click();
							else await writeSetting(page, entry.path, initial ?? {});
							await pollSetting(page, entry.path, initial ?? {});
							return {
								write: "passed",
								readback: "passed",
								restore: "passed",
								changedTo: changed,
								readbackValue,
								notes,
							};
						}
					}
					await page.keyboard.press("Escape");
				}
			}
			const add = row.getByRole("button", { name: /Add/ }).first();
			if ((await add.count()) > 0) {
				await add.click();
				const changed = await readSetting(page, entry.path);
				// Add row commits a placeholder entry directly (no picker opens), so there is
				// nothing to dismiss; an Escape here would close the whole Settings dialog.
				if (!changed || typeof changed !== "object" || Array.isArray(changed) || equalJson(changed, initial)) {
					return {
						write: "skipped-no-control",
						readback: "not-run",
						restore: "not-run",
						notes: ["record editor has no available provider/key option"],
					};
				}
				const readbackValue = changed;
				await writeSetting(page, entry.path, initial ?? {});
				await pollSetting(page, entry.path, initial ?? {});
				return {
					write: "passed",
					readback: "passed",
					restore: "rpc-fallback",
					changedTo: changed,
					readbackValue,
					notes: ["record editor restore used RPC"],
				};
			}
		}
		return { write: "skipped-no-control", readback: "not-run", restore: "not-run", notes };
	} catch (error) {
		return { write: "failed", readback: "failed", restore: "failed", error: String(error), notes };
	}
}

async function launchAuditApp(
	profile: string,
	project: string,
	desktop: string,
	agent: string,
): Promise<ElectronApplication> {
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			firstRunComplete: true,
			launchProfiles: { [project]: { noRules: true, noLsp: true } },
		}),
	);
	return launchApp({ project, desktop, agent, profile, env: { OMP_GUI_OMP: undefined } });
}

/**
 * The settings rows are split across this many tests, each on its own profile
 * and app, so they run side by side; together they exercise every schema entry.
 * Each row is two config.yml writes through omp (~180 ms in a full run) and each
 * shard pays ~8 s to launch the app on the system omp; real-omp apps running at
 * once slow each other's rows. In full 4-worker runs 3 shards took ~42 s each
 * (120 s in all) and 6 shards ~24 s each (146 s in all) at the same suite wall
 * time: the suite is bound by its total work, not by this test. Raise the count
 * only once these shards end the run.
 */
const SETTINGS_SHARDS = 3;

/**
 * Estimated cost (ms, during a full 4-worker run) of one schema entry, from the
 * rows' `durationMs` evidence: a GUI write and its restore cost ~180 ms whatever
 * the control, each condition gate ~40 ms more, a secret or unsafe row that is
 * only inspected ~100 ms, and a row the GUI filters out ~20 ms.
 */
function auditCost(entry: SettingEntry): number {
	if (entry.tuiOnly === true || TERMINAL_DISPLAY_PATHS.has(entry.path)) return 20;
	if (isUnsafeString(entry)) return 100;
	return 180 + 40 * conditionGate(entry.condition).length;
}

/**
 * Longest-first greedy split of the schema by `auditCost`, so shards finish
 * together. It reads only the schema, so every shard derives the same split.
 */
function settingShards(entries: SettingEntry[]): number[] {
	const loads = new Array<number>(SETTINGS_SHARDS).fill(0);
	const shards = new Array<number>(entries.length);
	const byCost = entries
		.map((entry, index) => ({ index, cost: auditCost(entry) }))
		.sort((left, right) => right.cost - left.cost || left.index - right.index);
	for (const { index, cost } of byCost) {
		const lightest = loads.indexOf(Math.min(...loads));
		shards[index] = lightest;
		loads[lightest] += cost;
	}
	return shards;
}

test.describe.configure({ mode: "parallel" });

interface AuditSession {
	page: Page;
	profile: string;
	settings: Locator;
	schema: SettingsSchemaResult;
	currentValues: JsonRecord;
}

/**
 * Launch the app on a fresh profile against the system omp, open Settings and
 * hand `body` the schema; then write `test-results/deep-audit/evidence-<name>.json`
 * and fail on any failed setting write, missing command, or failed submenu.
 */
async function runAudit(
	name: string,
	body: (session: AuditSession, evidence: DeepAuditEvidence) => Promise<void>,
): Promise<void> {
	test.setTimeout(600_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-deep-audit-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(project, "README.md"), "# GUI deep audit\n");
	const evidence: DeepAuditEvidence = {
		startedAt: new Date().toISOString(),
		profile,
		runtime: {},
		schema: { entryCount: 0, tabCount: 0, entriesWithUi: 0, advanced: 0, tuiOnly: 0 },
		settingsPages: [],
		settings: [],
		commands: {
			availableCount: 0,
			names: [],
			paletteTopLevelCount: 0,
			paletteSearchMissing: [],
			tuiOnlyNames: [],
			nestedSurfaces: [],
		},
		limitations: [
			"Runtime effect is classified as readback unless a separate consumer state is exposed by RPC; no provider/network command is executed.",
			"Destructive/external actions (delete, upload, login, publish, PR mutation) are enumerated but never confirmed in an audit profile.",
		],
	};
	const evidenceFile = `test-results/deep-audit/evidence-${name}.json`;
	let app: ElectronApplication | null = null;
	try {
		app = await launchAuditApp(profile, project, desktop, agent);
		const page = await app.firstWindow();
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 90_000, intervals: [100, 250] })
			.toMatchObject({ status: "ready" });
		evidence.runtime = await app.evaluate(({ app }) => ({
			isPackaged: app.isPackaged,
			appPath: app.getAppPath(),
			resourcesPath: process.resourcesPath,
			sidecarOverride: process.env.OMP_GUI_OMP ?? null,
		}));
		// The audit profile has no provider, so the inline first-run setup takes the empty session.
		const setup = page.getByRole("region", { name: "Set up OMPdesk", exact: true });
		await expect(setup).toBeVisible();
		await setup.getByRole("button", { name: "Set up later", exact: true }).click();
		await expect(setup).toHaveCount(0);

		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await expect(settings.locator("[data-settings-section]").first()).toBeVisible();
		const schemaResponse = await page.evaluate(() => window.omp.rpc.getSettingsSchema());
		if (!schemaResponse.success) throw new Error(schemaResponse.error);
		const schema = schemaResponse.data as SettingsSchemaResult;
		const settingsResponse = await page.evaluate(() => window.omp.rpc.getSettings());
		if (!settingsResponse.success) throw new Error(settingsResponse.error);
		const currentValues = ((settingsResponse.data as { values?: JsonRecord } | undefined)?.values ??
			{}) as JsonRecord;
		evidence.schema = {
			entryCount: schema.entries.length,
			tabCount: schema.tabs.length,
			entriesWithUi: schema.entries.filter(entry => entry.tab !== undefined).length,
			advanced: schema.entries.filter(entry => entry.tab === undefined).length,
			tuiOnly: schema.entries.filter(entry => entry.tuiOnly === true).length,
		};
		await body({ page, profile, settings, schema, currentValues }, evidence);
		evidence.finishedAt = new Date().toISOString();
		await fs.mkdir("test-results/deep-audit", { recursive: true });
		await fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
		const failed = evidence.settings.filter(row => row.write === "failed");
		expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
		expect(evidence.commands.paletteSearchMissing, JSON.stringify(evidence.commands)).toEqual([]);
		expect(evidence.commands.nestedSurfaces.filter(surface => surface.status === "failed")).toEqual([]);
	} finally {
		evidence.finishedAt ??= new Date().toISOString();
		await fs.mkdir("test-results/deep-audit", { recursive: true });
		await fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
		if (app) {
			await exitApp(app).catch(() => {});
		}
		await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
	}
}

test("deep GUI audit: settings pages and command discoverability", async () => {
	await runAudit("pages-commands", async ({ page, settings }, evidence) => {
		// Capture every settings section, and every Advanced category, on an unmutated profile.
		const sectionIds = await settings
			.locator("[data-settings-section]")
			.evaluateAll(elements => elements.map(element => element.getAttribute("data-settings-section") ?? ""));
		const capturePage = async (group: string, pageName: string) => {
			// Updates runs the real `omp update --check`, which may take up to its
			// 60s limit (UPDATE_CHECK_TIMEOUT_MS) on a slow CI network.
			await expect(settings.locator(".settings-content .animate-spin")).toHaveCount(0, { timeout: 70_000 });
			evidence.settingsPages.push({ group, page: pageName, controls: await captureSurfaceControls(page, pageName) });
		};
		for (const id of sectionIds) {
			await settings.locator(`[data-settings-section="${id}"]`).click();
			await capturePage("settings", id);
		}
		// The command palette is the single discoverability surface for built-ins,
		// slash commands, and native actions. Search every advertised command without
		// executing it and retain the TUI-only negative contract.
		// Command launchers stay outside Settings and remain reachable from the sidebar.
		await settings.getByRole("searchbox", { name: /Search settings/ }).fill("");
		await page.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);
		await page.locator('aside button[data-command-center-entry="true"]').first().click();
		await expect(page.getByRole("dialog")).toBeVisible();
		// Retried only while the palette is still open: on a slow runner the first
		// Escape can land before the freshly mounted palette listens for it.
		await expect(async () => {
			if ((await page.getByRole("dialog").count()) > 0) await page.keyboard.press("Escape");
			await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 2_000 });
		}).toPass({ timeout: 20_000 });
		// The sidebar header's palette entry is an icon button: its name says what
		// it opens and the shortcut lives in its tooltip.
		await expect(page.locator('aside button[data-command-center-entry="true"]').first()).toHaveAccessibleName(
			/^(Command palette|명령 팔레트)$/,
		);
		await page.locator('aside button[data-command-center-entry="true"]').first().click();
		const palette = page.getByRole("dialog");
		await expect(palette).toBeVisible();
		const search = palette.getByRole("combobox").first();
		const available = await page.evaluate(async () => window.omp.rpc.getAvailableCommands());
		if (available.success) {
			const commandEntries =
				(available.data as { commands?: Array<{ name: string; textModeExecutable?: boolean }> } | undefined)
					?.commands ?? [];
			const commands = commandEntries.map(command => command.name);
			evidence.commands.availableCount = commands.length;
			evidence.commands.names = commands;
			for (const { name, textModeExecutable } of commandEntries) {
				await search.fill(name);
				const exactMatch = () =>
					palette
						.locator("button[data-command-name]")
						.evaluateAll(
							(rows, command) =>
								rows.some(
									row =>
										row.getAttribute("data-command-name") === command ||
										(JSON.parse(row.getAttribute("data-command-aliases") ?? "[]") as string[]).includes(
											command,
										),
								),
							name,
						);
				if (textModeExecutable === false && !(await exactMatch())) {
					evidence.commands.tuiOnlyNames.push(name);
					continue;
				}
				try {
					await expect.poll(exactMatch, { timeout: 2_000 }).toBe(true);
				} catch {
					evidence.commands.paletteSearchMissing.push(name);
				}
			}
		} else {
			evidence.commands.error = available.error;
		}
		// Drill into every native submenu without executing its actions. This
		// verifies that nested command surfaces open and that their own controls
		// are rendered; destructive/external rows remain enumerated only.
		await search.fill("");
		await expect(palette.locator(".omp-command-list")).toBeVisible();
		evidence.commands.paletteTopLevelCount = await palette.locator("button[data-palette-index]").count();
		const submenuButtons = palette.locator('button[data-command-kind="submenu"]');
		const submenuCount = await submenuButtons.count();
		for (let index = 0; index < submenuCount; index++) {
			const button = palette.locator('button[data-command-kind="submenu"]').nth(index);
			const name = (await button.innerText()).replaceAll(/\s+/g, " ").trim();
			try {
				await button.click();
				const nestedRows = palette.locator("button[data-palette-index]");
				expect(await nestedRows.count(), `${name} did not render nested command rows`).toBeGreaterThan(0);
				await expect(palette.getByRole("combobox").first()).toBeVisible();
				evidence.commands.nestedSurfaces.push({
					name,
					status: "opened",
					controls: await palette.locator("button, input, select, textarea").evaluateAll(
						(elements, currentPage) =>
							elements.map((element, controlIndex) => ({
								page: currentPage,
								kind: element.tagName.toLowerCase(),
								name:
									element.getAttribute("aria-label") ??
									(element instanceof HTMLInputElement && element.placeholder ? element.placeholder : null) ??
									element.textContent?.trim() ??
									"",
								disabled:
									element instanceof HTMLButtonElement ||
									element instanceof HTMLInputElement ||
									element instanceof HTMLSelectElement ||
									element instanceof HTMLTextAreaElement
										? element.disabled
										: element.hasAttribute("disabled"),
								role: element.getAttribute("role"),
								selectorHint: `${element.tagName.toLowerCase()}[data-audit-index="${controlIndex}"]`,
							})),
						name,
					),
				});
			} catch (error) {
				evidence.commands.nestedSurfaces.push({ name, status: "failed", controls: [], error: String(error) });
			}
			// Entering a submenu unmounts the clicked row and refocuses the search input
			// on the next animation frame, which a headless (occluded) window can defer;
			// a page-level Escape in that gap lands on <body> and never reaches the palette.
			await palette.getByRole("combobox").first().press("Escape");
			await expect(palette.locator('button[data-command-kind="submenu"]')).toHaveCount(submenuCount);
		}
		await page.keyboard.press("Escape");
	});
});

for (let shard = 0; shard < SETTINGS_SHARDS; shard++) {
	test(`deep GUI audit: settings rows and nested controls (${shard + 1}/${SETTINGS_SHARDS})`, async () => {
		await runAudit(
			`settings-${shard + 1}-of-${SETTINGS_SHARDS}`,
			async ({ page, profile, schema, currentValues }, evidence) => {
				// Exercise every schema entry that the GUI claims to support. TUI-only and
				// metadata-less entries remain explicit rows in the matrix instead of being silently dropped.
				const shards = settingShards(schema.entries);
				for (const [index, entry] of schema.entries.entries()) {
					if (shards[index] !== shard) continue;
					const rowStarted = performance.now();
					const record = (row: SettingAuditRow) => {
						row.durationMs = Math.round(performance.now() - rowStarted);
						evidence.settings.push(row);
					};
					let initial = currentValues[entry.path] ?? entry.value;
					const isTuiOnly = entry.tuiOnly === true;
					const isTerminalOnly = TERMINAL_DISPLAY_PATHS.has(entry.path);
					if (initial === undefined && !isTuiOnly && !isTerminalOnly) {
						initial = await readSetting(page, entry.path);
						initial ??= entry.default;
					}
					const base: SettingAuditRow = {
						path: entry.path,
						type: entry.type,
						tab: entry.tab,
						condition: entry.condition,
						tuiOnly: isTuiOnly,
						restartRequired: entry.restartRequired === true,
						secret: entry.secret === true,
						initial,
						rowFound: false,
						control: { buttons: [], inputs: [], selects: [], textareas: 0 },
						visibility: isTuiOnly
							? "filtered-tui-only"
							: isTerminalOnly
								? "filtered-terminal-only"
								: entry.tab
									? "hidden-by-condition"
									: "advanced",
						write: "not-run",
						readback: "not-run",
						restore: "not-run",
						notes: [],
					};
					if (base.visibility === "filtered-tui-only" || base.visibility === "filtered-terminal-only") {
						await clickSearchResult(page, entry.path);
						await expect(page.locator(`[data-search-path="${entry.path}"]`)).toHaveCount(0);
						base.notes.push("GUI search absence verified");
						record(base);
						continue;
					}
					const gates = conditionGate(entry.condition);
					const gateOriginals: Array<{ path: string; value: unknown }> = [];
					try {
						for (const gate of gates) {
							const originalGate = await readSetting(page, gate.path);
							gateOriginals.push({ path: gate.path, value: originalGate });
							if (!equalJson(originalGate, gate.value)) {
								await writeSetting(page, gate.path, gate.value);
								await pollSetting(page, gate.path, gate.value);
							}
						}
						// Search drives the same locator path a user sees, after the condition
						// gate has been opened through the real settings RPC.
						const found = await clickSearchResult(page, entry.path);
						if (!found) {
							base.notes.push("not in GUI search results after enabling its condition gate");
							record(base);
							continue;
						}
						const row = settingRow(page, entry.path);
						if ((await row.count()) === 0) {
							base.notes.push("search result did not resolve to a setting row");
							record(base);
							continue;
						}
						await expect(row).toBeVisible();
						base.rowFound = true;
						base.visibility = "visible";
						base.control = await inspectRow(row);
						const result = await mutateEntry(page, row, entry, initial, profile);
						Object.assign(base, result);
						base.initialAfter = await readSetting(page, entry.path).catch(() => undefined);
						record(base);
					} catch (error) {
						base.write = "failed";
						base.readback = "failed";
						base.restore = "failed";
						base.error = String(error);
						record(base);
					} finally {
						for (const original of gateOriginals.reverse()) {
							if (!equalJson(await readSetting(page, original.path).catch(() => undefined), original.value)) {
								await writeSetting(page, original.path, original.value);
								await pollSetting(page, original.path, original.value).catch(() => {});
							}
						}
					}
				}
			},
		);
	});
}

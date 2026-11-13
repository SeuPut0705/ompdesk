/**
 * What Node serves every module moved into the shell (PROTOCOL.md §15.2):
 * - `core.call`: the relay to `ompdesk-core`, whose process Node owns until the core moves under the shell. The answer
 *   is the core's (its bytes too); a fault keeps the core's `code`; the shell's `{cancel: id}` cancels it in the core.
 * - `log.runtime`: a line of `gui-runtime.jsonl`, written by `writeRuntimeLog` (Node is the file's one writer).
 * - `i18n.labels`: Node's label table for the shell, pushed now and on every language change (`publishLabels`).
 *   Transitional: SX5 moves i18n into the shell and deletes it (PROTOCOL.md §15.4 rule 2).
 */
import { CoreError, type CoreProcess } from "../../core/process";
import { getMainLanguage, type MainLanguage } from "../../i18n";
import { MAIN_TEXT } from "../../i18n-text";
import type { RuntimeLogReport } from "../../runtime-log-core";
import { TRAY_LABELS } from "../../tray-labels";
import { Answered, HostError } from "../client";
import type { HostClient } from "../electron/host";

interface CoreCall {
	method: string;
	params?: unknown;
	timeoutMs?: number;
}

interface RuntimeLine {
	report: RuntimeLogReport;
	windowId?: number;
	cwd?: string;
}

export interface RelayDeps {
	core(): CoreProcess;
	writeRuntimeLog(report: RuntimeLogReport, context: { windowId?: number; cwd?: string }): void;
}

export function serveShellRelays(host: HostClient, deps: RelayDeps): void {
	host.handle("core.call", async ({ method, params, timeoutMs }: CoreCall, { bin, signal }) => {
		try {
			const answer = await deps.core().call(method, params ?? {}, {
				signal,
				...(bin === undefined ? {} : { bin }),
				...(timeoutMs === undefined ? {} : { timeoutMs }),
			});
			return answer.bin === null ? answer.result : new Answered(answer.result, answer.bin);
		} catch (error) {
			if (error instanceof CoreError) throw new HostError(error.code, error.message);
			throw error;
		}
	});
	host.on("log.runtime", ({ report, windowId, cwd }: RuntimeLine) => {
		deps.writeRuntimeLog(report, {
			...(windowId === undefined ? {} : { windowId }),
			...(cwd === undefined ? {} : { cwd }),
		});
	});
}

/** The table `i18n.labels` carries: every `MAIN_TEXT` key as it is, every `TRAY_LABELS` key as `tray.<key>`. */
export function labelTable(language: MainLanguage): { language: MainLanguage; text: Record<string, string> } {
	const text: Record<string, string> = {};
	for (const [key, value] of Object.entries(MAIN_TEXT)) text[key] = value[language];
	for (const [key, value] of Object.entries(TRAY_LABELS)) {
		if (Object.hasOwn(text, `tray.${key}`)) throw new Error(`label tray.${key} is in MAIN_TEXT and TRAY_LABELS`);
		text[`tray.${key}`] = value[language];
	}
	return { language, text };
}

/** Pushes the table for the current UI language; call at start and after every language change. */
export function publishLabels(host: HostClient): void {
	void host.event("i18n.labels", labelTable(getMainLanguage()));
}

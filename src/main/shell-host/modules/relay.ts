/**
 * What Node serves every module moved into the shell (PROTOCOL.md §15.2):
 * - `core.call`: the relay to `ompdesk-core`, whose process Node owns until the core moves under the shell. The answer
 *   is the core's (its bytes too); a fault keeps the core's `code`; the shell's `{cancel: id}` cancels it in the core.
 * - `log.runtime`: a line of `gui-runtime.jsonl`, written by `writeRuntimeLog` (Node is the file's one writer).
 * Main's text is the shell's own (`boot_core/main-text.json`, `boot.labels`, §15.9).
 */
import { CoreError, type CoreProcess } from "../../core/process";
import type { RuntimeLogReport } from "../../runtime-log-core";
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
}

export interface RelayDeps {
	core(): CoreProcess;
	writeRuntimeLog(report: RuntimeLogReport, context: { windowId?: number }): void;
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
	host.on("log.runtime", ({ report, windowId }: RuntimeLine) => {
		deps.writeRuntimeLog(report, windowId === undefined ? {} : { windowId });
	});
}

/**
 * `core.call` (PROTOCOL.md §15.2): a module moved into the shell reaches `ompdesk-core` through Node, which owns the
 * core's process until the core moves under the shell. The answer is the core's (its bytes too); a fault keeps the
 * core's `code`; the shell's `{cancel: id}` cancels the request in the core.
 */
import { CoreError, type CoreProcess } from "../../core/process";
import { Answered, HostError } from "../client";
import type { HostClient } from "../electron/host";

interface CoreCall {
	method: string;
	params?: unknown;
	timeoutMs?: number;
}

export function serveCoreRelay(host: HostClient, core: () => CoreProcess): void {
	host.handle("core.call", async ({ method, params, timeoutMs }: CoreCall, { bin, signal }) => {
		try {
			const answer = await core().call(method, params ?? {}, {
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
}

/**
 * The extension updater's rules in the core process (`native/ompdesk/crates/core/src/ext/`): what an MCP server's
 * launch is, the row each installed thing gets, what a binary's file says about itself, the running rule and the
 * registry answers' parsers. Each `ext.*` request reads at most a file's head and a venv's folder.
 */
import { core } from "../core/process";
import { fencedCall } from "../serial-chain";

/**
 * The core's answer to `method`, fenced to the updater's step it is asked in: a pass stopped for running past its
 * bound neither asks nor goes on with what came back.
 */
export function extRule<T>(method: string, params: object): Promise<T> {
	return fencedCall(async () => (await core().call<T>(method, params)).result)();
}

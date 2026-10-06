/**
 * Stock builtin slash commands driven headlessly through `prompt`.
 *
 * Stock omp runs a builtin (`/fresh`, `/add-dir`, `/shake`, …) inside the
 * `prompt` handler and acks with `agentInvoked: false`; its text reply rides
 * `command_output` frames straight to the renderer. A name stock does not know
 * as a builtin would instead reach the model as a user prompt, so every call
 * first checks the name against the spawn's advertised builtins.
 */
import { type BridgeClient, type LocalCommandContext, LocalCommandError } from "./types";

interface AvailableCommand {
	name: string;
	aliases?: string[];
	source?: string;
}

/** Builtin names + aliases per omp spawn (keyed by its bridge client, which lives exactly as long). */
const builtinNames = new WeakMap<BridgeClient, Promise<Set<string>>>();

function loadBuiltinNames(ctx: LocalCommandContext): Promise<Set<string>> {
	const cached = builtinNames.get(ctx.bridge);
	if (cached) return cached;
	const loading = ctx.send<{ commands?: AvailableCommand[] }>({ type: "get_available_commands" }).then(data => {
		const names = new Set<string>();
		for (const command of data?.commands ?? []) {
			if (command.source !== "builtin") continue;
			names.add(command.name);
			for (const alias of command.aliases ?? []) names.add(alias);
		}
		return names;
	});
	builtinNames.set(ctx.bridge, loading);
	// A failed lookup must not poison the cache for the rest of the spawn.
	loading.catch(() => builtinNames.delete(ctx.bridge));
	return loading;
}

/** `/name args` → `name` (stock's parser also splits on `:`). */
function slashName(line: string): string {
	const match = /^\/([^\s:]+)/.exec(line.trim());
	if (!match) throw new Error(`Not a slash command: ${line}`);
	return match[1];
}

/**
 * Run `line` (e.g. `/add-dir /tmp`) as a stock builtin. Resolves with whether the
 * builtin started an agent turn; rejects with code `unsupported` when this omp
 * has no such builtin.
 */
export async function runSlashCommand(ctx: LocalCommandContext, line: string): Promise<{ agentInvoked: boolean }> {
	const name = slashName(line);
	if (!(await loadBuiltinNames(ctx)).has(name)) {
		throw new LocalCommandError(`omp ${ctx.omp.version} has no /${name} command`, "unsupported");
	}
	const data = await ctx.send<{ agentInvoked?: boolean } | undefined>({ type: "prompt", message: line.trim() });
	return { agentInvoked: data?.agentInvoked === true };
}

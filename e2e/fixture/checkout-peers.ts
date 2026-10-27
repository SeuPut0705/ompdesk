/**
 * The fake omp's side of sessions sharing a checkout (bridge resources/gui-bridge/modes/checkout-peers.ts): it keeps
 * what main pushes (`checkout_peers_set`), answers `checkout_status` (files and the task set by a `{task}` step), and plays an agent's turn from a
 * `fixture checkout:<json steps>` prompt through the bridge's own `CheckoutLedger` as stock's `tool_call` hook would:
 * a refused call gets the refusal as its result and runs nothing; every notice the ledger returns goes to the final
 * answer. Steps: `{wait: "peers"}` (until main has told it of another session, ≤ 15 s), `{wait: "files"}` (until a
 * same-worktree peer lists a changed file), `{wait: "shared", task?}` (until one, the one doing `task` when given, lists a file this session changed too),
 * `{write: path, content}`, `{bash: command}`, `{task: text}` (the in-progress todo item peers hear of),
 * `{edit: path, append}` (an edit-tool edit: it appends a line).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import {
	CheckoutLedger,
	CheckoutPeersState,
	retiredClaims,
} from "../../resources/gui-bridge/modes/checkout-peers-core";
import type { AgentMessage } from "../../src/shared/rpc-types";

type Params = Record<string, unknown>;
type Step =
	| { wait: "peers" | "files" | "shared"; task?: string }
	| { write: string; content?: string }
	| { bash: string }
	| { task: string }
	| { edit: string; append: string };

interface Host {
	write(frame: object): void;
	appendMessage(message: AgentMessage): void;
	endTurn(messages: AgentMessage[]): void;
	model: { provider: string; id: string };
}

const files = {
	realpath: (path: string) => fs.realpathSync.native(path),
	isDirectory: (path: string) => fs.statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
};

export function createCheckoutFake(host: Host) {
	const state = new CheckoutPeersState();
	const ledger = new CheckoutLedger();
	let task: string | undefined;
	const cwd = process.cwd();
	/** Each answer names its turn, so a test waiting for this turn's answer never reads the one before. */
	let turns = 0;
	let calls = 0;

	const bridgeMethods: Record<string, (params: Params) => unknown> = {
		checkout_peers_set: params => {
			state.set(params);
			return { ok: true };
		},
		checkout_status: () => ({
			files: [...ledger.files],
			stamps: ledger.files.map(file => ledger.stamp(file)),
			...(task ? { task } : {}),
		}),
		checkout_retire: params => {
			ledger.retire(retiredClaims(params));
			return { ok: true };
		},
		"checkout_peers.get": () => ({ peers: state.peers ?? null }),
	};

	function call(
		turn: AgentMessage[],
		index: number,
		toolName: string,
		args: Params,
		run: () => { text: string; isError: boolean },
	): void {
		const id = `checkout-${Date.now()}-${index}`;
		const message = {
			role: "assistant",
			content: [{ type: "toolCall", id, name: toolName, arguments: args }],
			timestamp: Date.now(),
			provider: host.model.provider,
			model: host.model.id,
			stopReason: "toolUse",
		} as AgentMessage;
		host.appendMessage(message);
		host.write({ type: "message_end", message });
		host.write({ type: "tool_execution_start", toolCallId: id, toolName, args });
		const { text, isError } = run();
		const content = [{ type: "text", text }];
		host.write({ type: "tool_execution_end", toolCallId: id, toolName, result: { content }, isError });
		const result = {
			role: "toolResult",
			toolCallId: id,
			toolName,
			content,
			isError,
			timestamp: Date.now(),
		} as AgentMessage;
		host.appendMessage(result);
		host.write({ type: "message_end", message: result });
		turn.push(message, result);
	}

	/** Stock's `tool_call` hook, then the tool: a refusal is the result; a notice joins the turn's answer. */
	function guarded(
		toolName: string,
		input: Params,
		notices: string[],
		act: () => { text: string; isError: boolean },
	): { text: string; isError: boolean } {
		const id = `call-${++calls}`;
		const verdict = ledger.call(toolName, input, cwd, state.peers, files, id);
		if ("block" in verdict) return { text: verdict.block, isError: true };
		if (verdict.notice) notices.push(verdict.notice);
		const outcome = act();
		ledger.settle(id);
		return outcome;
	}

	function bash(command: string): { text: string; isError: boolean } {
		try {
			const out = execFileSync("sh", ["-c", command], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			return { text: out || "(no output)", isError: false };
		} catch (error) {
			const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : error;
			return { text: String(stderr), isError: true };
		}
	}

	function writeFile(path: string, content: string): { text: string; isError: boolean } {
		const file = nodePath.resolve(cwd, path);
		fs.mkdirSync(nodePath.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		return { text: `Wrote ${path}`, isError: false };
	}

	function editFile(path: string, append: string): { text: string; isError: boolean } {
		fs.appendFileSync(nodePath.resolve(cwd, path), append);
		return { text: `Edited ${path}`, isError: false };
	}

	async function run(user: AgentMessage, steps: Step[]): Promise<void> {
		const turn: AgentMessage[] = [user];
		const refused: string[] = [];
		const notices: string[] = [];
		for (const [index, step] of steps.entries()) {
			if ("wait" in step) {
				const until = Date.now() + 15_000;
				const ready = () =>
					step.wait === "peers"
						? state.peers
						: state.peers?.worktree.some(
								peer =>
									(step.task === undefined || peer.task === step.task) &&
									(step.wait === "files" ? peer.files : peer.shared)?.length,
							);
				while (!ready() && Date.now() < until) {
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, 100);
					await promise;
				}
			} else if ("task" in step) {
				task = step.task;
			} else {
				const [toolName, input, act] =
					"edit" in step
						? (["edit", { path: step.edit }, () => editFile(step.edit, step.append)] as const)
						: "write" in step
							? ([
									"write",
									{ path: step.write, content: step.content ?? "" },
									() => writeFile(step.write, step.content ?? ""),
								] as const)
							: (["bash", { command: step.bash }, () => bash(step.bash)] as const);
				call(turn, index, toolName, input, () => {
					const outcome = guarded(toolName, input, notices, act);
					if (outcome.text.startsWith("Refused")) refused.push(outcome.text.split("\n", 1)[0] ?? "");
					return outcome;
				});
			}
		}
		const answer = {
			role: "assistant",
			content: [
				{ type: "text", text: [`Checkout steps finished (turn ${++turns})`, ...refused, ...notices].join("\n") },
			],
			timestamp: Date.now(),
			provider: host.model.provider,
			model: host.model.id,
			stopReason: "stop",
		} as AgentMessage;
		host.appendMessage(answer);
		host.write({ type: "message_end", message: answer });
		turn.push(answer);
		host.endTurn(turn);
	}

	return { bridgeMethods, run };
}

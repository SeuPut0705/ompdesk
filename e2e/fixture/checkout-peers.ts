/**
 * The fake omp's side of sessions sharing a checkout (bridge resources/gui-bridge/modes/checkout-peers.ts): it keeps
 * what main pushes (`checkout_peers_set`), answers `checkout_touched`, and plays an agent's turn from a
 * `fixture checkout:<json steps>` prompt through the bridge's own guard (`checkoutRefusal`) as stock's `tool_call`
 * hook would: a refused bash call gets the refusal as its result and runs nothing; a write records the file as this
 * session's. Steps: `{wait: "peers"}` (until main has told it of another session, ≤ 15 s), `{write: path, content}`,
 * `{bash: command}`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { normalizePath } from "../../resources/gui-bridge/modes/autopilot-guard-core";
import type { CheckoutPeers } from "../../resources/gui-bridge/modes/checkout-peers-contracts";
import { checkoutRefusal, rememberFiles } from "../../resources/gui-bridge/modes/checkout-peers-core";
import type { AgentMessage } from "../../src/shared/rpc-types";

type Params = Record<string, unknown>;
type Step = { wait: "peers" } | { write: string; content?: string } | { bash: string };

interface Host {
	write(frame: object): void;
	appendMessage(message: AgentMessage): void;
	endTurn(messages: AgentMessage[]): void;
	model: { provider: string; id: string };
}

export function createCheckoutFake(host: Host) {
	let peers: CheckoutPeers | undefined;
	let ownFiles: string[] = [];
	const cwd = process.cwd();

	const bridgeMethods: Record<string, (params: Params) => unknown> = {
		checkout_peers_set: params => {
			const next = params as unknown as CheckoutPeers;
			peers = next.worktree.length > 0 || next.repo.length > 0 ? next : undefined;
			return { ok: true };
		},
		checkout_touched: () => ({ files: ownFiles }),
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

	function bash(command: string): { text: string; isError: boolean } {
		const refusal = peers ? checkoutRefusal(command, normalizePath(cwd, "/"), peers, ownFiles) : undefined;
		if (refusal) return { text: refusal, isError: true };
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
		ownFiles = rememberFiles(ownFiles, [normalizePath(file, "/")], 40);
		return { text: `Wrote ${path}`, isError: false };
	}

	async function run(user: AgentMessage, steps: Step[]): Promise<void> {
		const turn: AgentMessage[] = [user];
		const refused: string[] = [];
		for (const [index, step] of steps.entries()) {
			if ("wait" in step) {
				const until = Date.now() + 15_000;
				while (!peers && Date.now() < until) {
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, 100);
					await promise;
				}
			} else if ("write" in step) {
				const content = step.content ?? "";
				call(turn, index, "write", { path: step.write, content }, () => writeFile(step.write, content));
			} else
				call(turn, index, "bash", { command: step.bash }, () => {
					const outcome = bash(step.bash);
					if (outcome.text.startsWith("Refused")) refused.push(outcome.text.split("\n", 1)[0] ?? "");
					return outcome;
				});
		}
		const answer = {
			role: "assistant",
			content: [{ type: "text", text: ["Checkout steps finished", ...refused].join("\n") }],
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

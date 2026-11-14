/**
 * Client-side transcript/todo clipboard flows backing the nativized /dump and
 * /todo subcommands: fetch structured state over RPC (or the live stores),
 * format it as readable markdown/JSON, and push it to the clipboard with a
 * toast result — no prompt round-trip through the agent.
 */

import type { AgentMessage, TodoPhase, TodoTask } from "../../shared/rpc-types";
import { hydrateSession } from "../hooks/use-rpc-events";
import { toast } from "../stores/toast";
import { useTodoStore } from "../stores/todo";
import { loadChunk } from "./chunk-load";
import { copyText } from "./format";
import { translate } from "./i18n";

const TODO_STATUS_VALID: Record<string, true> = {
	pending: true,
	in_progress: true,
	completed: true,
	abandoned: true,
	blocked: true,
};

function taskCount(phases: TodoPhase[]): number {
	return phases.reduce((total, phase) => total + phase.tasks.length, 0);
}

/** Store phases stripped of GUI-side ids back down to the wire shape. */
function currentTodoPhases(): TodoPhase[] {
	return useTodoStore.getState().phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
	}));
}

/** /dump: full transcript as markdown → clipboard → toast. */
export async function dumpTranscriptToClipboard(): Promise<void> {
	const response = await window.omp.rpc.getTranscript();
	if (!response.success) throw new Error(response.error);
	const messages = (response.data as { messages?: AgentMessage[] } | undefined)?.messages ?? [];
	if (messages.length === 0) {
		toast({ variant: "info", message: translate("dump.empty") });
		return;
	}
	const { formatTranscriptMarkdown } = await loadChunk(() => import("./transcript-format"));
	if (!(await copyText(formatTranscriptMarkdown(messages)))) throw new Error(translate("dump.failed"));
	toast({ variant: "success", message: translate("dump.copied", { count: messages.length }) });
}

/** /todo copy: current phases as a markdown task list → clipboard → toast. */
export async function copyTodosToClipboard(): Promise<void> {
	const phases = currentTodoPhases();
	const count = taskCount(phases);
	if (count === 0) {
		toast({ variant: "info", message: translate("todoCmd.empty") });
		return;
	}
	const { formatTodoMarkdown } = await loadChunk(() => import("./transcript-format"));
	if (!(await copyText(formatTodoMarkdown(phases)))) throw new Error(translate("todoCmd.copyFailed"));
	toast({ variant: "success", message: translate("todoCmd.copied", { count }) });
}

/**
 * /todo export: the GUI preload exposes no fs-write IPC (system/fs only has
 * list/read), so the save-dialog + write flow degrades to clipboard + toast
 * until a write bridge exists.
 */
export async function exportTodos(): Promise<void> {
	const phases = currentTodoPhases();
	const count = taskCount(phases);
	if (count === 0) {
		toast({ variant: "info", message: translate("todoCmd.empty") });
		return;
	}
	if (!(await copyText(JSON.stringify(phases, null, 2)))) throw new Error(translate("todoCmd.copyFailed"));
	toast({ variant: "success", message: translate("todoCmd.exportCopied", { count }) });
}

/** Validate parsed JSON into the TodoPhase wire shape; throws when malformed. */
export function parseTodoPhasesJson(value: unknown): TodoPhase[] {
	const message = translate("todoCmd.importInvalid");
	if (!Array.isArray(value)) throw new Error(message);
	const phases: TodoPhase[] = [];
	for (const rawPhase of value) {
		if (typeof rawPhase !== "object" || rawPhase === null) throw new Error(message);
		const { name, tasks } = rawPhase as { name?: unknown; tasks?: unknown };
		if (typeof name !== "string" || !name.trim() || !Array.isArray(tasks)) throw new Error(message);
		const parsedTasks: TodoTask[] = tasks.map(rawTask => {
			if (typeof rawTask !== "object" || rawTask === null) throw new Error(message);
			const { content, status } = rawTask as { content?: unknown; status?: unknown };
			if (typeof content !== "string" || !content.trim()) throw new Error(message);
			if (status !== undefined && (typeof status !== "string" || TODO_STATUS_VALID[status] !== true)) {
				throw new Error(message);
			}
			return { content, status: (status ?? "pending") as TodoTask["status"] };
		});
		phases.push({ name, tasks: parsedTasks });
	}
	return phases;
}

/** /todo import: open dialog → read JSON → validate → set_todos RPC → toast. */
export async function importTodosFromFile(): Promise<void> {
	const picked = await window.omp.system.showOpenDialog([{ name: "JSON", extensions: ["json"] }]);
	const path = picked?.[0];
	if (!path) return;
	const read = await window.omp.fs.read(path, 4 * 1024 * 1024);
	if (!read.ok || read.binary || read.truncated) throw new Error(translate("todoCmd.importReadFailed"));
	let parsed: unknown;
	try {
		parsed = JSON.parse(read.content);
	} catch {
		throw new Error(translate("todoCmd.importInvalid"));
	}
	const phases = parseTodoPhasesJson(parsed);
	const response = await window.omp.rpc.setTodos(phases);
	if (!response.success) throw new Error(response.error);
	await hydrateSession();
	toast({ variant: "success", message: translate("todoCmd.imported", { count: taskCount(phases) }) });
}

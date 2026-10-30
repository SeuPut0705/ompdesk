/**
 * The jobs poll reads only while the jobs can change without a tool call (use-background-jobs.ts): a tab with an
 * empty tree and no turn or live subagent reads nothing; a turn or a listed job polls every 3 s; the tab stopping
 * work reads once more, for a job started in its last seconds.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcJobRow, RpcResponse } from "../../shared/rpc-types";
import {
	deleteSessionRuntime,
	registerSessionRuntime,
	type SessionRuntime,
	SessionRuntimeProvider,
} from "../stores/session-runtime-context";
import { createSubagentsStore } from "../stores/subagents";
import { createTodoStore } from "../stores/todo";
import { useBackgroundJobs } from "./use-background-jobs";

const { document, window, Element } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, { document, window, Element, IS_REACT_ACT_ENVIRONMENT: true });

let rows: RpcJobRow[] = [];
const getJobs = vi.fn(
	async (): Promise<RpcResponse> => ({ type: "response", command: "get_jobs", success: true, data: { rows } }),
);
const todo = createTodoStore();
const subagents = createSubagentsStore();
let runtime: SessionRuntime;
let root: Root;

function Probe() {
	useBackgroundJobs();
	return null;
}

const advance = (ms: number) =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});

beforeEach(async () => {
	vi.useFakeTimers();
	rows = [];
	getJobs.mockClear();
	todo.setState({ turnActive: false });
	runtime = registerSessionRuntime({
		tabId: "t1",
		command: async command => {
			if (command.type === "get_jobs") return getJobs();
			return { type: "response", command: command.type, success: false, error: "not under test" };
		},
		stores: new Map([
			["todo", todo],
			["subagents", subagents],
		] as never),
	});
	const container = document.createElement("div");
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<SessionRuntimeProvider runtime={runtime}>
				<Probe />
			</SessionRuntimeProvider>,
		);
	});
	await advance(0);
});

afterEach(async () => {
	await act(async () => root.unmount());
	deleteSessionRuntime("t1");
	vi.useRealTimers();
});

const running = (id: string): RpcJobRow => ({
	kind: "job",
	depth: 0,
	cancellable: true,
	job: { id, type: "bash", status: "running", label: "build", startTime: 0 },
});

describe("the jobs poll", () => {
	it("reads nothing for an idle tab with no jobs, and polls while its turn runs", async () => {
		expect(getJobs).toHaveBeenCalledTimes(1);
		await advance(30_000);
		expect(getJobs).toHaveBeenCalledTimes(1);

		await act(async () => todo.getState().setTurnActive(true));
		await advance(3_000);
		expect(getJobs).toHaveBeenCalledTimes(2);
		await advance(3_000);
		expect(getJobs).toHaveBeenCalledTimes(3);
	});

	it("reads once more as the turn ends, and keeps polling while that read lists a job", async () => {
		await act(async () => todo.getState().setTurnActive(true));
		await advance(3_000);
		const during = getJobs.mock.calls.length;
		// The turn's last tool call started a job a moment before it ended.
		rows = [running("late")];
		await act(async () => todo.getState().setTurnActive(false));
		await advance(0);
		expect(getJobs).toHaveBeenCalledTimes(during + 1);
		await advance(3_000);
		expect(getJobs).toHaveBeenCalledTimes(during + 2);
		// The job ended and stock evicted it: the tree is empty again and the tab idle, so the reads stop.
		rows = [];
		await advance(3_000);
		const settled = getJobs.mock.calls.length;
		await advance(30_000);
		expect(getJobs).toHaveBeenCalledTimes(settled);
	});
});

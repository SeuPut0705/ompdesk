/**
 * Side panel › Jobs: running jobs (incl. pending cancellation) group above
 * recent ones, and an empty snapshot shows the empty state. Same linkedom +
 * react-dom harness as ThinkingBlock.test.tsx; `window.omp.rpc.getJobs` is
 * stubbed.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcAsyncJobItem, RpcResponse } from "../../../shared/rpc-types";
import { useBackgroundJobs } from "../../hooks/use-background-jobs";
import { I18nProvider } from "../../lib/i18n";
import { JobsPanel } from "./JobsPanel";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

/** Structural stand-in for linkedom nodes, keeping tests decoupled from its types. */
interface TestElement {
	textContent: string | null;
	remove: () => void;
	getAttribute: (name: string) => string | null;
	querySelectorAll: (selector: string) => TestElement[];
}

let container: TestElement;
let root: Root;

function installJobs(jobs: RpcAsyncJobItem[]) {
	const getJobs = vi.fn(
		async (): Promise<RpcResponse> => ({ type: "response", command: "get_jobs", success: true, data: { jobs } }),
	);
	Object.assign(window, { omp: { rpc: { getJobs } } });
	return getJobs;
}

let dockJobs: RpcAsyncJobItem[] | undefined;

/** The dock island's view of the same tab's jobs. */
function DockProbe() {
	dockJobs = useBackgroundJobs();
	return null;
}

async function mount(withDock = false): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<JobsPanel />
				{withDock && <DockProbe />}
			</I18nProvider>,
		);
	});
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

function sectionJobIds(index: number): string[] {
	const section = container.querySelectorAll("section")[index];
	if (!section) throw new Error(`section ${index} not rendered`);
	return Array.from(section.querySelectorAll("[data-job-id]")).map(item => item.getAttribute("data-job-id") ?? "");
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container?.remove();
});

describe("JobsPanel", () => {
	it("groups running and cancelling jobs above recent ones", async () => {
		const start = Date.now() - 5000;
		const getJobs = installJobs([
			{
				id: "j1",
				type: "bash",
				status: "running",
				label: "bun test --watch",
				startTime: start,
				resultPreview: "\u001b[32mWatching changes\u001b[0m",
			},
			{
				id: "j2",
				type: "task",
				status: "completed",
				label: "explore repo",
				startTime: start,
				endedAt: start + 2000,
				resultPreview: "done",
			},
			{
				id: "j3",
				type: "bash",
				status: "cancelled",
				label: "sleep 100",
				startTime: start,
				cancellationPending: true,
			},
		]);
		await mount();

		expect(getJobs).toHaveBeenCalled();
		expect(sectionJobIds(0)).toEqual(["j1", "j3"]);
		expect(sectionJobIds(1)).toEqual(["j2"]);
		const headings = Array.from(container.querySelectorAll("h3")).map(heading => heading.textContent);
		expect(headings[0]).toBe("Running2");
		expect(headings[1]).toContain("1");
		expect(container.textContent).toContain("Cancelling…");
		expect(container.textContent).toContain("Result / error");
		expect(container.textContent).toContain("Updated");
		expect(container.textContent).toContain("Watching changes");
		expect(container.querySelectorAll("details[open]")).toHaveLength(1);
		expect(container.querySelectorAll("summary svg")).toHaveLength(2);
		expect(headings[1]).toBe("Recent1");
		const rows = container.querySelectorAll("[data-job-id]");
		expect(rows.every(row => row.getAttribute("class") === rows[0]?.getAttribute("class"))).toBe(true);
	});

	it("cancels a running stock job and re-reads its snapshot without blanking the list", async () => {
		const job = { id: "running", type: "bash", status: "running", label: "build", startTime: Date.now() } as const;
		const getJobs = installJobs([job]);
		const command = vi.fn(async () => ({ success: true, data: { cancelled: true } }));
		Object.assign(window, { omp: { rpc: { getJobs, command } } });
		await mount();
		const reread = Promise.withResolvers<RpcResponse>();
		getJobs.mockReturnValueOnce(reread.promise);
		const cancel = [...document.querySelectorAll("button")].find(button => button.textContent === "Cancel");
		expect(cancel).toBeDefined();
		await act(async () => {
			cancel?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(command).toHaveBeenCalledWith({ type: "cancel_job", jobId: "running" });
		expect(getJobs).toHaveBeenCalledTimes(2);
		// While the re-read is in flight the row stays; a reload from empty flashed a spinner here.
		expect(container.querySelectorAll('[data-job-id="running"]')).toHaveLength(1);
		await act(async () => {
			reread.resolve({
				type: "response",
				command: "get_jobs",
				success: true,
				data: { jobs: [{ ...job, cancellationPending: true }] },
			});
		});
		expect(container.textContent).toContain("Cancelling…");
	});

	it("shows the empty state when there are no jobs", async () => {
		installJobs([]);
		await mount();

		expect(container.textContent).toContain("No background tasks running.");
		expect(container.querySelectorAll('button[aria-label="Refresh"]')).toHaveLength(0);
		expect(container.querySelectorAll("section")).toHaveLength(0);
	});

	it("shares one poll with the dock: every job here, the running shells there", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const startTime = Date.now();
			const shell = { id: "shell", type: "bash", status: "running", label: "dev server", startTime } as const;
			const getJobs = installJobs([
				shell,
				{ id: "agent", type: "task", status: "running", label: "explore", startTime },
				{ id: "done", type: "bash", status: "completed", label: "test", startTime, endedAt: startTime },
			]);
			await mount(true);
			// Joining together, the dock's join read folds into the panel's one in flight; then one poll serves both.
			expect(getJobs).toHaveBeenCalledTimes(1);
			expect(container.querySelectorAll("[data-job-id]")).toHaveLength(3);
			expect(dockJobs?.map(job => job.id)).toEqual(["shell"]);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});
			expect(getJobs).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

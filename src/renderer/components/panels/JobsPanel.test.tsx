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

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<JobsPanel />
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
			{ id: "j1", type: "bash", status: "running", label: "bun test --watch", startTime: start },
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
		expect(container.textContent).toContain("Stopping…");
		expect(container.textContent).toContain("Result / error");
		expect(container.textContent).toContain("Updated");
	});

	it("shows the empty state when there are no jobs", async () => {
		installJobs([]);
		await mount();

		expect(container.textContent).toContain("No background jobs running.");
		expect(container.textContent).toContain("Background jobs run async tools");
		expect(container.querySelectorAll("section")).toHaveLength(0);
	});
});

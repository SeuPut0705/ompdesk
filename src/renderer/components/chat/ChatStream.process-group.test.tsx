/**
 * Expanding a huge finished work card: its steps mount a slice at a time, so
 * the click's frame builds the first slice only. All 490 messages of a
 * 245-step card in one commit made a 60 ms frame.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(window, {
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	requestAnimationFrame: () => 0,
	cancelAnimationFrame: () => {},
});
// React DOM must initialize only after the linkedom browser globals exist.
const { createRoot } = await import("react-dom/client");
const { ProcessGroup, STREAMING_WORK_ROW } = await import("./ChatStream");

const STEPS = 400;
const messages: AgentMessage[] = Array.from({ length: STEPS }, (_, index) => ({
	role: "assistant",
	timestamp: 1_000 + index,
	content: [{ type: "toolCall", id: `call-${index}`, name: "bash", arguments: { command: `echo ${index}` } }],
}));
const row = {
	...STREAMING_WORK_ROW,
	messages,
	stepCount: STEPS,
	toolCallIds: messages.map((_, index) => `call-${index}`),
	toolNames: ["bash"],
};

let root: Root;
let container: HTMLElement;
const mounted = () => container.querySelector(".omp-process-group")?.childElementCount ?? 0;
const show = (expanded: boolean) =>
	act(async () =>
		root.render(
			<I18nProvider>
				<ProcessGroup expanded={expanded} onExpandedChange={() => {}} row={row} rowKey="process-huge" />
			</I18nProvider>,
		),
	);

beforeEach(() => {
	vi.useFakeTimers();
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.useRealTimers();
});

describe("expanding a huge finished work card", () => {
	it("mounts the first slice with the click and the rest on later tasks", async () => {
		await show(false);
		await show(true);
		const first = mounted();
		expect(first).toBeGreaterThan(0);
		expect(first).toBeLessThanOrEqual(80);
		for (let step = 0; step < 20 && mounted() < STEPS; step++)
			await act(async () => {
				vi.advanceTimersByTime(20);
			});
		expect(mounted()).toBe(STEPS);
	});

	it("mounts a small card whole with the click", async () => {
		await act(async () =>
			root.render(
				<I18nProvider>
					<ProcessGroup
						expanded
						onExpandedChange={() => {}}
						row={{
							...row,
							messages: messages.slice(0, 12),
							stepCount: 12,
							toolCallIds: row.toolCallIds.slice(0, 12),
						}}
						rowKey="process-small"
					/>
				</I18nProvider>,
			),
		);
		expect(mounted()).toBe(12);
	});
});

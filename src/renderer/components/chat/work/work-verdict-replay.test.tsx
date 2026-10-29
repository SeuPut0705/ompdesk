/**
 * The work card's verdict over real journals: every work card in `e2e/fixtures/work-verdict-corpus.json` (OMPdesk's own
 * sessions, built and redacted by `scripts/work-verdict-corpus.ts`), mounted as the transcript mounts it, and the
 * board's check row after it. One line per card in `__snapshots__/work-verdict-replay.txt`: the card's state, whether
 * it is red, its head facts and its verdict blocks and chips, then what the board's check row says.
 *
 * A change to the verdict rules moves lines here; review each moved card before `vitest -u` takes the new lines.
 * ci.yml's `check` job runs this file as its own step, so a verdict regression fails by name.
 */
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { useMessagesStore } from "../../../stores/messages";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { selectToolEntry, useToolsStore } from "../../../stores/tools";
import { lastCheck } from "../../layout/work-board/session-board";
import { buildHistoryRows, callStops } from "../chat-stream-utils";
import { backgroundJobVerdicts } from "../completion-events";
import { workOutcomes } from "./work-view";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
Object.assign(window, { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
// React DOM and the card must load after the linkedom globals: a static import initializes them too early.
const { createRoot } = await import("react-dom/client");
const { ExecutionGroup } = await import("../ExecutionGroup");

interface Slice {
	id: string;
	cwd: string;
	messages: AgentMessage[];
}

const corpus: Slice[] = JSON.parse(readFileSync("e2e/fixtures/work-verdict-corpus.json", "utf8"));

function cardLine(container: HTMLElement): string {
	const card = container.querySelector(".omp-execution-group");
	const state = card?.getAttribute("data-state") ?? "-";
	const red = card?.getAttribute("data-verdict") === "failed" ? "RED" : "ok";
	const head = (container.querySelector(".omp-execution-group-header")?.getAttribute("aria-label") ?? "").replace(
		/^Steps: /,
		"",
	);
	const findings = [...container.querySelectorAll("[data-work-finding]")].map(
		node =>
			`${node.getAttribute("data-work-finding")}=${(node.getAttribute("aria-label") ?? node.textContent ?? "").replace(/\s+/g, " ").trim()}`,
	);
	return `${state} ${red} | ${head} | ${findings.join(" ; ")}`;
}

describe("work card verdict over real journals", () => {
	it("holds every card's verdict and the board's check row", { timeout: 120_000 }, async () => {
		const container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container as never);
		const root: Root = createRoot(container as unknown as Element);
		const lines: string[] = [];
		for (const slice of corpus) {
			useSubagentsStore.getState().reset();
			useSessionStore.setState({ cwd: slice.cwd });
			useMessagesStore.setState({ messages: slice.messages });
			useToolsStore.getState().reset();
			useToolsStore.getState().hydrateMessages(slice.messages);
			const verdicts = backgroundJobVerdicts(slice.messages);
			const stops = callStops(slice.messages);
			const rows = buildHistoryRows(slice.messages, "compact").flatMap(row => (row.kind === "process" ? [row] : []));
			for (const [index, row] of rows.entries()) {
				if (row.toolCallIds.length === 0) continue;
				await act(async () =>
					root.render(
						<I18nProvider key={`${slice.id}:${index}`}>
							<ExecutionGroup
								expanded={false}
								failureCount={row.failedEvents}
								leadingSkills={row.skills}
								notes={row.notes}
								onExpandedChange={() => {}}
								stepCount={row.stepCount}
								stoppedAt={row.stoppedAt}
								superseded={index < rows.length - 1}
								todoSnapshots={row.todoSnapshots}
								toolCallIds={row.toolCallIds}
							>
								<div />
							</ExecutionGroup>
						</I18nProvider>,
					),
				);
				const tools = useToolsStore.getState();
				const cardEntries = row.toolCallIds.flatMap(key => {
					const entry = selectToolEntry(tools, key);
					return entry ? [[key, entry] as const] : [];
				});
				const until = Math.max(...cardEntries.map(([, entry]) => entry.startTime));
				const sessionSoFar = [...tools.finishedTools].filter(([, entry]) => entry.startTime <= until);
				const turn = workOutcomes(
					cardEntries.map(([toolCallId, entry]) => ({ entry, toolCallId, stoppedAt: stops.get(toolCallId) })),
					undefined,
					slice.cwd,
					verdicts,
				);
				const board = lastCheck(sessionSoFar, turn.commands, slice.cwd, verdicts, stops);
				const boardLine = board
					? `${board.state} ${board.kind}${board.count !== undefined ? ` ${board.count}` : ""} ${board.key ?? "-"}`
					: "-";
				lines.push(`${slice.id}/${index} ${cardLine(container)} | board: ${boardLine}`);
			}
		}
		await act(async () => root.unmount());
		container.remove();
		expect(lines.length).toBeGreaterThan(150);
		await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot("__snapshots__/work-verdict-replay.txt");
	});
});

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { buildHistoryRowKeys, buildHistoryRows } from "./chat-stream-utils";
import { ExecutionGroup } from "./ExecutionGroup";
import { WorkNotes } from "./WorkNotes";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
});
const user: AgentMessage = { role: "user", content: "Start", timestamp: 100 };
const tool: AgentMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "read", name: "read", arguments: {} }],
	timestamp: 200,
};
const irc: AgentMessage = {
	role: "custom",
	customType: "irc:incoming",
	id: "irc",
	content: "IRC content",
	details: { from: "ReaMcp", message: "First line\n**Expanded IRC**" },
	timestamp: 300,
};
const advisor: AgentMessage = {
	role: "custom",
	customType: "advisor",
	id: "advisor",
	content: "Advisor content",
	details: { notes: [{ note: "Check access\n**Full advice**", severity: "concern" }] },
	timestamp: 400,
};
const answer: AgentMessage = { role: "assistant", content: [{ type: "text", text: "Finished" }], timestamp: 500 };

it("folds IRC and advisor into one live and hydrated run without changing row identity at turn end", () => {
	const before = { ...irc, id: "before", timestamp: 150 };
	const after = { ...advisor, id: "after", timestamp: 600 };
	const live = buildHistoryRows([user, before, tool, irc, advisor], "compact");
	const hydrated = buildHistoryRows([user, before, tool, irc, advisor, answer, after], "compact");
	expect(live.map(row => row.kind)).toEqual(["message", "message", "process"]);
	expect(hydrated.map(row => row.kind)).toEqual(["message", "message", "process", "message", "message"]);
	expect(buildHistoryRowKeys(hydrated).slice(0, 3)).toEqual(buildHistoryRowKeys(live));
	for (const rows of [live, hydrated]) {
		const work = rows.find(row => row.kind === "process");
		expect(work?.kind === "process" && work.notes).toEqual([irc, advisor]);
		expect(work?.kind === "process" && work.messages).toEqual([tool]);
	}
});

it("keeps during-run notes folded when a final reply carries its earlier stream-start timestamp", () => {
	const rows = buildHistoryRows([user, tool, irc, advisor, { ...answer, timestamp: 250 }], "compact");
	expect(rows.map(row => row.kind)).toEqual(["message", "process", "message"]);
	const work = rows.find(row => row.kind === "process");
	expect(work?.kind === "process" && work.notes).toEqual([irc, advisor]);
});

it("leaves notes outside tool work and the next user turn standalone", () => {
	const rows = buildHistoryRows(
		[user, irc, answer, { ...user, timestamp: 700 }, { ...advisor, timestamp: 800 }],
		"compact",
	);
	expect(rows.every(row => row.kind === "message")).toBe(true);
});

it("closes note ownership at the first final reply or the next user, not a later assistant row", () => {
	const outside = { ...irc, id: "outside", timestamp: 650 };
	for (const messages of [
		[user, tool, advisor, answer, outside, { ...answer, timestamp: 900 }],
		[user, tool, advisor, { ...user, timestamp: 600 }, outside],
	]) {
		const rows = buildHistoryRows(messages, "compact");
		const work = rows.find(row => row.kind === "process");
		expect(work?.kind === "process" && work.notes).toEqual([advisor]);
		expect(rows.some(row => row.kind === "message" && row.message.id === "outside")).toBe(true);
	}
});

it("shows the latest two notes, expands older ones and a full sanitized card body, with advisor severity", async () => {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<WorkNotes
					messages={[{ ...irc, id: "old", details: { from: "OldAgent", message: "Older note" } }, irc, advisor]}
					live
				/>
			</I18nProvider>,
		),
	);
	expect(container.querySelectorAll("li").length).toBe(2);
	expect(container.textContent).toContain("1 more");
	expect(container.textContent).not.toContain("Older note");
	expect(container.textContent).toContain("concern");
	expect(container.querySelector('[class*="--sc-warning-soft"]')?.textContent).toBe("concern");
	const line = container.querySelector(".omp-work-notes-line");
	await act(async () => line?.dispatchEvent(new Event("click", { bubbles: true })));
	expect(line?.getAttribute("aria-expanded")).toBe("true");
	expect(container.querySelector("strong")?.textContent).toBe("Expanded IRC");
	expect(container.querySelector(".omp-work-notes-body > div")?.getAttribute("class")).toContain(
		"--sc-text-secondary",
	);
	expect(container.querySelector(".omp-custom-turn")).toBeNull();
	await act(async () =>
		container?.querySelector(".omp-work-notes-more")?.dispatchEvent(new Event("click", { bubbles: true })),
	);
	expect(container.querySelectorAll("li").length).toBe(3);
	expect(container.textContent).toContain("Older note");
});

it("renders nothing when empty and keeps an expanded note mounted when another note arrives", async () => {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	const render = async (messages: readonly AgentMessage[]) =>
		act(async () =>
			root?.render(
				<I18nProvider>
					<WorkNotes messages={messages} live />
				</I18nProvider>,
			),
		);
	await render([]);
	expect(container.querySelector(".omp-work-notes")).toBeNull();
	await render([advisor]);
	const line = container.querySelector(".omp-work-notes-line");
	await act(async () => line?.dispatchEvent(new Event("click", { bubbles: true })));
	const body = container.querySelector(".omp-work-notes-body");
	await render([advisor, irc]);
	expect(container.querySelector(".omp-work-notes-body")).toBe(body);
	expect(line?.getAttribute("aria-expanded")).toBe("true");
	expect(container.querySelectorAll("li").length).toBe(2);
});

it("expands skill and collaboration messages without adding standalone card frames", async () => {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<WorkNotes
					messages={[
						{
							role: "custom",
							id: "skill",
							customType: "skill-prompt",
							content: "**Skill instructions**",
							details: { name: "review" },
						},
						{
							role: "custom",
							id: "collab",
							customType: "collab-prompt",
							content: "**Guest instructions**",
							details: { from: "GuestAgent" },
						},
					]}
				/>
			</I18nProvider>,
		),
	);
	const lines = container.querySelectorAll(".omp-work-notes-line");
	await act(async () => {
		for (const line of lines) line.dispatchEvent(new Event("click", { bubbles: true }));
	});
	expect([...container.querySelectorAll("strong")].map(element => element.textContent)).toEqual([
		"Skill instructions",
		"Guest instructions",
	]);
	expect(container.querySelector(".omp-transcript-content")).toBeNull();
});

it("keeps notes inside the same execution card when live work finishes", async () => {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	const render = async (live: boolean) =>
		act(async () =>
			root?.render(
				<I18nProvider>
					<ExecutionGroup
						expanded={false}
						live={live}
						onExpandedChange={() => {}}
						stepCount={1}
						toolCallIds={[]}
						notes={[irc, advisor]}
					>
						<span>Execution details</span>
					</ExecutionGroup>
				</I18nProvider>,
			),
		);
	await render(true);
	const card = container.querySelector(".omp-live-step");
	const notes = card?.querySelector(".omp-work-notes");
	expect(notes?.querySelectorAll("li").length).toBe(2);
	await render(false);
	expect(container.querySelector(".omp-live-step")).toBe(card);
	expect(card?.querySelector(".omp-work-notes")).toBe(notes);
	expect(container.querySelector(".omp-custom-turn")).toBeNull();
});

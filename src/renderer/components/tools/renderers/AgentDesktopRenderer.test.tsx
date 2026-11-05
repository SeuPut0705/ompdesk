/**
 * agent-desktop's MCP tools in the transcript: what the card shows for each kind of answer (envelope parsing in
 * `lib/agent-desktop.ts`), that both a direct call and a `write xd://` call reach this renderer, and that an answer
 * which is no envelope reads like any other MCP tool's instead of throwing. Linkedom harness, like FindRenderer.test.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { getToolHeader, getToolRenderer, getToolSummary } from "../index";
import { AgentDesktopRenderer } from "./AgentDesktopRenderer";

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

const PREFIX = "mcp__agent_desktop_";

let container: HTMLElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

const text = () => container.textContent ?? "";
const rows = () => [...container.querySelectorAll("[data-tree-id]")].map(row => row.textContent);

/** One tool answer as stock hands it to a renderer: the envelope as text, and again as `structuredContent`. */
function answer(envelope: unknown, extra: unknown[] = []) {
	return {
		content: [{ type: "text", text: JSON.stringify(envelope) }, ...extra],
		details: { structuredContent: envelope },
	};
}

const node = (role: string, ref: string, children: unknown[] = [], name?: string) => ({
	role,
	ref_id: ref,
	...(name ? { name } : {}),
	...(children.length > 0 ? { children } : {}),
});

describe("AgentDesktopRenderer", () => {
	it("draws a snapshot as an element tree with refs and folds the levels below the second", async () => {
		const tree = node("window", "@e1", [
			node("group", "@e2", [node("group", "@e3", [node("button", "@e4", [], "Save")])]),
		]);
		await mount(
			<AgentDesktopRenderer
				args={{ app: "Notes" }}
				result={answer({
					version: "2.6",
					ok: true,
					command: "snapshot",
					data: { app: "Notes", snapshot_id: "s1", ref_count: 4, tree },
				})}
			/>,
		);

		expect(text()).toContain("Notes");
		expect(text()).toContain("4 refs");
		expect(rows()).toEqual(["window @e1", "group @e2", "group @e3"]);

		const inner = container.querySelector('[data-tree-id="$.0.0.0"]');
		await act(async () => {
			inner?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(rows()).toEqual(["window @e1", "group @e2", "group @e3", 'button "Save" @e4']);
	});

	it("keeps a real snapshot's values, states and cut-short branches on their rows, and says when it is partial", async () => {
		// The shape agent-desktop 1.2.0 printed for TextEdit (`snapshot --app TextEdit --skeleton -i --compact`).
		const tree = {
			role: "window",
			name: "Untitled 3",
			children: [
				{
					role: "scrollarea",
					ref_id: "@s1:e1",
					native_id: { kind: "ax_identifier", value: "_NS:8" },
					available_actions: ["Scroll", "SetFocus"],
					children: [
						{
							role: "textfield",
							ref_id: "@s1:e2",
							states: ["focused"],
							value: "agent-desktop smoke 1793909565077",
							available_actions: ["SetValue", "TypeText"],
						},
						{ role: "scrollbar", ref_id: "@s1:e3", states: ["disabled"], value: "0" },
					],
				},
				{ role: "group", name: "Format", children_count: 9 },
				{ role: "toolbar", subtree_truncated: true },
			],
		};
		await mount(
			<AgentDesktopRenderer
				args={{ app: "TextEdit" }}
				result={answer({
					version: "2.6",
					ok: true,
					command: "snapshot",
					data: { app: "TextEdit", snapshot_id: "s1", ref_count: 3, complete: false, tree },
				})}
			/>,
		);

		expect(rows()).toContain('textfield = "agent-desktop smoke 1793909565077" @s1:e2 [focused]');
		expect(rows()).toContain('scrollbar = "0" @s1:e3 [disabled]');
		expect(rows()).toContain('group "Format" (9 not read)');
		expect(rows()).toContain("toolbar (cut short)");
		expect(container.querySelector("[data-agent-desktop-partial]")?.textContent).toContain("Partial tree");
		// Everything else the envelope said (actions, native ids) is one fold away.
		expect(text()).toContain("Full result");
	});

	it("shows a screenshot as an image the reader can open", async () => {
		await mount(
			<AgentDesktopRenderer
				args={{ app: "Notes" }}
				result={answer({ ok: true, command: "screenshot", data: { app: "Notes" } }, [
					{ type: "image", data: "cG5n", mimeType: "image/png" },
				])}
			/>,
		);

		expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,cG5n");
	});

	it("shows a failed call's code, message, suggestion and whether trying again is safe", async () => {
		await mount(
			<AgentDesktopRenderer
				args={{ ref_id: "@e9" }}
				isError
				result={answer({
					ok: false,
					command: "click",
					error: {
						code: "STALE_REF",
						message: "Ref @e9 is no longer in the tree",
						suggestion: "Take a new snapshot, then click again.",
						disposition: { delivery: "not_delivered", retry: "safe" },
					},
				})}
			/>,
		);

		expect(text()).toContain("STALE_REF: Ref @e9 is no longer in the tree");
		expect(text()).toContain("Take a new snapshot, then click again.");
		expect(text()).toContain("Not delivered · Safe to retry");
	});

	it("says an action went through and whether the input was delivered", async () => {
		await mount(
			<AgentDesktopRenderer
				args={{ ref_id: "@e2" }}
				result={answer({
					ok: true,
					command: "click",
					data: { disposition: { delivery: "delivered_verified", retry: "unsafe" } },
				})}
			/>,
		);

		expect(text()).toContain("Done · Delivered and verified");
	});

	it("reads the envelope from the text block when stock kept no structured content", async () => {
		await mount(
			<AgentDesktopRenderer
				args={{}}
				result={{
					content: [
						{
							type: "text",
							text: '{"ok":true,"command":"list_windows","data":{"windows":[{"id":"w-1","title":"Inbox","app":"Mail"}]}}',
						},
					],
				}}
			/>,
		);

		expect(rows()).toEqual(['window "Inbox" w-1']);
	});

	it("keeps the guide folded until it is asked for", async () => {
		await mount(
			<AgentDesktopRenderer
				args={{ name: "desktop" }}
				result={answer({ ok: true, command: "skills_get", data: { content: "# Desktop guide" } })}
			/>,
		);

		expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
	});

	it("says it is acting while the call has no result yet", async () => {
		await mount(<AgentDesktopRenderer args={{}} isPartial result={undefined} />);

		expect(text()).toContain("Acting…");
	});

	it("falls back to the generic MCP body when the answer is no envelope", async () => {
		await mount(
			<AgentDesktopRenderer
				args={{}}
				isError
				result={{ content: [{ type: "text", text: "Cannot run agent-desktop: no such file" }] }}
			/>,
		);
		expect(text()).toContain("Cannot run agent-desktop: no such file");
		await act(async () => root.unmount());
		container.remove();

		await mount(
			<AgentDesktopRenderer args={{}} result={{ content: [{ type: "text", text: '{"ok":true,"command":"sna' }] }} />,
		);
		expect(text()).toContain('{"ok":true,"command":"sna');
	});
});

describe("agent-desktop tool calls in the registry", () => {
	it("renders a `write xd://` call through this renderer", async () => {
		const Write = getToolRenderer("write");
		const envelope = {
			ok: true,
			command: "click",
			data: { disposition: { delivery: "delivered_unverified", retry: "unsafe" } },
		};
		await mount(
			<Write
				args={{ path: `xd://${PREFIX}desktop_click`, content: '{"ref_id":"@e5"}' }}
				result={{
					content: [{ type: "text", text: JSON.stringify(envelope) }],
					details: {
						xdev: {
							tool: `${PREFIX}desktop_click`,
							mode: "execute",
							args: { ref_id: "@e5" },
							inner: { structuredContent: envelope },
						},
					},
				}}
			/>,
		);

		// The renderer is its own chunk: the call shows once it loaded.
		await vi.waitFor(() => expect(text()).toContain("Done · Delivered, not verified"));
	});

	it("heads a call as the desktop command with its target, with the computer-use pointer", () => {
		const direct = getToolHeader(`${PREFIX}desktop_type`, { ref_id: "@e5", text: "hello" });
		expect(direct.labelKey).toBe("tools.label.agentDesktop");
		expect(direct.labelParams).toEqual({ command: "type" });
		expect(direct.target).toBe("@e5 “hello”");
		expect(direct.icon).toBe(getToolHeader("computer", {}).icon);

		const device = getToolHeader("write", {
			path: `xd://${PREFIX}desktop_list_windows`,
			content: '{"app":"Safari"}',
		});
		expect(device.labelParams).toEqual({ command: "list windows" });
		expect(device.target).toBe("Safari");
		expect(getToolSummary(`${PREFIX}desktop_press`, { combo: "cmd+s", app: "Notes" })).toBe("Notes cmd+s");
	});
});

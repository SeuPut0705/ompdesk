/**
 * The MCP server row says why a server is off, or that it needs a sign-in, in one muted line under the target and
 * puts the fix on that line as a button (never only in the ⋯ menu); the button fires the card action the parent
 * handles.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpOffReason } from "../../../../../resources/gui-bridge/extensions/mcp-contracts";
import type { RpcMcpServerInfo } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { type McpCardAction, type McpReauthPhase, McpServerCard } from "./McpServerCard";

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

let root: Root | null = null;

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

function server(partial: Partial<RpcMcpServerInfo>): RpcMcpServerInfo {
	return {
		name: "docs",
		transport: "http",
		status: "disconnected",
		toolCount: 0,
		enabled: true,
		authed: false,
		url: "https://docs.test/mcp",
		...partial,
	};
}

async function mount(
	fixture: RpcMcpServerInfo,
	options: { enabled?: boolean; reauth?: McpReauthPhase | null } = {},
): Promise<Mock> {
	const onMenuAction = vi.fn<(action: McpCardAction) => void>();
	root = createRoot(document.body as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<McpServerCard
					busy={false}
					disabled={false}
					enabled={options.enabled ?? fixture.enabled}
					onDismissTest={() => {}}
					onMenuAction={onMenuAction}
					onReauthCancel={() => {}}
					reauth={options.reauth ?? null}
					server={fixture}
					testing={false}
					testView={null}
				/>
			</I18nProvider>,
		);
	});
	return onMenuAction;
}

type Mock = ReturnType<typeof vi.fn<(action: McpCardAction) => void>>;

const note = (): Element | null => document.querySelector("[data-mcp-note]");
/** The fix buttons on the note line; the (i) glyph is a button too but explains, it does not act. */
const noteButtons = (): Element[] =>
	[...(note()?.querySelectorAll("button") ?? [])].filter(item => !item.hasAttribute("data-setting-info"));

async function click(element: Element | undefined): Promise<void> {
	if (!element) throw new Error("click: element missing");
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true }));
	});
}

describe("McpServerCard reason line", () => {
	const OFF_CASES: Array<{
		reason: McpOffReason;
		text: string;
		button: { label: string; action: McpCardAction } | null;
	}> = [
		{
			reason: { kind: "otherTool", tool: "Codex", provider: "codex" },
			text: "Found in Codex's config · omp doesn't use it by default",
			button: { label: "Use in omp", action: "adopt" },
		},
		{
			reason: { kind: "offInTool", tool: "Codex", provider: "codex" },
			text: "Turned off in Codex's config",
			button: { label: "Turn on", action: "enable" },
		},
		{
			reason: { kind: "toolOff", tool: "Codex", provider: "codex" },
			text: "Reading Codex's config is turned off in omp",
			button: null,
		},
		{ reason: { kind: "disabled" }, text: "Turned off by you", button: { label: "Turn on", action: "enable" } },
		{ reason: { kind: "projectConfigOff" }, text: "Project MCP config is turned off", button: null },
	];

	for (const { reason, text, button } of OFF_CASES) {
		it(`says why a ${reason.kind} server is off${button ? ` and offers "${button.label}"` : " with no button"}`, async () => {
			const onMenuAction = await mount(server({ enabled: false, offReason: reason }));
			expect(note()?.textContent).toContain(text);
			if (!button) {
				expect(noteButtons()).toHaveLength(0);
				return;
			}
			expect(noteButtons().map(item => item.textContent?.trim())).toEqual([button.label]);
			expect(onMenuAction).not.toHaveBeenCalled();
			await click(noteButtons()[0]);
			expect(onMenuAction).toHaveBeenCalledExactlyOnceWith(button.action);
		});
	}

	it("keeps the copy-one-server explanation behind an info glyph, not in the line", async () => {
		await mount(server({ enabled: false, offReason: { kind: "otherTool", tool: "Codex", provider: "codex" } }));
		const info = note()?.querySelector("[data-setting-info]");
		expect(info).not.toBeNull();
		expect(note()?.textContent).toContain("~/.omp/agent/mcp.json");
		expect(note()?.querySelector(".sr-only")?.textContent).toContain("Codex's other servers, skills and rules");
	});

	it("has no line for a server turned off without a known reason, nor for a healthy one", async () => {
		await mount(server({ enabled: false }));
		expect(note()).toBeNull();
		await act(async () => root?.unmount());
		root = null;
		await mount(server({ status: "connected", toolCount: 3, authState: "authorized" }));
		expect(note()).toBeNull();
	});

	it("follows the parent's optimistic enable state, not the stale offReason", async () => {
		await mount(server({ enabled: false, offReason: { kind: "disabled" } }), { enabled: true });
		expect(note()).toBeNull();
	});

	it("tells an enabled server also found in another tool's config", async () => {
		await mount(server({ status: "connected", toolCount: 12, authState: "authorized", alsoIn: "Claude Code" }));
		expect(note()?.textContent).toContain("Taken from Claude Code's config");
		expect(noteButtons()).toHaveLength(0);
	});
});

describe("McpServerCard sign-in", () => {
	it("shows the state and a Sign in button for a server that needs a login, and fires reauth", async () => {
		const onMenuAction = await mount(server({ authState: "required", lastError: "HTTP 401: Unauthorized" }));
		expect(note()?.textContent).toContain("Sign-in needed");
		expect(noteButtons().map(item => item.textContent?.trim())).toEqual(["Sign in"]);
		await click(noteButtons()[0]);
		expect(onMenuAction).toHaveBeenCalledExactlyOnceWith("reauth");
	});

	it("words an expired sign-in as expired", async () => {
		await mount(server({ authState: "expired" }));
		expect(note()?.textContent).toContain("Sign-in expired");
		expect(noteButtons()).toHaveLength(1);
	});

	it("offers no Sign in for an authorized or unauthenticated server", async () => {
		for (const authState of ["authorized", "none", undefined] as const) {
			await mount(server({ authState }));
			expect(noteButtons()).toHaveLength(0);
			await act(async () => root?.unmount());
			root = null;
			while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
		}
	});

	it("offers no Sign in on a server that is off, only its reason's fix", async () => {
		await mount(server({ enabled: false, authState: "required", offReason: { kind: "disabled" } }));
		expect(noteButtons().map(item => item.textContent?.trim())).toEqual(["Turn on"]);
	});

	it("hides Sign in while a sign-in is already running", async () => {
		await mount(server({ authState: "required" }), { reauth: "running" });
		expect(note()).toBeNull();
		expect(document.body.textContent).toContain("Authorization in progress");
	});

	it("keeps the ⋯ menu beside the inline button", async () => {
		await mount(server({ authState: "required" }));
		expect(document.querySelector('button[aria-label="Actions for docs"]')).not.toBeNull();
	});
});

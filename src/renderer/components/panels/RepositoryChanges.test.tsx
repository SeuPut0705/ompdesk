/**
 * RepositoryChanges refresh contract (linkedom, same pattern as
 * QueuePanel.test.tsx): the header refresh re-reads the checkout WITHOUT
 * wiping the file list. A reload is not an initial load — if the second read
 * fails, the rows that loaded successfully stay on screen under the error,
 * instead of the panel collapsing to "Loading" and then nothing.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcGitChanges } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { RepositoryChanges } from "./RepositoryChanges";

// What the panel last read of this checkout (lib/last-read.ts): a test seeds it; nothing is written back, so the
// polling tests below count only the panel's own timers.
const lastReads = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../../lib/last-read", () => ({ lastRead: () => lastReads.value, rememberRead: () => {} }));

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");

interface TestElement {
	disabled: boolean;
	textContent: string | null;
	remove: () => void;
	dispatchEvent: (event: object) => boolean;
	getAttribute: (name: string) => string | null;
}

function changes(...paths: string[]): RpcGitChanges {
	return {
		isRepo: true,
		root: "/work",
		base: "main",
		files: paths.map(path => ({ path, status: "M" })),
		truncated: false,
	};
}

let getGitChanges: Mock<() => Promise<unknown>>;
let getGitFingerprint: Mock<(root?: string) => Promise<unknown>>;
/** What the next fingerprint poll answers; a test moves it to say "the checkout changed". */
let fingerprint = "fp-1";

function installMockOmp(next: () => Promise<unknown>, extra: object = {}): void {
	getGitChanges = vi.fn(next);
	fingerprint = "fp-1";
	getGitFingerprint = vi.fn(async () => ({ success: true, data: { fingerprint } }));
	Object.assign(window, { omp: { rpc: { getGitChanges, getGitFingerprint, ...extra } } });
}

let root: ReturnType<typeof createRoot>;
let container: TestElement;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<RepositoryChanges />
			</I18nProvider>,
		);
	});
	await flush();
}

function queryAll(selector: string): TestElement[] {
	return Array.from(document.querySelectorAll(selector)) as unknown as TestElement[];
}

function bodyText(): string {
	return document.body.textContent ?? "";
}

/** Dispatch inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}

async function click(element: TestElement): Promise<void> {
	await dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
}

function refreshButton(): TestElement {
	const match = queryAll("button").find(button => button.getAttribute("aria-label") === "Refresh");
	if (!match) throw new Error("refresh button not found");
	return match;
}

afterEach(async () => {
	lastReads.value = undefined;
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
});

describe("RepositoryChanges", () => {
	it("paints the last list of this checkout at the first frame, before the read answers", async () => {
		lastReads.value = changes("src/seeded.ts");
		installMockOmp(() => new Promise(() => {}));
		await mount();
		expect(bodyText()).toContain("seeded.ts");
		expect(queryAll("[data-skeleton-row]")).toHaveLength(0);
	});

	it("opens a file with counts and navigation, hides git metadata, and returns to the list", async () => {
		const data = changes("src/a.ts", "src/b.ts");
		data.files[0] = { path: "src/a.ts", status: "M", added: 1, removed: 1 };
		const getGitDiff = vi.fn(async (path: string) => ({
			success: true,
			data: {
				path,
				kind: "text",
				truncated: false,
				diff: "diff --git a/src/a.ts b/src/a.ts\nindex 123..456 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
			},
		}));
		Object.assign(window, {
			omp: { rpc: { getGitChanges: vi.fn(async () => ({ success: true, data })), getGitDiff } },
		});
		await mount();
		const first = queryAll("button").find(button => button.getAttribute("title") === "src/a.ts")!;
		await click(first);
		await flush();
		expect(getGitDiff).toHaveBeenCalledWith("src/a.ts");
		// The open file is the list's current item, not a toggle a screen reader reads as "pressed".
		const opened = document.querySelector('button[title="src/a.ts"]');
		expect(opened?.getAttribute("aria-current")).toBe("true");
		expect(opened?.hasAttribute("aria-pressed")).toBe(false);
		expect(bodyText()).toContain("+1");
		expect(bodyText()).toContain("−1");
		expect(bodyText()).toContain("old");
		expect(bodyText()).toContain("new");
		expect(bodyText()).not.toContain("index 123");
		const next = queryAll("button").find(button => button.getAttribute("aria-label") === "Next file")!;
		await click(next);
		await flush();
		expect(getGitDiff).toHaveBeenLastCalledWith("src/b.ts");
		const back = queryAll("button").find(button => button.getAttribute("aria-label") === "Back to changed files")!;
		await click(back);
		expect(document.querySelector(".omp-changes-preview")).toBeNull();
		expect(document.querySelector('button[title="src/a.ts"]')).not.toBeNull();
	});

	it("sizes both line-number gutters for the diff's longest number", async () => {
		const getGitDiff = vi.fn(async (path: string) => ({
			success: true,
			data: {
				path,
				kind: "text",
				truncated: false,
				diff: "--- a/big.ts\n+++ b/big.ts\n@@ -1523,2 +1523,2 @@\n ctx\n-old\n+new\n",
			},
		}));
		Object.assign(window, {
			omp: { rpc: { getGitChanges: vi.fn(async () => ({ success: true, data: changes("big.ts") })), getGitDiff } },
		});
		await mount();
		await click(queryAll("button").find(button => button.getAttribute("title") === "big.ts")!);
		await flush();
		// 1524 needs four digits; a three-digit gutter wrapped it onto a second line.
		expect(document.querySelector(".omp-pane-diff")?.getAttribute("style")).toContain("--omp-gutter-digits:4");
	});
	it("keeps the loaded file list on screen when a refresh fails", async () => {
		installMockOmp(async () => ({
			type: "response",
			command: "get_git_changes",
			success: true,
			data: changes("src/a.ts"),
		}));
		await mount();
		expect(document.querySelector('button[title="src/a.ts"]')).not.toBeNull();
		expect(getGitChanges).toHaveBeenCalledTimes(1);

		getGitChanges.mockResolvedValueOnce({
			type: "response",
			command: "get_git_changes",
			success: false,
			error: "git status failed",
		});
		await click(refreshButton());
		await flush();

		// The user was looking at real changes; a failed re-read may not turn the
		// panel into an empty "clean tree".
		expect(document.querySelector('button[title="src/a.ts"]')).not.toBeNull();
		expect(bodyText()).not.toContain("No net changes in this checkout.");
		expect(bodyText()).toContain("git status failed");
	});

	it("replaces the rows when the retried refresh succeeds", async () => {
		installMockOmp(async () => ({
			type: "response",
			command: "get_git_changes",
			success: true,
			data: changes("src/a.ts"),
		}));
		await mount();
		getGitChanges
			.mockResolvedValueOnce({
				type: "response",
				command: "get_git_changes",
				success: false,
				error: "git status failed",
			})
			.mockResolvedValueOnce({
				type: "response",
				command: "get_git_changes",
				success: true,
				data: changes("src/b.ts"),
			});
		await click(refreshButton());
		await flush();
		expect(bodyText()).toContain("git status failed");

		await click(refreshButton());
		await flush();

		expect(document.querySelector('button[title="src/b.ts"]')).not.toBeNull();
		expect(document.querySelector('button[title="src/a.ts"]')).toBeNull();
		expect(bodyText()).not.toContain("git status failed");
	});

	const answer = (...paths: string[]) => ({
		type: "response",
		command: "get_git_changes",
		success: true,
		data: changes(...paths),
	});

	it("reads the checkout again when the window comes back after the checkout changed, so an agent's edits show without a click", async () => {
		installMockOmp(async () => answer("src/a.ts"));
		await mount();
		getGitChanges.mockImplementation(async () => answer("src/a.ts", "src/b.ts"));
		fingerprint = "fp-2";
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await flush();
		expect(document.querySelector('button[title="src/b.ts"]')).not.toBeNull();
	});

	async function mountWithTimers(): Promise<void> {
		container = document.createElement("div") as unknown as TestElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root.render(
				<I18nProvider>
					<RepositoryChanges />
				</I18nProvider>,
			);
			await vi.advanceTimersByTimeAsync(0);
		});
	}
	const advance = (ms: number) =>
		act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});

	it("polls only the cheap fingerprint while the checkout is unchanged, and reads everything again once it moves", async () => {
		vi.useFakeTimers();
		try {
			installMockOmp(async () => answer("src/a.ts"));
			await mountWithTimers();
			expect(getGitChanges).toHaveBeenCalledTimes(1);
			const loads = getGitFingerprint.mock.calls.length;
			await advance(10_000);
			expect(getGitFingerprint.mock.calls.length).toBeGreaterThan(loads);
			expect(getGitChanges).toHaveBeenCalledTimes(1);

			getGitChanges.mockImplementation(async () => answer("src/a.ts", "src/b.ts"));
			fingerprint = "fp-2";
			await advance(4_000);
			expect(document.querySelector('button[title="src/b.ts"]')).not.toBeNull();
			expect(getGitChanges).toHaveBeenCalledTimes(2);
			// The new fingerprint is the baseline now: the next ticks do not read everything again.
			await advance(10_000);
			expect(getGitChanges).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("passes the root of the last full read to every later fingerprint, so main skips asking git for it", async () => {
		vi.useFakeTimers();
		try {
			installMockOmp(async () => answer("src/a.ts"));
			await mountWithTimers();
			// The first read knows no root yet.
			expect(getGitFingerprint.mock.calls[0]).toEqual([undefined]);
			await advance(10_000);
			const polls = getGitFingerprint.mock.calls.slice(1);
			expect(polls.length).toBeGreaterThan(0);
			for (const call of polls) expect(call).toEqual(["/work"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops polling while the window is hidden and checks at once when it shows again", async () => {
		vi.useFakeTimers();
		try {
			installMockOmp(async () => answer("src/a.ts"));
			await mountWithTimers();
			Object.defineProperty(document, "hidden", { configurable: true, value: true });
			await act(async () => {
				document.dispatchEvent(new Event("visibilitychange"));
			});
			const idle = getGitFingerprint.mock.calls.length;
			expect(vi.getTimerCount()).toBe(0);
			await advance(30_000);
			expect(getGitFingerprint.mock.calls.length).toBe(idle);

			Object.defineProperty(document, "hidden", { configurable: true, value: false });
			await act(async () => {
				document.dispatchEvent(new Event("visibilitychange"));
			});
			expect(getGitFingerprint.mock.calls.length).toBe(idle + 1);
			expect(vi.getTimerCount()).toBe(1);
		} finally {
			Reflect.deleteProperty(document, "hidden");
			vi.useRealTimers();
		}
	});

	it("stops polling once the list leaves the screen (a closed sheet unmounts it)", async () => {
		vi.useFakeTimers();
		try {
			installMockOmp(async () => answer("src/a.ts"));
			await mountWithTimers();
			expect(vi.getTimerCount()).toBe(1);
			await act(async () => root.unmount());
			const calls = getGitFingerprint.mock.calls.length;
			expect(vi.getTimerCount()).toBe(0);
			await advance(30_000);
			expect(getGitFingerprint.mock.calls.length).toBe(calls);
			await mountWithTimers();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not reload in a loop after a failed read: it waits for the checkout to change again", async () => {
		vi.useFakeTimers();
		try {
			installMockOmp(async () => answer("src/a.ts"));
			await mountWithTimers();
			getGitChanges.mockImplementation(async () => ({ success: false, error: "git status failed" }));
			fingerprint = "fp-2";
			await advance(4_000);
			expect(bodyText()).toContain("git status failed");
			const attempts = getGitChanges.mock.calls.length;
			await advance(20_000);
			expect(getGitChanges.mock.calls.length).toBe(attempts);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the open diff on screen while a reload fetches the new one", async () => {
		vi.useFakeTimers();
		try {
			const diff = (text: string) => ({
				success: true,
				data: {
					path: "src/a.ts",
					kind: "text",
					truncated: false,
					diff: `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+${text}\n`,
				},
			});
			const second = Promise.withResolvers<unknown>();
			const getGitDiff = vi
				.fn<(path: string) => Promise<unknown>>()
				.mockResolvedValueOnce(diff("first"))
				.mockReturnValueOnce(second.promise);
			installMockOmp(async () => answer("src/a.ts"), { getGitDiff });
			await mountWithTimers();
			await click(queryAll("button").find(button => button.getAttribute("title") === "src/a.ts")!);
			await advance(0);
			expect(bodyText()).toContain("first");

			fingerprint = "fp-2";
			await advance(4_000);
			expect(getGitDiff).toHaveBeenCalledTimes(2);
			// The second diff has not arrived: the first stays, no blank panel in between.
			expect(bodyText()).toContain("first");
			await act(async () => {
				second.resolve(diff("second"));
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(bodyText()).toContain("second");
		} finally {
			vi.useRealTimers();
		}
	});
});

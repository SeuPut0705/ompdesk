import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";

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

const { createRoot } = await import("react-dom/client");
const { BashRenderer } = await import("./BashRenderer");
const { useUiStore } = await import("../../../stores/ui");

let container: HTMLElement;
let root: Root;
const realLocalStorage = (globalThis as Record<string, unknown>).localStorage;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

/** Force the persisted language the provider seeds itself from. */
function setLanguage(lang: "en" | "ko"): void {
	(globalThis as Record<string, unknown>).localStorage = {
		getItem: (key: string) => (key === "omp.lang" ? lang : null),
		setItem: () => {},
	};
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	(globalThis as Record<string, unknown>).localStorage = realLocalStorage;
});

function bashResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text", text }], details };
}

describe("BashRenderer", () => {
	it("states the truncation notice in the UI language", async () => {
		const truncated = bashResult("line 1", { meta: { truncation: { totalLines: 500, outputLines: 120 } } });
		await mount(<BashRenderer args={{ command: "seq 500" }} result={truncated} />);
		expect(container.textContent).toContain("[Showing 120 of 500 lines]");
		await act(async () => root.unmount());
		container.remove();

		setLanguage("ko");
		await mount(
			<BashRenderer
				args={{ command: "seq 500" }}
				result={bashResult("line 1", {
					meta: { truncation: { totalLines: 500, shownRange: { start: 381, end: 500 } } },
				})}
			/>,
		);
		expect(container.textContent).toContain("[전체 500줄 중 381-500줄을 보여줘요]");
	});

	it("renders SGR-colored output as styled spans instead of raw escapes", async () => {
		await mount(
			<BashRenderer
				args={{ command: "vitest run" }}
				result={bashResult("\x1b[32m✓ 12 passed\x1b[0m, \x1b[31m✗ 1 failed\x1b[0m")}
			/>,
		);
		const spans = [...container.querySelectorAll("span")].filter(el => el.getAttribute("style")?.includes("color"));
		expect(spans.length).toBeGreaterThanOrEqual(2);
		expect(container.textContent).toContain("✓ 12 passed, ✗ 1 failed");
		expect(container.textContent).not.toContain("[32m");
	});

	it("restates the exit and wall-time trailer as badges on the command line, never raw", async () => {
		await mount(
			<BashRenderer
				args={{ command: "false" }}
				result={bashResult("boom output\n\nWall time: 0.42 seconds\n\nCommand exited with code 1", {
					exitCode: 1,
					wallTimeMs: 420,
					timeoutSeconds: 300,
				})}
				isError
			/>,
		);
		const prompt = container.querySelector(".omp-bash-prompt");
		expect(container.textContent).toContain("boom output");
		expect(prompt?.querySelector(".omp-bash-badge")?.textContent).toBe("exit 1");
		expect(prompt?.querySelector(".omp-bash-elapsed")?.textContent).toBe("420ms");
		expect(prompt?.querySelector(".omp-bash-elapsed")?.getAttribute("title")).toBe("Wall time");
		for (const raw of ["Command exited with code", "Wall time:", "Wall:", "Timeout:", "Exit:", "["]) {
			expect(container.textContent).not.toContain(raw);
		}
	});

	it("states the timeout and elapsed time in the UI language", async () => {
		setLanguage("ko");
		await mount(
			<BashRenderer
				args={{ command: "sleep 9" }}
				result={bashResult("tick\n\nWall time: 5.01 seconds\n\n[Command timed out after 5 seconds]", {
					timedOut: true,
					wallTimeMs: 5010,
					timeoutSeconds: 5,
				})}
				isError
			/>,
		);
		const badges = [...container.querySelectorAll(".omp-bash-prompt > span")].slice(2).map(el => el.textContent);
		expect(badges).toEqual(["시간 초과", "5.0초"]);
		expect(container.textContent).not.toContain("Command timed out");
	});

	it("does not repeat a one-line command the row shows whole, and keeps its exit code and wall time", async () => {
		const run = (
			command: string,
			rowShowsTarget: boolean,
			details: Record<string, unknown> = {},
			text = "listing",
		) => <BashRenderer args={{ command }} result={bashResult(text, details)} rowShowsTarget={rowShowsTarget} />;
		await mount(run("ls -la", true, { exitCode: 2, wallTimeMs: 420 }));
		expect(container.textContent).not.toContain("ls -la");
		expect(container.querySelector(".omp-bash-prompt .omp-bash-badge")?.textContent).toBe("exit 2");
		expect(container.querySelector(".omp-bash-prompt .omp-bash-elapsed")?.textContent).toBe("420ms");
		expect(container.textContent).toContain("listing");
		await mount(run("ls -la", true));
		expect(container.querySelector(".omp-bash-prompt")).toBeNull();
		expect(container.textContent).toBe("listing");
		// Nothing printed and nothing left to say: the body says so instead of opening to nothing.
		await mount(run("touch a", true, {}, ""));
		expect(container.textContent).toBe("(no output)");
		// A clipped row, or a command whose later lines the row never shows, keeps the command in the body.
		await mount(run("ls -la", false));
		expect(container.querySelector(".omp-bash-prompt")?.textContent).toContain("ls -la");
		await mount(run("cd src\nls -la", true));
		expect(container.querySelector(".omp-bash-prompt")?.textContent).toContain("ls -la");
	});

	it("strips the background-job trailer and restates the job id", async () => {
		await mount(
			<BashRenderer
				args={{ command: "npm run dev" }}
				result={bashResult("server ready\nBackgrounded as job bg-7; result will be delivered automatically.", {
					async: { state: "running", jobId: "bg-7" },
				})}
			/>,
		);
		expect(container.textContent).toContain("server ready");
		expect(container.textContent).not.toContain("result will be delivered automatically");
		expect(container.querySelector(".omp-bash-notes")?.textContent).toBe("Background job bg-7");
	});

	// The same forms stock's own isBackgroundNotice accepts (pi-tui tools/bash.ts formatBackgroundNotice).
	it.each([
		"Backgrounded as job bg_1 (killed once it has run 120s in total; `timeout: 0` disables the deadline); its output is injected into the conversation as a follow-up the moment it finishes. Do NOT poll for it.",
		"Backgrounded as job bg_1 (no deadline); its output is injected into the conversation as a follow-up the moment it finishes.",
		"Backgrounded as job bg_1; result will be delivered automatically.",
	])("strips stock's background notice in any of its wordings: %s", async notice => {
		await mount(
			<BashRenderer
				args={{ command: "sleep 60" }}
				result={bashResult(`started\n${notice}`, { async: { state: "running", jobId: "bg_1" } })}
			/>,
		);
		expect(container.textContent).toContain("started");
		expect(container.textContent).not.toContain("Backgrounded as job");
		expect(container.querySelector(".omp-bash-notes")?.textContent).toBe("Background job bg_1");
	});

	it("keeps a line that only looks like another job's notice", async () => {
		await mount(
			<BashRenderer
				args={{ command: "echo" }}
				result={bashResult("Backgrounded as job bg_10; elsewhere", { async: { state: "running", jobId: "bg_1" } })}
			/>,
		);
		expect(container.textContent).toContain("Backgrounded as job bg_10; elsewhere");
	});

	it("strips the wall-time and clamp notices when intermediate notices follow them", async () => {
		// Wire order: wall time is appended BEFORE timeout/pty notices, so it
		// sits mid-body — an end-anchored strip would leak it into the output.
		await mount(
			<BashRenderer
				args={{ command: "sleep 1" }}
				result={bashResult(
					"done\n\nWall time: 0.42 seconds\nTimeout clamped to 5s (requested 999s; allowed range 5-3600s).\n\nCommand exited with code 2",
					{ exitCode: 2, wallTimeMs: 420, timeoutSeconds: 5, requestedTimeoutSeconds: 999 },
				)}
				isError
			/>,
		);
		expect(container.textContent).toContain("done");
		expect(container.textContent).not.toContain("Wall time:");
		expect(container.textContent).not.toContain("Timeout clamped");
		expect(container.textContent).not.toContain("Command exited with code");
		expect(container.querySelector(".omp-bash-badge")?.textContent).toBe("exit 2");
		expect(container.querySelector(".omp-bash-notes")?.textContent).toBe("Timeout 5s (requested 999s)");
	});

	it("strips the exit-code trailer when the structured artifact id confirms the footer", async () => {
		// The byte-cap appends the footer after every notice and mirrors its id
		// in details, so printed lookalikes remain ordinary command output.
		await mount(
			<BashRenderer
				args={{ command: "huge-output" }}
				result={bashResult("tail of output\nCommand exited with code 1\n[raw output: artifact://42]", {
					exitCode: 1,
					artifactId: "42",
					meta: { truncation: { direction: "tail" } },
				})}
				isError
			/>,
		);
		expect(container.textContent).toContain("tail of output");
		expect(container.textContent).not.toContain("Command exited with code");
		expect(container.textContent).not.toContain("[raw output: artifact://42]");
		expect(container.querySelector(".omp-bash-notes")?.textContent).toBe("Full output saved as artifact 42");
		expect(container.querySelector(".omp-bash-badge")?.textContent).toBe("exit 1");
	});

	it("keeps the live command line on a clipped, not scrolling, terminal so it can stay pinned", async () => {
		await mount(
			<BashRenderer
				livePreview
				isPartial
				args={{ command: "seq 1 400" }}
				result={undefined}
				partialResult={bashResult("1\n2\n3")}
			/>,
		);
		const terminal = container.querySelector(".omp-bash-terminal");
		expect(terminal?.className).toContain("overflow-clip");
		expect(terminal?.className).not.toContain("overflow-hidden");
		const stylesheet = readFileSync(new URL("../../../styles/components.css", import.meta.url), "utf8");
		const prompt = stylesheet.match(/\.omp-bash-live \.omp-bash-prompt \{([^}]+)\}/)?.[1] ?? "";
		expect(prompt).toContain("position: sticky");
		expect(prompt).toContain("top: 0");
		expect(prompt).toContain("background: var(--omp-code-bg)");
	});

	it("keeps plain output as a single text node (no span explosion)", async () => {
		await mount(<BashRenderer args={{ command: "ls" }} result={bashResult("a\nb\nc")} />);
		expect(container.textContent).toContain("a\nb\nc");
	});

	it("renders every terminal image returned beside bash output", async () => {
		await mount(
			<BashRenderer
				args={{ command: "show-images" }}
				result={{
					content: [
						{ type: "text", text: "captured" },
						{ type: "image", data: "first", mimeType: "image/png" },
						{ type: "image", data: "second", mimeType: "image/jpeg" },
					],
				}}
			/>,
		);
		const images = [...container.querySelectorAll("img")];
		expect(images.map(image => image.getAttribute("src"))).toEqual([
			"data:image/png;base64,first",
			"data:image/jpeg;base64,second",
		]);
	});

	it("offers a dev server's address as a link that opens it in Preview, never by itself", async () => {
		const opened: string[] = [];
		const openPreview = useUiStore.getState().openPreview;
		useUiStore.setState({ openPreview: (url: string) => void opened.push(url) });
		try {
			await mount(
				<BashRenderer
					args={{ command: "bun run dev" }}
					result={bashResult("  VITE ready\n  ➜  Local:   http://localhost:5173/\n")}
				/>,
			);
			const link = container.querySelector("[data-bash-open-preview]") as unknown as HTMLButtonElement;
			expect(link?.getAttribute("type")).toBe("button");
			expect(opened).toEqual([]);
			await act(async () => link.dispatchEvent(new Event("click", { bubbles: true })));
			expect(opened).toEqual(["http://localhost:5173/"]);
		} finally {
			await act(async () => useUiStore.setState({ openPreview }));
		}
	});
});

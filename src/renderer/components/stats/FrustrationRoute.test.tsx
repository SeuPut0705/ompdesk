import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { FrustrationData } from "../../../shared/stats-types";
import { I18nProvider } from "../../lib/i18n";
import { FrustrationRoute } from "./FrustrationRoute";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
// useStats polls through window timers, which linkedom's window does not provide.
Object.assign(window, { setInterval, clearInterval, setTimeout, clearTimeout });

const paths: string[] = [];
function serve(reply: unknown): void {
	(window as unknown as { omp: unknown }).omp = {
		stats: {
			fetch: async (path: string) => {
				paths.push(path);
				return reply;
			},
		},
	};
}

let container: InstanceType<typeof HTMLElement>;
let root: Root;

async function mount(): Promise<string> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as never);
	await act(async () => {
		root.render(
			<I18nProvider>
				<FrustrationRoute range="30d" refreshKey={0} />
			</I18nProvider>,
		);
	});
	return container.textContent ?? "";
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	paths.length = 0;
});

const data: FrustrationData = {
	overall: { messages: 200, judged: 50, annoyed: 20, atAssistant: 10, angry: 2 },
	byModel: [
		{
			key: "a/opus/5",
			label: "opus 5",
			models: ["claude-opus-5"],
			messages: 40,
			judged: 0,
			annoyed: 4,
			atAssistant: 0,
			angry: 0,
		},
		{
			key: "o/gpt/5.6",
			label: "gpt 5.6",
			models: ["gpt-5.6", "openai/gpt-5.6"],
			messages: 160,
			judged: 50,
			annoyed: 16,
			atAssistant: 10,
			angry: 2,
		},
	],
};

describe("FrustrationRoute", () => {
	it("reads /api/stats/frustration and renders rates, the judged note, and per-model rows", async () => {
		serve(data);
		const text = await mount();
		expect(paths).toEqual(["/api/stats/frustration"]);
		expect(text).toContain("10.0%"); // annoyed 20/200
		expect(text).toContain("5.0%"); // at the assistant 10/200
		expect(text).toContain("50 of 200 messages have a model verdict");
		// busiest model first; merged spellings listed under the label
		expect(text.indexOf("gpt 5.6")).toBeLessThan(text.indexOf("opus 5"));
		expect(text).toContain("gpt-5.6, openai/gpt-5.6");
	});

	it("shows the empty state when the range has no messages", async () => {
		serve({ overall: { messages: 0, judged: 0, annoyed: 0, atAssistant: 0, angry: 0 }, byModel: [] });
		const text = await mount();
		expect(text).not.toContain("By model version");
	});
});

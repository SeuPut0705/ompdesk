import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { usePresence } from "./use-presence";

const { document, window } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, { document, window, IS_REACT_ACT_ENVIRONMENT: true });

const renders: string[][] = [];

function List({ items }: { items: string[] }) {
	const rows = usePresence(items, item => item);
	renders.push(rows.map(row => `${row.item}${row.exiting ? ":exiting" : ""}`));
	return null;
}

let root: Root | null = null;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	renders.length = 0;
});

describe("usePresence", () => {
	it("keeps a removed item on screen while it leaves", async () => {
		root = createRoot(document.createElement("div") as unknown as Element);
		await act(async () => root?.render(<List items={["a", "b"]} />));
		await act(async () => root?.render(<List items={["b"]} />));
		expect(renders.at(-1)).toEqual(["a:exiting", "b"]);
	});

	it("never draws an item twice when it comes back while its exit still runs", async () => {
		root = createRoot(document.createElement("div") as unknown as Element);
		await act(async () => root?.render(<List items={["j1"]} />));
		await act(async () => root?.render(<List items={[]} />));
		await act(async () => root?.render(<List items={["j1"]} />));
		for (const rows of renders) expect(new Set(rows.map(row => row.replace(":exiting", ""))).size).toBe(rows.length);
		expect(renders.at(-1)).toEqual(["j1"]);
	});
});

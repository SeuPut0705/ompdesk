/** Full-content session search: the excerpt a content-only hit shows under its title. */
import { describe, expect, it } from "vitest";
import { contentSnippet } from "./session-snippet";

const lines = (...entries: unknown[]) => entries.map(entry => JSON.stringify(entry)).join("\n");

function snippet(raw: string, query: string): string | undefined {
	return contentSnippet(raw, raw.toLowerCase(), query.toLowerCase().split(/\s+/).filter(Boolean));
}

describe("contentSnippet", () => {
	it("quotes the conversation text around the first query token, in its original case", () => {
		const raw = lines(
			{ type: "session", id: "s1", cwd: "/work/Payments" },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "We moved the Payments retry into the queue worker." }],
				},
			},
		);
		expect(snippet(raw, "payments retry")).toBe("We moved the Payments retry into the queue worker.");
	});

	it("clips long text to a window around the hit with ellipses and collapsed whitespace", () => {
		const text = `${"alpha ".repeat(40)}the\n\nMigration   plan ${"omega ".repeat(40)}`;
		const raw = lines({ type: "message", message: { role: "user", content: text } });
		const result = snippet(raw, "migration");
		expect(result?.startsWith("…")).toBe(true);
		expect(result?.endsWith("…")).toBe(true);
		expect(result).toContain("the Migration plan");
		expect(result?.length).toBeLessThanOrEqual(162);
	});

	it("prefers a conversation entry over header or tool metadata that mention the same word", () => {
		const raw = lines(
			{ type: "session", id: "s1", cwd: "/work/deploy" },
			{ type: "message", message: { role: "user", content: "Please deploy to staging" } },
		);
		expect(snippet(raw, "deploy")).toBe("Please deploy to staging");
	});

	it("gives up quietly when the hit is not readable JSON or case folding changed the length", () => {
		expect(snippet("not json deploy", "deploy")).toBeUndefined();
		expect(contentSnippet("İstanbul", "i̇stanbul", ["stanbul"])).toBeUndefined();
	});
});

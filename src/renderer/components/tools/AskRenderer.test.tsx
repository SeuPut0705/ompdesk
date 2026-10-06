import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { AskRenderer } from "./AskRenderer";
import type { ToolRendererProps } from "./ToolCard";

function render(props: ToolRendererProps) {
	return parseHTML(
		renderToStaticMarkup(
			<I18nProvider>
				<AskRenderer {...props} />
			</I18nProvider>,
		),
	).document;
}

describe("Ask history", () => {
	it("preserves original structured options and selects only the exact answer", () => {
		const document = render({
			args: {
				questions: [
					{
						id: "db",
						question: "Which database?",
						options: [{ label: "SQL" }, { label: "SQLite", description: "Embedded storage" }],
					},
				],
			},
			result: {
				content: [{ type: "text", text: "User selected: SQLite" }],
				details: { question: "Which database?", selectedOptions: ["SQLite"], options: ["SQL", "SQLite"] },
			},
		});
		expect(document.documentElement.textContent).toContain("Which database?");
		expect(document.documentElement.textContent).toContain("Embedded storage");
		const selected = document.querySelectorAll('svg[aria-label="Selected"]');
		expect(selected).toHaveLength(1);
		expect(selected[0].parentElement?.textContent).toBe("SQLiteEmbedded storage");
	});

	it("matches multiple answers to question ids and retains custom input and notes", () => {
		const document = render({
			args: {
				questions: [
					{ id: "one", question: "First?", options: [{ label: "Alpha" }] },
					{ id: "two", question: "Second?", options: [] },
				],
			},
			result: {
				details: {
					results: [
						{
							id: "two",
							question: "Second?",
							selectedOptions: [],
							customInput: "Custom answer",
							note: "Keep this constraint",
						},
						{ id: "one", selectedOptions: ["Alpha"] },
					],
				},
			},
		});
		const sections = document.querySelectorAll("section");
		expect(sections[0].textContent).toContain("Answered: Alpha");
		expect(sections[0].textContent).not.toContain("Custom answer");
		expect(sections[1].textContent).toContain("Custom answer");
		expect(sections[1].textContent).toContain("Keep this constraint");
	});

	it("preserves a legacy question and an error result without inferring a selection", () => {
		const document = render({
			args: { question: "Continue?", options: ["Yes", "No"] },
			result: "No response: cancelled",
			isError: true,
		});
		expect(document.documentElement.textContent).toContain("Continue?");
		expect(document.documentElement.textContent).toContain("No response: cancelled");
		expect(document.querySelector('svg[aria-label="Selected"]')).toBeNull();
	});
});

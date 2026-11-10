import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OptionGroup } from "./OptionGroup";
import { OptionRow } from "./OptionRow";

function render(node: React.ReactNode) {
	const { document } = parseHTML(`<html><body><div role="listbox">${renderToStaticMarkup(node)}</div></body></html>`);
	return document;
}

describe("OptionGroup", () => {
	it("is a group named by its label, whose header is look only, never a heading", () => {
		const document = render(
			<OptionGroup count={2} data-model-group="anthropic" icon={<svg data-icon="" />} label="Anthropic">
				<OptionRow active id="row-a">
					Opus
				</OptionRow>
				<OptionRow active={false} id="row-b">
					Sonnet
				</OptionRow>
			</OptionGroup>,
		);
		const group = document.querySelector("[role='group']");
		expect(group?.getAttribute("aria-label")).toBe("Anthropic");
		expect(group?.getAttribute("data-model-group")).toBe("anthropic");
		expect(document.querySelector("h1, h2, h3, h4, h5, h6, [role='heading']")).toBeNull();
		const header = group?.querySelector("[data-option-group-header] [aria-hidden='true']");
		expect(header?.textContent).toBe("Anthropic2");
		expect(header?.querySelector("[data-icon]")).not.toBeNull();
		expect([...(group?.querySelectorAll("[role='option']") ?? [])].map(row => row.textContent)).toEqual([
			"Opus",
			"Sonnet",
		]);
	});

	it("keeps a header action reachable, outside the hidden name", () => {
		const document = render(
			<OptionGroup action={<button type="button">Connect</button>} label="OpenAI">
				<OptionRow active={false} id="row-c">
					GPT
				</OptionRow>
			</OptionGroup>,
		);
		const connect = document.querySelector("[data-option-group-header] button");
		expect(connect?.textContent).toBe("Connect");
		expect(connect?.closest("[aria-hidden='true']")).toBeNull();
	});
});

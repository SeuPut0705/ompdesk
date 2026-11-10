import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChoiceCards } from "./ChoiceCards";
import { FieldLabel, Input } from "./Input";
import { SegmentedChoice } from "./SegmentedChoice";

function render(node: React.ReactNode) {
	return parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;
}

describe("FieldLabel", () => {
	it("names a form element by htmlFor, with the same look as an Input's label", () => {
		const document = render(
			<>
				<FieldLabel htmlFor="model">Model</FieldLabel>
				<select id="model" />
				<Input id="name" label="Name" />
			</>,
		);
		const [own, input] = [...document.querySelectorAll("label")];
		expect(own.getAttribute("for")).toBe("model");
		expect(input.getAttribute("for")).toBe("name");
		expect(own.getAttribute("class")).toBe(input.getAttribute("class"));
	});

	it("is a fieldset's legend", () => {
		const document = render(
			<fieldset>
				<FieldLabel as="legend">Notify me</FieldLabel>
				<input type="checkbox" />
			</fieldset>,
		);
		expect(document.querySelector("fieldset > legend")?.textContent).toBe("Notify me");
		expect(document.querySelector("label")).toBeNull();
	});

	it("names a SegmentedChoice or ChoiceCards group through aria-labelledby, and the group carries its id", () => {
		const document = render(
			<>
				<FieldLabel as="span" id="approval-label">
					Tool approval
				</FieldLabel>
				<SegmentedChoice
					aria-labelledby="approval-label"
					id="approval"
					onChange={() => {}}
					optionAttr="data-approval"
					options={[
						{ value: "ask", label: "Ask" },
						{ value: "full", label: "Full" },
					]}
					value="ask"
				/>
				<FieldLabel as="span" id="scope-label">
					Scope
				</FieldLabel>
				<ChoiceCards
					aria-labelledby="scope-label"
					id="scope"
					onChange={() => {}}
					optionAttr="data-scope"
					options={[{ value: "user", title: "Every project" }]}
					value="user"
				/>
			</>,
		);
		const [approval, scope] = [...document.querySelectorAll("[role='radiogroup']")];
		expect(approval.getAttribute("id")).toBe("approval");
		expect(document.getElementById(approval.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
			"Tool approval",
		);
		expect(scope.getAttribute("id")).toBe("scope");
		expect(document.getElementById(scope.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Scope");
	});
});

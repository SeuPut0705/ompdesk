import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ListRow } from "./ListRow";

const markup = (props: { actionCount?: 1 | 2 | 3 | 4; selected?: boolean }) =>
	renderToStaticMarkup(
		<ListRow actions={<button type="button">act</button>} onClick={() => {}} title="Session" {...props} />,
	);

describe("ListRow", () => {
	it("keeps the title clear of the actions it reveals: room for two by default, for the stated count otherwise", () => {
		expect(markup({})).toContain("group-hover/row:pr-14");
		expect(markup({ actionCount: 3 })).toContain("group-hover/row:pr-24");
		expect(markup({ actionCount: 3 })).toContain("group-focus-within/row:pr-24");
		expect(markup({ actionCount: 4 })).toContain("group-hover/row:pr-32");
		expect(markup({ actionCount: 1 })).toContain("group-hover/row:pr-9");
		// A selected row shows its actions at rest, so the room is always there.
		expect(markup({ actionCount: 3, selected: true })).toMatch(/class="[^"]*\bpr-24\b/);
	});
});

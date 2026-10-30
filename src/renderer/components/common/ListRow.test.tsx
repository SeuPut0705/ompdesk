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
		expect(markup({ actionCount: 4 })).toContain("group-hover/row:pr-32");
		expect(markup({ actionCount: 1 })).toContain("group-hover/row:pr-9");
		// A selected row shows its actions at rest, so the room is always there.
		expect(markup({ actionCount: 3, selected: true })).toMatch(/class="[^"]*\bpr-24\b/);
	});

	it("quiet actions overlay a fade: nothing reserved, nothing shown at rest even when selected", () => {
		const quiet = renderToStaticMarkup(
			<ListRow
				actionCount={3}
				actions={<button type="button">act</button>}
				actionsOnHover
				meta="2m"
				onClick={() => {}}
				selected
				title="Session"
			/>,
		);
		expect(quiet).not.toMatch(/class="[^"]*\b(group-[a-z-]+\/row:)?pr-24\b/);
		expect(quiet).toContain("pointer-events-none");
		expect(quiet).not.toMatch(/absolute inset-y-0[^"]* opacity-100[ "]/);
		expect(quiet).toContain("--row-room:6rem");
		// The meta gives the actions its place while they show, so the title runs on under the fade to them.
		expect(quiet).toContain("group-hover/row:hidden");
	});

	it("with no hover (a finger) the actions show at rest and the title yields their room", () => {
		const row = markup({ actionCount: 3 });
		expect(row).toContain("[@media(hover:none)]:opacity-100");
		expect(row).toContain("[@media(hover:none)]:pr-(--row-room)");
		expect(row).toContain("--row-room:6rem");
		const quiet = renderToStaticMarkup(
			<ListRow actions={<button type="button">act</button>} actionsOnHover meta="2m" title="Session" />,
		);
		expect(quiet).toContain("[@media(hover:none)]:pointer-events-auto");
		expect(quiet).toContain("[@media(hover:none)]:invisible");
	});

	it("actionsAtRest puts the actions after the meta as an ordinary control: no overlay, no padding, meta kept", () => {
		const row = renderToStaticMarkup(
			<ListRow
				actions={<button type="button">act</button>}
				actionsAtRest
				actionsOnHover
				meta="2m"
				onClick={() => {}}
				title="Session"
			/>,
		);
		expect(row).not.toContain("absolute inset-y-0");
		expect(row).not.toContain("group-hover/row:invisible");
		expect(row).not.toContain("--row-room");
		expect(row.indexOf("2m")).toBeLessThan(row.indexOf("act"));
		expect(row).toContain("-mr-1.5");
	});

	it("describes its button by the description, beside any description the caller gives", () => {
		const row = renderToStaticMarkup(
			<ListRow
				buttonProps={{ "aria-describedby": "hint" }}
				description="~/work/app"
				onClick={() => {}}
				title="app"
			/>,
		);
		const describedBy = /aria-describedby="([^"]+)"/.exec(row)?.[1]?.split(" ") ?? [];
		expect(describedBy[0]).toBe("hint");
		expect(row).toMatch(new RegExp(`id="${describedBy[1]}"[^>]*>~/work/app<`));
		expect(renderToStaticMarkup(<ListRow onClick={() => {}} title="app" />)).not.toContain("aria-describedby");
	});
});

import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilePath } from "./DiffPanel";

function render(
	file: string,
	cwd: string | null,
): { dir: string | undefined; name: string | undefined; title: string } {
	const { document } = parseHTML(renderToStaticMarkup(<FilePath cwd={cwd} file={file} />));
	const spans = [...document.querySelectorAll("span > span")];
	const dir = spans.find(span => span.className.includes("text-(--sc-text-muted)"));
	const name = spans.find(span => span !== dir);
	return {
		dir: dir?.textContent ?? undefined,
		name: name?.textContent ?? undefined,
		title: document.querySelector("span")?.getAttribute("title") ?? "",
	};
}

describe("edit history file path", () => {
	it("shows the path relative to the session folder and keeps the file name out of the ellipsis", () => {
		const shown = render("/work/tally/src/lib/add.ts", "/work/tally");
		expect(shown).toEqual({ dir: "src/lib/", name: "add.ts", title: "/work/tally/src/lib/add.ts" });
		const markup = renderToStaticMarkup(<FilePath cwd="/work/tally" file="/work/tally/src/lib/add.ts" />);
		// The folder part is the one that truncates; the name never shrinks away.
		expect(markup).toMatch(/min-w-0 truncate[^"]*"[^>]*>src\/lib\/</);
		expect(markup).toMatch(/shrink-0[^"]*"[^>]*>add\.ts</);
	});

	it("shows a file in the folder itself by its name alone", () => {
		expect(render("/work/tally/README.md", "/work/tally")).toMatchObject({ dir: undefined, name: "README.md" });
		expect(render("README.md", "/work/tally")).toMatchObject({ dir: undefined, name: "README.md" });
	});

	it("keeps the full path of a file outside the folder, still ending in its name", () => {
		expect(render("/etc/hosts", "/work/tally")).toMatchObject({ dir: "/etc/", name: "hosts" });
		expect(render("/etc/hosts", null)).toMatchObject({ dir: "/etc/", name: "hosts" });
	});
});

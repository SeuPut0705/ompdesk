import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { visualsInstruction, visualsTemplate } from "../../resources/gui-bridge/modes/visuals-core";
import { appendIfMissing } from "../../resources/gui-bridge/prompt-sections";

const stockModules = path.join(os.homedir(), ".bun/install/global/node_modules");
const stockRoot = path.join(stockModules, "@oh-my-pi/pi-coding-agent");

describe("gui-bridge diagram instructions", () => {
	it("appends the section once, and nothing when it is empty or stock already carries it", () => {
		expect(appendIfMissing(["base"], "- Visuals")).toEqual(["base", "- Visuals"]);
		const unchanged = ["base"];
		expect(appendIfMissing(unchanged, undefined)).toBe(unchanged);
		const carried = ["base\n- Visuals\nmore"];
		expect(appendIfMissing(carried, "- Visuals")).toBe(carried);
	});

	it("refuses a template without stock's Visuals section", () => {
		expect(() => visualsTemplate("# Engineering\n- nothing here")).toThrow(/no Visuals section/);
	});

	it("never claims the UI charts tables", () => {
		const seen: Record<string, unknown>[] = [];
		visualsInstruction(
			(_template, context) => {
				seen.push(context);
				return "x";
			},
			"t",
			{ renderMermaid: true, renderSvg: false },
		);
		expect(seen).toEqual([{ renderMermaid: true, renderSvg: false, autoGraph: false }]);
	});
});

// Stock's template renderer uses Bun APIs, which cannot execute in Vitest's Node worker.
describe.skipIf(!fs.existsSync(stockRoot))("gui-bridge diagram instructions against stock", () => {
	it("renders stock's own section per setting, exactly as stock's prompt carries it", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-stock-visuals-"));
		try {
			const script = path.join(dir, "visuals.ts");
			fs.writeFileSync(
				script,
				`import { render } from ${JSON.stringify(path.join(stockModules, "@oh-my-pi/pi-utils/src/prompt.ts"))};
import { visualsInstruction, visualsTemplate } from ${JSON.stringify(path.resolve("resources/gui-bridge/modes/visuals-core.ts"))};
const full = await Bun.file(${JSON.stringify(path.join(stockRoot, "src/prompts/system/system-prompt.md"))}).text();
const section = visualsTemplate(full);
const out = {};
for (const [name, flags] of Object.entries({
	both: { renderMermaid: true, renderSvg: true },
	mermaid: { renderMermaid: true, renderSvg: false },
	svg: { renderMermaid: false, renderSvg: true },
	none: { renderMermaid: false, renderSvg: false },
})) {
	const instruction = visualsInstruction(render, section, flags);
	out[name] = { instruction: instruction ?? null, inStock: instruction ? render(full, { ...flags, autoGraph: false }).includes(instruction) : null };
}
console.log(JSON.stringify(out));
`,
			);
			const result = JSON.parse(execFileSync("bun", [script], { encoding: "utf8" })) as Record<
				string,
				{ instruction: string | null; inStock: boolean | null }
			>;
			expect(result.both.instruction).toContain("```mermaid");
			expect(result.both.instruction).toContain("```svg");
			expect(result.mermaid.instruction).toContain("```mermaid");
			expect(result.mermaid.instruction).not.toContain("```svg");
			expect(result.svg.instruction).toContain("```svg");
			expect(result.svg.instruction).not.toContain("```mermaid");
			for (const name of ["both", "mermaid", "svg"]) {
				expect(result[name]?.instruction).not.toMatch(/UI charts it/);
				expect(result[name]?.inStock).toBe(true);
			}
			expect(result.none.instruction).toBeNull();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

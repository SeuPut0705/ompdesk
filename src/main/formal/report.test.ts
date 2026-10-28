/** The report page: valid findings render, and nothing a model or a finding says can inject markup. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	esc,
	parseGraph,
	renderGraphSvg,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/graph-svg";
import { renderReport } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/report-render";
import { validate } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/schema";

const SKILL = path.join(__dirname, "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify");
const schema = JSON.parse(fs.readFileSync(path.join(SKILL, "assets/findings.schema.json"), "utf8"));
const example = JSON.parse(fs.readFileSync(path.join(SKILL, "assets/templates/findings.example.json"), "utf8"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-report-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

const HOSTILE = [
	"<script>alert(1)</script>",
	'"><img src=x onerror=alert(1)>',
	"</style><script>alert(2)</script>",
	"<svg onload=alert(3)>",
	"&lt;already escaped&gt; & ' \"",
];

/** Replaces every string value of a JSON tree with `fn(value)`, keys and enum-valued fields untouched. */
function mapStrings(value: unknown, fn: (text: string) => string, key = ""): unknown {
	if (typeof value === "string")
		return ["severity", "status", "result", "kind", "workflow", "generated_at", "id"].includes(key)
			? value
			: fn(value);
	if (Array.isArray(value)) return value.map(item => mapStrings(item, fn, key));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn, k)]));
	}
	return value;
}

describe("report rendering", () => {
	it("the shipped example validates against the schema and renders a complete page", () => {
		expect(validate(example, schema)).toEqual([]);
		const html = renderReport(example);
		expect(html).toMatch(/^<!doctype html>/);
		expect(html).toContain("<h2>Findings</h2>");
		expect(html).toContain("<h2>What was verified</h2>");
		expect(html).toContain("<h2>Trust base</h2>");
		expect(html).toContain("<svg");
		expect(html).toContain("Content-Security-Policy");
		expect(html).not.toMatch(/<script/i);
	});

	it("escapes every string of the findings: no raw tag, no attribute breakout, no script", () => {
		let n = 0;
		const hostile = mapStrings(example, text => `${text} ${HOSTILE[n++ % HOSTILE.length]}`) as Record<
			string,
			unknown
		>;
		const html = renderReport(hostile);
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/<img/i);
		expect(html).not.toMatch(/<svg onload/i);
		expect(html).not.toContain("</style><script");
		// Escaped text may still spell "onerror=": what must not exist is a real tag that carries an event handler.
		expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
		// Real structure survives: the page still has its sections, one tag at a time.
		expect(html.match(/<section class="finding"/g)?.length).toBeGreaterThan(0);
	});

	it("escapes diagram labels and node ids, in text and in attributes", () => {
		const graph = parseGraph({
			nodes: [{ id: '"><script>x</script>', label: "<b>one</b>" }, "two & <i>three</i>"],
			edges: [['"><script>x</script>', "two & <i>three</i>", '"onmouseover="alert(1)']],
			highlight: ["two & <i>three</i>"],
			steps: { "two & <i>three</i>": 2 },
		});
		expect(graph).not.toBeNull();
		const svg = renderGraphSvg(graph as NonNullable<typeof graph>, 'cap"><script>');
		expect(svg).not.toMatch(/<script/i);
		expect(svg).not.toMatch(/<b>|<i>/);
		expect(svg).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
		expect(svg).toContain("&lt;b&gt;one&lt;/b&gt;");
		expect(svg).toContain("&quot;onmouseover=&quot;alert(1)");
	});

	it("esc handles every HTML metacharacter and non-strings", () => {
		expect(esc(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
		expect(esc(42)).toBe("42");
	});

	it("report.ts writes the page under reports/ next to findings.json, and exits 2 on invalid findings", () => {
		const dir = path.join(temp, "formal");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "findings.json"), JSON.stringify(example));
		const ok = spawnSync("bun", [path.join(SKILL, "scripts/report.ts"), path.join(dir, "findings.json")], {
			encoding: "utf8",
		});
		expect(ok.status).toBe(0);
		const page = path.join(dir, "reports", `${example.concern}.html`);
		expect(ok.stdout).toContain(page);
		expect(fs.readFileSync(page, "utf8")).toContain("verification</h1>");
		const bad = path.join(dir, "bad.json");
		fs.writeFileSync(bad, JSON.stringify({ concern: "x" }));
		const rejected = spawnSync("bun", [path.join(SKILL, "scripts/report.ts"), bad], { encoding: "utf8" });
		expect(rejected.status).toBe(2);
		expect(rejected.stderr).toContain('missing "workflow"');
		expect(spawnSync("bun", [path.join(SKILL, "scripts/report.ts")], { encoding: "utf8" }).status).toBe(2);
	});
});

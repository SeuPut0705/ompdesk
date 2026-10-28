import { esc, parseGraph, renderGraphSvg } from "./graph-svg";
import { isRecord } from "./json";

type Json = Record<string, unknown>;

function list(value: unknown): Json[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function texts(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function str(value: unknown): string {
	return typeof value === "string"
		? value
		: typeof value === "number" || typeof value === "boolean"
			? String(value)
			: "";
}

const CSS = `
:root{--bg:#fff;--fg:#1c1f24;--muted:#6a7280;--line:#d8dce3;--bad:#c62828;--good:#1b7f3b;--warn:#b26a00;--card:#f6f7f9;--code:#eef0f3}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6e8ec;--muted:#9aa3b2;--line:#2c313a;--bad:#ff6b6b;--good:#55c27a;--warn:#e0a040;--card:#1b1e24;--code:#222731}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.55rem;margin:.2rem 0 .6rem}h2{font-size:1.15rem;margin:2rem 0 .6rem;border-bottom:1px solid var(--line);padding-bottom:.3rem}h3{font-size:1rem;margin:.2rem 0}
.verdict{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--good);border-radius:8px;padding:12px 14px}
.verdict.bad{border-left-color:var(--bad)}.verdict p{margin:.2rem 0}
.counts{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.pill{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:1px 10px;font-size:.82rem;background:var(--bg)}
.pill.bad{color:var(--bad);border-color:var(--bad)}.pill.good{color:var(--good);border-color:var(--good)}.pill.warn{color:var(--warn);border-color:var(--warn)}
section.finding{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:14px 0;background:var(--card)}
.meta{color:var(--muted);font-size:.86rem}
table{border-collapse:collapse;width:100%;font-size:.86rem;margin:.5rem 0;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}th{background:var(--code)}
tr.violation td{background:color-mix(in srgb,var(--bad) 14%,transparent)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.84rem}
code{background:var(--code);padding:0 4px;border-radius:4px}pre{background:var(--code);padding:10px 12px;border-radius:6px;overflow-x:auto}pre code{background:none;padding:0}
figure.diagram{margin:10px 0;color:var(--fg)}figure.diagram svg{max-width:100%;height:auto}figcaption{color:var(--muted);font-size:.82rem}
ul{padding-left:1.2rem}footer{margin-top:2.5rem;color:var(--muted);font-size:.8rem}
`;

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

function pill(text: string, kind = ""): string {
	return `<span class="pill ${kind}">${esc(text)}</span>`;
}

function statusKind(status: string): string {
	if (status === "confirmed") return "bad";
	if (status === "fixed" || status === "holds" || status === "proven" || status === "passes") return "good";
	if (status === "suspected" || status === "timeout" || status === "sorry" || status === "violated") return "warn";
	return "";
}

function traceTable(trace: Json[]): string {
	const rows = trace.map(step => {
		const changed = isRecord(step.changed)
			? Object.entries(step.changed)
					.map(([name, value]) => `<code>${esc(name)}</code> = ${esc(str(value))}`)
					.join("<br>")
			: "";
		return `<tr${step.violation === true ? ' class="violation"' : ""}><td>${esc(str(step.step))}</td><td>${esc(str(step.actor))}</td><td>${esc(str(step.action))}${step.violation === true ? " &larr; property breaks" : ""}</td><td>${step.code ? `<code>${esc(str(step.code))}</code>` : ""}</td><td>${changed}</td></tr>`;
	});
	return `<table><thead><tr><th>#</th><th>Actor</th><th>Action</th><th>Code</th><th>Changed</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function findingHtml(finding: Json): string {
	const id = str(finding.id);
	const out: string[] = [];
	out.push(`<section class="finding" id="${esc(id)}"><h3>${esc(id)} &middot; ${esc(str(finding.title))}</h3>`);
	out.push(
		`<p class="meta">${pill(str(finding.severity), str(finding.severity) === "critical" || str(finding.severity) === "high" ? "bad" : "warn")} ${pill(str(finding.status), statusKind(str(finding.status)))} violated property: <code>${esc(str(finding.property))}</code></p>`,
	);
	if (finding.story) out.push(`<p>${esc(str(finding.story))}</p>`);
	const trace = list(finding.trace);
	if (trace.length > 0) out.push(traceTable(trace));
	const diagram = parseGraph(finding.diagram);
	if (diagram) out.push(renderGraphSvg(diagram, `${id}: where the counterexample runs`, `fv-${id}`));
	if (isRecord(finding.reproduction)) {
		const repro = finding.reproduction;
		out.push(
			`<p><strong>Reproduction</strong>: ${repro.test ? `<code>${esc(str(repro.test))}</code> ` : ""}before the fix: ${esc(str(repro.result_before_fix) || "not run")}; after: ${esc(str(repro.result_after_fix) || "not run")}</p>`,
		);
	}
	if (isRecord(finding.fix)) {
		const fix = finding.fix;
		out.push(
			`<p><strong>Fix</strong>: ${esc(str(fix.summary))}${fix.pr ? ` (${esc(str(fix.pr))})` : ""}. Model re-check: ${esc(str(fix.model_recheck) || "not run")}; mutation check: ${esc(str(fix.mutation_check) || "not run")}</p>`,
		);
		if (fix.diff) out.push(`<pre><code>${esc(str(fix.diff))}</code></pre>`);
	}
	const evidence = texts(finding.evidence);
	if (evidence.length > 0)
		out.push(`<p class="meta">Evidence: ${evidence.map(path => `<code>${esc(path)}</code>`).join(", ")}</p>`);
	out.push("</section>");
	return out.join("\n");
}

function bulletList(items: string[]): string {
	return items.length === 0
		? '<p class="meta">none recorded</p>'
		: `<ul>${items.map(item => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

/** Renders validated findings.json data into one self-contained HTML page (no script, every text escaped). */
export function renderReport(findings: Json, options: { generator?: string } = {}): string {
	const concern = str(findings.concern);
	const allFindings = list(findings.findings).sort(
		(a, b) => SEVERITY_ORDER.indexOf(str(a.severity)) - SEVERITY_ORDER.indexOf(str(b.severity)),
	);
	const properties = list(findings.properties);
	const count = (status: string): number => allFindings.filter(finding => str(finding.status) === status).length;
	const anyConfirmed = count("confirmed") > 0;
	const violated = properties.filter(property => str(property.result) === "violated").length;
	const holds = properties.filter(property => ["holds", "proven"].includes(str(property.result))).length;
	const out: string[] = [];
	out.push('<!doctype html><html lang="en"><head><meta charset="utf-8">');
	out.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
	out.push(
		"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">",
	);
	out.push(`<title>${esc(concern)} verification</title><style>${CSS}</style></head><body><main>`);
	out.push(`<h1>${esc(concern)} verification</h1>`);
	out.push(
		`<div class="verdict${anyConfirmed || violated > 0 ? " bad" : ""}"><p><strong>${esc(str(findings.summary))}</strong></p><div class="counts">`,
	);
	out.push(
		`${pill(`${count("confirmed")} confirmed`, count("confirmed") ? "bad" : "")}${pill(`${count("suspected")} suspected`, count("suspected") ? "warn" : "")}${pill(`${count("refuted")} refuted`)}${pill(`${count("fixed")} fixed`, count("fixed") ? "good" : "")}`,
	);
	out.push(
		`${pill(`${holds} of ${properties.length} properties hold`, violated ? "bad" : "good")}${pill(`workflow ${str(findings.workflow)}`)}`,
	);
	if (findings.repo_commit) out.push(pill(`commit ${str(findings.repo_commit).slice(0, 12)}`));
	out.push(`${pill(str(findings.generated_at))}</div></div>`);
	out.push("<h2>Findings</h2>");
	out.push(
		allFindings.length === 0
			? "<p>No finding: no counterexample within the stated bounds.</p>"
			: allFindings.map(findingHtml).join("\n"),
	);
	const simplifications = list(findings.simplifications);
	if (simplifications.length > 0) {
		out.push(
			"<h2>Simplifications</h2><table><thead><tr><th>ID</th><th>Change</th><th>Justification</th><th>Assumptions</th><th>Re-verified</th><th>Status</th><th>LOC</th></tr></thead><tbody>",
		);
		for (const item of simplifications) {
			out.push(
				`<tr><td>${esc(str(item.id))}</td><td>${esc(str(item.change))}${item.code ? `<br><code>${esc(str(item.code))}</code>` : ""}</td><td>${esc(str(item.justification))}</td><td>${esc(texts(item.relies_on_assumptions).join("; "))}</td><td>${esc(str(item.reverified))}</td><td>${esc(str(item.status))}</td><td>${esc(str(item.loc_delta))}</td></tr>`,
			);
		}
		out.push("</tbody></table>");
	}
	out.push(
		"<h2>What was verified</h2><table><thead><tr><th>Property</th><th>Kind</th><th>Result</th><th>Tool</th><th>Bounds</th><th>Evidence</th></tr></thead><tbody>",
	);
	for (const property of properties) {
		out.push(
			`<tr><td><code>${esc(str(property.name))}</code>${property.frozen === true ? " (frozen)" : ""}${property.meaning ? `<br>${esc(str(property.meaning))}` : ""}${property.source ? `<br><span class="meta">source: ${esc(str(property.source))}</span>` : ""}</td><td>${esc(str(property.kind))}</td><td>${pill(str(property.result), statusKind(str(property.result)))}</td><td>${esc(str(property.tool))}</td><td>${esc(str(property.bounds))}</td><td>${property.evidence ? `<code>${esc(str(property.evidence))}</code>` : "not recorded"}</td></tr>`,
		);
	}
	out.push("</tbody></table>");
	const scope = isRecord(findings.scope) ? findings.scope : {};
	out.push("<h2>Model scope and assumptions</h2>");
	for (const [label, key] of [
		["Modeled", "modeled"],
		["Abstracted", "abstracted"],
		["Out of scope", "out_of_scope"],
		["Assumptions", "assumptions"],
	] as const) {
		out.push(`<h3>${label}</h3>${bulletList(texts(scope[key]))}`);
	}
	const trust = isRecord(findings.trust_base) ? findings.trust_base : {};
	out.push("<h2>Trust base</h2>");
	if (isRecord(trust.tla)) {
		const tla = trust.tla;
		out.push(
			`<p><strong>TLA+</strong>: ${esc(str(tla.tool_version))}; ${esc(str(tla.states_generated))} states generated, ${esc(str(tla.distinct_states))} distinct, depth ${esc(str(tla.depth))}.</p>${bulletList(texts(tla.sanity_checks))}`,
		);
	}
	if (isRecord(trust.lean)) {
		const lean = trust.lean;
		out.push(
			`<p><strong>Lean</strong>: ${esc(str(lean.toolchain))}; sorry count ${esc(str(lean.sorry_count))}; native_decide used: ${esc(str(lean.native_decide_used))}.</p>`,
		);
		if (isRecord(lean.axioms)) {
			out.push(
				`<ul>${Object.entries(lean.axioms)
					.map(
						([name, axioms]) =>
							`<li><code>${esc(name)}</code>: ${esc(texts(axioms).join(", ") || "no axioms")}</li>`,
					)
					.join("")}</ul>`,
			);
		}
	}
	if (!isRecord(trust.tla) && !isRecord(trust.lean)) out.push('<p class="meta">not recorded</p>');
	const rerun = texts(findings.rerun);
	out.push("<h2>Re-run</h2>");
	out.push(rerun.length > 0 ? `<pre><code>${esc(rerun.join("\n"))}</code></pre>` : '<p class="meta">not recorded</p>');
	out.push(`<h2>Next steps</h2>${bulletList(texts(findings.next_steps))}`);
	out.push(
		`<footer>${esc(options.generator ?? "Generated by ompdesk-formal-verify report.ts")} from findings.json. A pass means no counterexample within the stated bounds, not that the code is correct.</footer>`,
	);
	out.push("</main></body></html>");
	return `${out.join("\n")}\n`;
}

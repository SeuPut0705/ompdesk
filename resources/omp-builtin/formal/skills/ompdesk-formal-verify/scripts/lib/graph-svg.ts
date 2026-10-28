import { isRecord } from "./json";

export interface GraphNode {
	id: string;
	label: string;
}

export interface GraphEdge {
	from: string;
	to: string;
	label?: string;
}

export interface Graph {
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** Highlighted node ids and `a->b` edges. */
	highlight: string[];
	/** Trace-step badge per node id. */
	steps: Record<string, number>;
}

/** Escapes text for HTML and SVG (text nodes and attribute values). */
export function esc(text: unknown): string {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function nodeOf(entry: unknown): GraphNode | null {
	if (typeof entry === "string") return { id: entry, label: entry };
	if (isRecord(entry) && typeof entry.id === "string") {
		return { id: entry.id, label: typeof entry.label === "string" ? entry.label : entry.id };
	}
	return null;
}

function edgeOf(entry: unknown): GraphEdge | null {
	if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
		return { from: entry[0], to: entry[1], ...(typeof entry[2] === "string" ? { label: entry[2] } : {}) };
	}
	if (isRecord(entry) && typeof entry.from === "string" && typeof entry.to === "string") {
		return { from: entry.from, to: entry.to, ...(typeof entry.label === "string" ? { label: entry.label } : {}) };
	}
	return null;
}

/** Reads a `diagram` value of findings.json; returns null when it holds no nodes. */
export function parseGraph(value: unknown): Graph | null {
	if (!isRecord(value) || !Array.isArray(value.nodes)) return null;
	const nodes = value.nodes.map(nodeOf).filter((node): node is GraphNode => node !== null);
	if (nodes.length === 0) return null;
	const known = nodes.map(node => node.id);
	const edges = (Array.isArray(value.edges) ? value.edges : [])
		.map(edgeOf)
		.filter((edge): edge is GraphEdge => edge !== null && known.includes(edge.from) && known.includes(edge.to));
	const highlight = Array.isArray(value.highlight)
		? value.highlight.filter((item): item is string => typeof item === "string")
		: [];
	const steps: Record<string, number> = {};
	if (isRecord(value.steps)) {
		for (const [id, step] of Object.entries(value.steps)) if (typeof step === "number") steps[id] = step;
	}
	return { nodes, edges, highlight, steps };
}

const NODE_H = 34;
const GAP_X = 70;
const GAP_Y = 26;
const PAD = 16;
/** Room beside an edge's source: the step badge (radius 10) sits on the node's corner, the label starts clear of it. */
const LABEL_INSET = 14;

/** Width of an edge label at 11px: a little more than a proportional font needs, so the estimate errs wide. */
function labelWidth(label: string): number {
	return label.length * 6.4;
}

function layers(graph: Graph): Map<string, number> {
	const layer = new Map<string, number>(graph.nodes.map(node => [node.id, 0]));
	// Longest-path layering over the edges that go forward in a depth-first order (back edges are ignored).
	const order = new Map<string, number>();
	const state = new Map<string, number>();
	const forward: GraphEdge[] = [];
	const visit = (id: string): void => {
		state.set(id, 1);
		order.set(id, order.size);
		for (const edge of graph.edges.filter(candidate => candidate.from === id)) {
			if (state.get(edge.to) === 1 || edge.from === edge.to) continue;
			forward.push(edge);
			if (!state.has(edge.to)) visit(edge.to);
		}
		state.set(id, 2);
	};
	for (const node of graph.nodes) if (!state.has(node.id)) visit(node.id);
	for (let pass = 0; pass < graph.nodes.length; pass++) {
		let changed = false;
		for (const edge of forward) {
			const wanted = (layer.get(edge.from) as number) + 1;
			if ((layer.get(edge.to) as number) < wanted) {
				layer.set(edge.to, wanted);
				changed = true;
			}
		}
		if (!changed) break;
	}
	return layer;
}

/** A self-contained `<figure><svg>`: layered left to right, every text escaped, colors from CSS variables. */
export function renderGraphSvg(graph: Graph, caption?: string, idPrefix = "d"): string {
	const prefix = idPrefix.replace(/[^\w-]+/g, "_");
	const layer = layers(graph);
	const columns = new Map<number, GraphNode[]>();
	for (const node of graph.nodes) {
		const at = layer.get(node.id) as number;
		columns.set(at, [...(columns.get(at) ?? []), node]);
	}
	const widthOf = (node: GraphNode): number => Math.max(64, node.label.length * 7.4 + 24);
	const position = new Map<string, { x: number; y: number; w: number }>();
	let x = PAD;
	let lastGap = GAP_X;
	let height = 0;
	for (const at of [...columns.keys()].sort((a, b) => a - b)) {
		const column = columns.get(at) as GraphNode[];
		const width = Math.max(...column.map(widthOf));
		for (const [row, node] of column.entries())
			position.set(node.id, { x, y: PAD + 14 + row * (NODE_H + GAP_Y), w: width });
		height = Math.max(height, PAD + 14 + column.length * (NODE_H + GAP_Y));
		// The labels of the edges leaving this column sit in the gap after it, between the badge and the next node.
		const gap = Math.max(
			GAP_X,
			...graph.edges
				.filter(edge => edge.label && layer.get(edge.from) === at && (layer.get(edge.to) as number) > at)
				.map(edge => labelWidth(edge.label as string) + 2 * LABEL_INSET),
		);
		x += width + gap;
		lastGap = gap;
	}
	const width = x - lastGap + PAD;
	const out: string[] = [];
	out.push(
		`<figure class="diagram"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height + PAD)}" role="img" aria-label="${esc(caption ?? "diagram")}">`,
	);
	out.push(
		`<defs><marker id="${prefix}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker>`,
	);
	out.push(
		`<marker id="${prefix}-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--bad)"/></marker></defs>`,
	);
	for (const edge of graph.edges) {
		const a = position.get(edge.from);
		const b = position.get(edge.to);
		if (!a || !b) continue;
		const bad = graph.highlight.includes(`${edge.from}->${edge.to}`);
		const back = (layer.get(edge.to) as number) <= (layer.get(edge.from) as number);
		const sy = a.y + NODE_H / 2;
		const ty = b.y + NODE_H / 2;
		let d: string;
		let lx: number;
		let ly: number;
		let anchor: "start" | "middle";
		if (back) {
			const sx = a.x + a.w / 2;
			const tx = b.x + b.w / 2;
			const lift = Math.min(a.y, b.y) - 12 - Math.abs(tx - sx) / 12;
			d = `M${sx} ${a.y} C${sx} ${lift} ${tx} ${lift} ${tx} ${b.y}`;
			lx = (sx + tx) / 2;
			ly = lift + 6;
			anchor = "middle";
		} else {
			const sx = a.x + a.w;
			const tx = b.x;
			const mid = (sx + tx) / 2;
			d = `M${sx} ${sy} C${mid} ${sy} ${mid} ${ty} ${tx} ${ty}`;
			lx = sx + LABEL_INSET;
			ly = (sy + ty) / 2 - 5;
			anchor = "start";
		}
		out.push(
			`<path d="${d}" fill="none" stroke="${bad ? "var(--bad)" : "currentColor"}" stroke-width="${bad ? 2.4 : 1.2}" ${bad ? "" : 'stroke-opacity="0.55"'} marker-end="url(#${prefix}-${bad ? "arrow-bad" : "arrow"})"/>`,
		);
		if (edge.label)
			out.push(
				`<text x="${lx}" y="${ly}" font-size="11" text-anchor="${anchor}" fill="currentColor" fill-opacity="0.8" stroke="var(--bg)" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${esc(edge.label)}</text>`,
			);
	}
	for (const node of graph.nodes) {
		const at = position.get(node.id) as { x: number; y: number; w: number };
		const bad = graph.highlight.includes(node.id);
		out.push(
			`<g><rect x="${at.x}" y="${at.y}" width="${at.w}" height="${NODE_H}" rx="7" fill="var(--bg)" stroke="${bad ? "var(--bad)" : "currentColor"}" stroke-width="${bad ? 2.4 : 1.2}" ${bad ? "" : 'stroke-opacity="0.6"'}/>`,
		);
		out.push(
			`<text x="${at.x + at.w / 2}" y="${at.y + NODE_H / 2 + 4}" font-size="13" text-anchor="middle" fill="currentColor">${esc(node.label)}</text>`,
		);
		const step = graph.steps[node.id];
		if (step !== undefined) {
			out.push(
				`<circle cx="${at.x + at.w}" cy="${at.y}" r="10" fill="${bad ? "var(--bad)" : "var(--muted)"}"/><text x="${at.x + at.w}" y="${at.y + 4}" font-size="11" text-anchor="middle" fill="var(--bg)">${esc(step)}</text>`,
			);
		}
		out.push("</g>");
	}
	out.push("</svg>");
	if (caption) out.push(`<figcaption>${esc(caption)}</figcaption>`);
	out.push("</figure>");
	return out.join("\n");
}

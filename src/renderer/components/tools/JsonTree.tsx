import { useMemo, useState } from "react";
import { asRecord } from "../../lib/wire-value";
import { type TreeNode, TreeView } from "../common/TreeView";

/**
 * Bounded JSON tree for tool output, after stock `pi-tui/tools/json-tree.ts`
 * (`renderJsonTreeLines`): the expanded policy — depth 6, 200 rows, scalars
 * up to 2000 characters — with the collapsed depth (2) open at first. Root
 * keys `i` and `__partialJson` stay hidden like stock's `HIDDEN_ARG_KEYS`.
 * A card body is already "expanded" in the GUI, so the deeper levels are one
 * keyboard/click step away instead of behind a whole-card toggle.
 */
export const JSON_TREE_MAX_DEPTH = 6;
export const JSON_TREE_MAX_ROWS = 200;
export const JSON_TREE_SCALAR_CHARS = 2000;
/** Stock's collapsed depth: the levels open before the reader expands further. */
const JSON_TREE_OPEN_DEPTH = 2;
const HIDDEN_ROOT_KEYS: Record<string, true> = { i: true, __partialJson: true };

/** Parse tool text as JSON only when it looks like an object or array, as stock does. */
export function parseJsonOutput(text: string): { ok: true; value: unknown } | { ok: false } {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { ok: false };
	try {
		return { ok: true, value: JSON.parse(trimmed) };
	} catch {
		return { ok: false };
	}
}

function valueText(value: unknown): string {
	if (Array.isArray(value)) return `[${value.length}]`;
	const record = asRecord(value);
	if (record) return `{${Object.keys(record).length}}`;
	if (typeof value === "string") {
		return `"${value.length > JSON_TREE_SCALAR_CHARS ? `${value.slice(0, JSON_TREE_SCALAR_CHARS)}…` : value}"`;
	}
	return String(value);
}

function Label({ name, value, text }: { name: string | undefined; value: unknown; text?: string }) {
	const tone =
		text !== undefined || Array.isArray(value) || asRecord(value) || value == null
			? "text-[var(--omp-dim)]"
			: typeof value === "string"
				? "text-[var(--omp-success)]"
				: "text-[var(--omp-accent)]";
	return (
		<span className="font-mono">
			{name !== undefined && <span className="text-[var(--omp-dim)]">{name}: </span>}
			<span className={tone}>{text ?? valueText(value)}</span>
		</span>
	);
}

interface Built {
	nodes: TreeNode[];
	open: Set<string>;
	truncated: boolean;
}

function buildTree(root: unknown, hideRootKeys: boolean, openDepth: number): Built {
	const open = new Set<string>();
	let rows = 0;
	let truncated = false;
	const visit = (name: string | undefined, value: unknown, id: string, depth: number): TreeNode | null => {
		if (rows >= JSON_TREE_MAX_ROWS) {
			truncated = true;
			return null;
		}
		rows++;
		const record = asRecord(value);
		const container = Array.isArray(value) || record !== undefined;
		if (!container || depth >= JSON_TREE_MAX_DEPTH) {
			// A multiline string keeps its lines as continuation rows (stock `multilineStrings`).
			if (typeof value === "string" && value.includes("\n")) {
				const lines = value.split("\n");
				const children: TreeNode[] = [];
				for (const [index, line] of lines.entries()) {
					if (rows >= JSON_TREE_MAX_ROWS) {
						truncated = true;
						break;
					}
					rows++;
					children.push({
						id: `${id}.${index}`,
						label: <span className="font-mono text-[var(--omp-success)]">{line || " "}</span>,
					});
				}
				if (depth < openDepth) open.add(id);
				return { id, label: <Label name={name} value={value} text={`"…" (${lines.length})`} />, children };
			}
			return { id, label: <Label name={name} value={value} /> };
		}
		const entries: [string, unknown][] = record
			? Object.entries(record).filter(([key]) => !(depth === 0 && hideRootKeys && HIDDEN_ROOT_KEYS[key]))
			: (value as unknown[]).map((item, index) => [String(index), item]);
		const children: TreeNode[] = [];
		for (const [key, item] of entries) {
			const child = visit(key, item, `${id}.${key}`, depth + 1);
			if (!child) break;
			children.push(child);
		}
		if (depth < openDepth) open.add(id);
		return { id, label: <Label name={name} value={value} />, children };
	};
	const top = visit(undefined, root, "$", 0);
	// The root container is implicit: its children are the top rows; a scalar root is one row.
	const nodes = top?.children ?? (top ? [top] : []);
	return { nodes, open, truncated };
}

export function JsonTree({
	value,
	hideRootKeys = true,
	label,
	openDepth = JSON_TREE_OPEN_DEPTH,
}: {
	value: unknown;
	/** Hide the root `i` / `__partialJson` keys (tool arguments). */
	hideRootKeys?: boolean;
	/** Accessible name of the tree. */
	label: string;
	/** Levels open at first; stock opens submitted yield data to the depth cap. */
	openDepth?: number;
}) {
	const built = useMemo(() => buildTree(value, hideRootKeys, openDepth), [value, hideRootKeys, openDepth]);
	const [expanded, setExpanded] = useState(built.open);
	return (
		<div aria-label={label} className="rounded bg-[var(--omp-code-bg)] text-omp-sm" role="group">
			<TreeView
				className="max-h-72 overflow-auto"
				expanded={expanded}
				nodes={built.nodes}
				onExpandedChange={setExpanded}
			/>
			{built.truncated && <div className="px-2 pb-1 font-mono text-[var(--omp-dim)]">…</div>}
		</div>
	);
}

/**
 * Recursive tree with expand/collapse, indent guides, and full keyboard
 * navigation (Up/Down move, Right expand/first-child, Left collapse/parent,
 * Enter/Space activate). Expansion is controlled by the caller.
 */

import { ChevronRight } from "lucide-react";
import {
	type CSSProperties,
	type DragEvent,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
} from "react";
import { useT } from "../../lib/i18n";
import { anchorFromEvent, type ContextMenuAnchor } from "./ContextMenu";

export interface TreeNode {
	id: string;
	label: ReactNode;
	icon?: ReactNode;
	/** Small mark after the label (a status letter). */
	trailing?: ReactNode;
	children?: TreeNode[];
	/** Called when the row is activated (click / Enter). */
	onClick?: () => void;
	/** Row menu: right-click, the context-menu key or Shift+F10. */
	onMenu?: (anchor: ContextMenuAnchor) => void;
	/** Makes the row draggable; fill `event.dataTransfer` here. */
	onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
	/** Extra classes for the row. */
	className?: string;
}

export interface TreeViewProps {
	nodes: TreeNode[];
	expanded: Set<string>;
	onExpandedChange: (expanded: Set<string>) => void;
	/** Empty-state message when `nodes` is empty. */
	emptyMessage?: string;
	className?: string;
	/** Row marked selected (aria-selected, tab stop) and scrolled into view whenever it changes. */
	selectedId?: string | null;
}

interface FlatRow {
	node: TreeNode;
	depth: number;
	hasChildren: boolean;
	isExpanded: boolean;
}

export function TreeView({ nodes, expanded, onExpandedChange, emptyMessage, className, selectedId }: TreeViewProps) {
	const t = useT();
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!selectedId) return;
		const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-tree-id]") ?? [];
		Array.from(rows)
			.find(row => row.getAttribute("data-tree-id") === selectedId)
			?.scrollIntoView?.({ block: "nearest" });
	}, [selectedId]);

	const toggle = (id: string) => {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		onExpandedChange(next);
	};

	const rows = useMemo<FlatRow[]>(() => {
		const out: FlatRow[] = [];
		const walk = (list: TreeNode[], depth: number) => {
			for (const node of list) {
				const hasChildren = (node.children?.length ?? 0) > 0;
				const isExpanded = hasChildren && expanded.has(node.id);
				out.push({ node, depth, hasChildren, isExpanded });
				if (isExpanded && node.children) walk(node.children, depth + 1);
			}
		};
		walk(nodes, 0);
		return out;
	}, [nodes, expanded]);

	const parentOf = useMemo(() => {
		const map = new Map<string, string | null>();
		const walk = (list: TreeNode[], parent: string | null) => {
			for (const node of list) {
				map.set(node.id, parent);
				if (node.children) walk(node.children, node.id);
			}
		};
		walk(nodes, null);
		return map;
	}, [nodes]);

	const focusRow = (id: string) => {
		requestAnimationFrame(() => {
			listRef.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`)?.focus();
		});
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: FlatRow, index: number) => {
		// Keys typed into a control inside the row (an inline rename field) stay with it.
		if (event.target !== event.currentTarget) return;
		if (row.node.onMenu && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
			event.preventDefault();
			const rect = event.currentTarget.getBoundingClientRect();
			row.node.onMenu({ x: rect.left + 24, y: rect.bottom });
			return;
		}
		switch (event.key) {
			case "ArrowDown": {
				event.preventDefault();
				const next = rows[index + 1];
				if (next) focusRow(next.node.id);
				break;
			}
			case "ArrowUp": {
				event.preventDefault();
				const prev = rows[index - 1];
				if (prev) focusRow(prev.node.id);
				break;
			}
			case "ArrowRight": {
				event.preventDefault();
				if (row.hasChildren && !row.isExpanded) toggle(row.node.id);
				else if (row.hasChildren && row.node.children?.length) focusRow(row.node.children[0].id);
				break;
			}
			case "ArrowLeft": {
				event.preventDefault();
				if (row.hasChildren && row.isExpanded) toggle(row.node.id);
				else {
					const parent = parentOf.get(row.node.id);
					if (parent) focusRow(parent);
				}
				break;
			}
			case "Enter":
			case " ": {
				event.preventDefault();
				row.node.onClick?.();
				break;
			}
		}
	};

	if (nodes.length === 0) {
		return (
			<div className={`px-3 py-6 text-center text-sc-sm text-(--sc-text-muted) ${className ?? ""}`.trim()}>
				{emptyMessage ?? t("tree.empty")}
			</div>
		);
	}

	const selectedVisible = rows.some(row => row.node.id === selectedId);
	return (
		<div className={`py-1 ${className ?? ""}`.trim()} ref={listRef} role="tree">
			{rows.map((row, index) => {
				const selected = row.node.id === selectedId;
				return (
					<div
						aria-expanded={row.hasChildren ? row.isExpanded : undefined}
						aria-selected={selected}
						className={`group flex min-h-(--sc-control-sm) cursor-default items-center gap-1 rounded-(--sc-radius-sm) pr-2 text-sc-sm transition-colors duration-(--sc-duration-fast) hover:bg-(--sc-hover) hover:text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring) motion-reduce:transition-none ${selected ? "bg-(--sc-selected) text-(--sc-text)" : "text-(--sc-text-muted)"} ${row.node.className ?? ""}`.trim()}
						data-tree-id={row.node.id}
						key={row.node.id}
						onClick={() => row.node.onClick?.()}
						onContextMenu={row.node.onMenu ? event => row.node.onMenu?.(anchorFromEvent(event)) : undefined}
						draggable={row.node.onDragStart ? true : undefined}
						onDragStart={row.node.onDragStart}
						onKeyDown={event => onKeyDown(event, row, index)}
						role="treeitem"
						style={
							{
								paddingLeft: `calc(var(--sc-space-1-5) + ${row.depth} * var(--sc-icon-sm))`,
								"--tree-depth": row.depth,
							} as CSSProperties
						}
						tabIndex={(selectedVisible ? selected : index === 0) ? 0 : -1}
					>
						{row.hasChildren ? (
							<button
								aria-label={row.isExpanded ? t("tree.collapse") : t("tree.expand")}
								className="omp-disclosure-chevron flex size-(--sc-icon-md) shrink-0 items-center justify-center rounded-(--sc-radius-sm) text-(--sc-text-muted) hover:text-(--sc-text)"
								onClick={event => {
									event.stopPropagation();
									toggle(row.node.id);
								}}
								style={{ transform: row.isExpanded ? "rotate(90deg)" : undefined }}
								tabIndex={-1}
								type="button"
							>
								<ChevronRight className="size-(--sc-icon-sm)" />
							</button>
						) : (
							<span className="size-(--sc-icon-md) shrink-0" />
						)}
						{row.node.icon && (
							<span className="shrink-0 text-(--sc-text-subtle) group-hover:text-(--sc-text-muted)">
								{row.node.icon}
							</span>
						)}
						<span
							title={typeof row.node.label === "string" ? row.node.label : undefined}
							className="min-w-0 flex-1 truncate"
						>
							{row.node.label}
						</span>
						{row.node.trailing}
					</div>
				);
			})}
		</div>
	);
}

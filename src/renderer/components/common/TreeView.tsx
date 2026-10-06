/**
 * Recursive tree with expand/collapse, indent guides, and full keyboard
 * navigation (Up/Down move, Right expand/first-child, Left collapse/parent,
 * Enter/Space activate).
 */

import { ChevronRight } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";

export interface TreeNode {
	id: string;
	label: ReactNode;
	icon?: ReactNode;
	children?: TreeNode[];
	/** Called when the row is activated (click / Enter). */
	onClick?: () => void;
	/** Extra classes for the row. */
	className?: string;
}

export interface TreeViewProps {
	nodes: TreeNode[];
	/** Ids expanded on first render (uncontrolled initial state). */
	defaultExpanded?: string[];
	/** Controlled expansion; omit for uncontrolled. */
	expanded?: Set<string>;
	onExpandedChange?: (expanded: Set<string>) => void;
	/** Currently selected id (highlighted row). */
	selectedId?: string | null;
	/** Empty-state message when `nodes` is empty. */
	emptyMessage?: string;
	className?: string;
}

interface FlatRow {
	node: TreeNode;
	depth: number;
	hasChildren: boolean;
	isExpanded: boolean;
}

export function TreeView({
	nodes,
	defaultExpanded,
	expanded: controlledExpanded,
	onExpandedChange,
	selectedId,
	emptyMessage,
	className,
}: TreeViewProps) {
	const t = useT();
	const [internalExpanded, setInternalExpanded] = useState<Set<string>>(() => new Set(defaultExpanded ?? []));
	const expandedSet = controlledExpanded ?? internalExpanded;
	const listRef = useRef<HTMLDivElement>(null);

	const setExpanded = useCallback(
		(next: Set<string>) => {
			if (controlledExpanded === undefined) setInternalExpanded(next);
			onExpandedChange?.(next);
		},
		[controlledExpanded, onExpandedChange],
	);

	const toggle = useCallback(
		(id: string) => {
			const next = new Set(expandedSet);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			setExpanded(next);
		},
		[expandedSet, setExpanded],
	);

	const rows = useMemo<FlatRow[]>(() => {
		const out: FlatRow[] = [];
		const walk = (list: TreeNode[], depth: number) => {
			for (const node of list) {
				const hasChildren = (node.children?.length ?? 0) > 0;
				const isExpanded = hasChildren && expandedSet.has(node.id);
				out.push({ node, depth, hasChildren, isExpanded });
				if (isExpanded && node.children) walk(node.children, depth + 1);
			}
		};
		walk(nodes, 0);
		return out;
	}, [nodes, expandedSet]);

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
			<div className={`px-3 py-6 text-center text-omp-sm text-(--omp-dim) ${className ?? ""}`.trim()}>
				{emptyMessage ?? t("tree.empty")}
			</div>
		);
	}

	return (
		<div className={`py-1 ${className ?? ""}`.trim()} ref={listRef} role="tree">
			{rows.map((row, index) => {
				const selected = selectedId === row.node.id;
				return (
					<div
						aria-expanded={row.hasChildren ? row.isExpanded : undefined}
						aria-selected={selected}
						className={`group flex cursor-default items-center gap-1 rounded-sm pr-2 text-xs transition-colors duration-75 ${
							selected
								? "bg-(--omp-selected-bg) text-(--omp-text)"
								: "text-(--omp-muted) hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
						} ${row.node.className ?? ""}`.trim()}
						data-tree-id={row.node.id}
						key={row.node.id}
						onClick={() => row.node.onClick?.()}
						onKeyDown={event => onKeyDown(event, row, index)}
						role="treeitem"
						style={{ paddingLeft: 6 + row.depth * 14 }}
						tabIndex={selectedId == null ? (index === 0 ? 0 : -1) : selected ? 0 : -1}
					>
						{row.hasChildren ? (
							<button
								aria-label={row.isExpanded ? t("tree.collapse") : t("tree.expand")}
								className="omp-disclosure-chevron flex size-4 shrink-0 items-center justify-center rounded text-(--omp-dim) hover:text-(--omp-text)"
								onClick={event => {
									event.stopPropagation();
									toggle(row.node.id);
								}}
								style={{ transform: row.isExpanded ? "rotate(90deg)" : undefined }}
								tabIndex={-1}
								type="button"
							>
								<ChevronRight size={12} />
							</button>
						) : (
							<span className="size-4 shrink-0" />
						)}
						{row.node.icon && (
							<span className="shrink-0 text-(--omp-dim) group-hover:text-(--omp-muted)">{row.node.icon}</span>
						)}
						<span className="min-w-0 flex-1 truncate">{row.node.label}</span>
					</div>
				);
			})}
		</div>
	);
}

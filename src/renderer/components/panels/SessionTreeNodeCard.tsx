/**
 * SessionTreeNodeCard: one message node on the session tree canvas — role,
 * relative time, label, HEAD marker and a two-line preview — plus the node
 * action menu (switch here / branch / open in new window).
 */

import { Bot, CornerDownLeft, ExternalLink, GitBranch, Info, Play, User } from "lucide-react";
import { memo } from "react";
import { cx, formatClock, formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Badge, MenuButton, Spinner } from "../common";
import type { SessionTreeEntry } from "./session-tree-layout";
import { TREE_NODE_HEIGHT, TREE_NODE_WIDTH, TREE_ROOT_HEIGHT } from "./session-tree-layout";

const ROLE_META: Record<SessionTreeEntry["role"], { labelKey: string; className: string }> = {
	user: { labelKey: "sessionTree.role.user", className: "text-(--sc-info)" },
	assistant: { labelKey: "sessionTree.role.assistant", className: "text-(--sc-text-muted)" },
	system: { labelKey: "sessionTree.role.system", className: "text-(--sc-text-subtle)" },
};

function roleMeta(role: string): { labelKey: string; className: string } {
	return ROLE_META[role as SessionTreeEntry["role"]] ?? ROLE_META.system;
}

function RoleGlyph({ role }: { role: SessionTreeEntry["role"] }) {
	const className = cx("size-(--sc-icon-sm) shrink-0", roleMeta(role).className);
	switch (role) {
		case "user":
			return <User aria-hidden className={className} />;
		case "assistant":
			return <Bot aria-hidden className={className} />;
		default:
			return <Info aria-hidden className={className} />;
	}
}

export type SessionTreeNodeAction = "switch" | "branch" | "fork";

const SessionTreeNodeCard = memo(function SessionTreeNodeCard({
	entry,
	head,
	selected,
	x,
	y,
	branching,
	onAction,
	ready = true,
}: {
	entry: SessionTreeEntry;
	head: boolean;
	selected: boolean;
	x: number;
	y: number;
	/** Entry id currently running an action, or null; any non-null value disables every action. */
	branching: string | null;
	onAction: (action: SessionTreeNodeAction, entryId: string) => void;
	ready?: boolean;
}) {
	const t = useT();
	const meta = roleMeta(entry.role);
	const actionDisabled = !ready || branching !== null;
	const unavailable = !ready ? t("sessionTree.notConnected") : undefined;
	return (
		<div
			className={cx(
				"group absolute flex cursor-grab flex-col rounded-(--sc-radius-md) border bg-(--sc-surface-1) px-3 py-2 transition-colors duration-(--sc-duration-fast)",
				entry.onActiveBranch ? "border-(--sc-border)" : "border-(--sc-border-subtle)",
				selected && "ring-2 ring-(--sc-focus-ring)",
			)}
			data-tree-node={entry.entryId}
			title={entry.entryId}
			style={{ left: x, top: y, width: TREE_NODE_WIDTH, height: TREE_NODE_HEIGHT }}
		>
			<div className="flex min-w-0 items-center gap-1.5 pr-4">
				<RoleGlyph role={entry.role} />
				<span className={cx("shrink-0 text-sc-xs font-medium", meta.className)}>{t(meta.labelKey)}</span>
				{entry.timestamp > 0 && (
					<span
						className="shrink-0 text-sc-xs tabular-nums text-(--sc-text-subtle)"
						title={formatClock(entry.timestamp)}
					>
						{formatTimeAgo(entry.timestamp)}
					</span>
				)}
				{entry.label && (
					<Badge className="min-w-0 max-w-24 truncate" variant="info">
						{entry.label}
					</Badge>
				)}
				{head && (
					<span className="ml-auto shrink-0">
						<Badge variant="success">{t("sessionTree.head")}</Badge>
					</span>
				)}
			</div>
			{entry.textPreview ? (
				<p className="mt-1 line-clamp-2 min-h-0 flex-1 text-sc-sm whitespace-pre-wrap text-(--sc-text)">
					{entry.textPreview}
				</p>
			) : (
				// A tool-call or thinking-only turn has no text: say so instead of an empty card.
				<p className="mt-1 line-clamp-2 min-h-0 flex-1 text-sc-sm text-(--sc-text-subtle)" data-tree-node-empty>
					{t("sessionTree.noText")}
				</p>
			)}
			{/* Node actions: switch the active leaf here (any node), branch (user
			    nodes only, server gate), or open an independent session from here
			    in a new window (any node). The wrapper keeps the press from
			    starting a node drag on the canvas. */}
			<span className="absolute -top-3 -right-3" onPointerDown={event => event.stopPropagation()}>
				<MenuButton
					align="end"
					className="rounded-(--sc-radius-full) opacity-70 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
					disabled={branching !== null}
					icon={branching === entry.entryId ? <Spinner inheritColor size="sm" /> : <GitBranch />}
					items={[
						{
							id: "switch",
							label: t("sessionTree.switchHere"),
							icon: CornerDownLeft,
							disabled: actionDisabled,
							disabledReason: unavailable,
							onSelect: () => onAction("switch", entry.entryId),
						},
						{
							id: "branch",
							label: t("sessionTree.branchFromHere"),
							icon: GitBranch,
							disabled: actionDisabled || entry.role !== "user",
							disabledReason:
								unavailable ?? (entry.role !== "user" ? t("sessionTree.branchUserOnly") : undefined),
							onSelect: () => onAction("branch", entry.entryId),
						},
						{
							id: "fork",
							label: t("sessionTree.openInNewWindow"),
							icon: ExternalLink,
							disabled: actionDisabled,
							disabledReason: unavailable,
							onSelect: () => onAction("fork", entry.entryId),
						},
					]}
					label={t("sessionTree.actions")}
					size="sm"
					variant="ghost"
				/>
			</span>
		</div>
	);
});

export function SessionRootNode({ x, y }: { x: number; y: number }) {
	const t = useT();
	return (
		<div
			className="absolute flex items-center gap-1.5 rounded-(--sc-radius-md) border border-dashed border-(--sc-border-subtle) px-2"
			style={{ left: x, top: y, width: TREE_NODE_WIDTH, height: TREE_ROOT_HEIGHT }}
		>
			<Play aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)" />
			<span className="truncate text-sc-xs font-medium text-(--sc-text-muted)">{t("sessionTree.root")}</span>
		</div>
	);
}

export { RoleGlyph, roleMeta, SessionTreeNodeCard };

/**
 * Side panel › Work tree (View options only; nothing opens it by itself): every session of this window that has a
 * family, as a tree (`work-tree.ts`): the session, its subagents, the sessions its agent opened on any computer, their
 * own subagents and opened sessions, each worktree's branch; live rows and the ones that need a look, then one closed
 * "finished" fold per family. One line per row; model, role and cost are the tooltip, the family's cost its header.
 * Under the trees, the orphaned worktrees of the focused tab's repository (`OrphanWorktrees.tsx`).
 *
 * Reads the stores the sidebar and the work board already fill (no poll): tabs, every tab's subagent roster (followed
 * through the runtime registry), main's review push and child usage, the closed children, the hosted sessions.
 */

import { Bot, GitBranch, MessageSquare, Network } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { Billing } from "../../../../../resources/gui-bridge/model-setup-contracts";
import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import { useSessionSpend } from "../../../hooks/use-session-spend";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useProjectNames } from "../../../lib/project-origin";
import { costKinds, costWords } from "../../../lib/spend";
import { ensureAgentReviewSubscription, useAgentReviewStore } from "../../../stores/agent-review";
import { ensureClosedChildren, useClosedChildrenStore } from "../../../stores/closed-children";
import { useHostedSessionsStore } from "../../../stores/hosted-sessions";
import { useRemoteStore } from "../../../stores/remote";
import { onSessionRuntimesChange, sessionRuntimeStore } from "../../../stores/session-runtime-context";
import type { SubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";
import { DisclosureButton, EmptyState } from "../../common";
import { CostAmount, hasCost } from "../../common/CostAmount";
import { SettingInfo } from "../../common/SettingInfo";
import { FamilyStatus } from "../../layout/sidebar/SidebarFamilyRow";
import { childUsageText } from "../../layout/sidebar/sidebar-family";
import { PANEL_ROW_SURFACE } from "../PanelChrome";
import { OrphanWorktrees } from "./OrphanWorktrees";
import { SavedWorktrees } from "./SavedWorktrees";
import { buildWorkTree, type WorkTreeFamily, type WorkTreeNode } from "./work-tree";

const KIND_ICON = { subagent: Bot, worktree: GitBranch, session: MessageSquare, branch: GitBranch } as const;
/** Where a row's glyph starts: the panel's inset, then one step per level. */
const INSET_PX = 12;
const STEP_PX = 16;

const NO_ROSTERS: ReadonlyMap<string, ReadonlyMap<string, SubagentSnapshot>> = new Map();

/**
 * Every listed tab's subagent roster, re-read when any of them changes or a runtime comes or goes. One snapshot map,
 * rebuilt only on a change, so the tree's memo holds between frames.
 */
function useRosters(tabIds: readonly string[]): ReadonlyMap<string, ReadonlyMap<string, SubagentSnapshot>> {
	const key = tabIds.join("\u0000");
	const [rosters, setRosters] = useState(NO_ROSTERS);
	useEffect(() => {
		const ids = key ? key.split("\u0000") : [];
		let unsubscribers: (() => void)[] = [];
		const read = () => {
			const next = new Map<string, ReadonlyMap<string, SubagentSnapshot>>();
			for (const id of ids) {
				const roster = sessionRuntimeStore<SubagentsStore>(id, "subagents")?.getState().subagents;
				if (roster && roster.size > 0) next.set(id, roster);
			}
			setRosters(previous =>
				previous.size === next.size && [...next].every(([id, roster]) => previous.get(id) === roster)
					? previous
					: next,
			);
		};
		const attach = () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
			unsubscribers = ids.flatMap(id => {
				const store = sessionRuntimeStore<SubagentsStore>(id, "subagents");
				return store ? [store.subscribe(read)] : [];
			});
			read();
		};
		attach();
		const offRegistry = onSessionRuntimesChange(attach);
		return () => {
			offRegistry();
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}, [key]);
	return rosters;
}

function useWorkTree(billing: Readonly<Record<string, Billing>> | undefined): WorkTreeFamily[] {
	const tabs = useTabsStore(state => state.tabs);
	const review = useAgentReviewStore(state => state.byTab);
	const usage = useAgentReviewStore(state => state.usage);
	const closed = useClosedChildrenStore(state => state.rows);
	const hosted = useHostedSessionsStore(state => state.sessions);
	const hosts = useRemoteStore(state => state.state?.hosts);
	const tabIds = useMemo(() => tabs.filter(tab => !tab.ghost).map(tab => tab.id), [tabs]);
	const rosters = useRosters(tabIds);
	useEffect(() => {
		ensureAgentReviewSubscription();
		ensureClosedChildren();
	}, []);
	return useMemo(
		() =>
			buildWorkTree({
				tabs,
				subagents: rosters,
				review,
				usage,
				closed,
				hosted,
				deviceName: id => hosts?.find(host => host.deviceId === id)?.name ?? id,
				billing,
			}),
		[tabs, rosters, review, usage, closed, hosted, hosts, billing],
	);
}

function open(node: WorkTreeNode): void {
	const target = node.target;
	if (!target) return;
	if (target.kind === "subagent")
		useUiStore.getState().openSubagentPanel({ tabId: target.tabId, agentId: target.agentId });
	else if (target.kind === "tab") void useTabsStore.getState().switchTab(target.tabId);
	else void useTabsStore.getState().openTab({ cwd: target.cwd, sessionPath: target.sessionPath, kind: "agent" });
}

const TreeRow = memo(function TreeRow({
	node,
	billing,
}: {
	node: WorkTreeNode;
	billing?: Readonly<Record<string, Billing>>;
}) {
	const t = useT();
	const stateLabel = node.state ? t(`workTree.state.${node.state}`) : "";
	const Icon = KIND_ICON[node.kind];
	const title = node.title || t("workTree.untitled");
	// A stored session whose folder is gone says so before the click (the open then offers Restore when it was saved).
	const storedCwd = node.target?.kind === "stored" ? node.target.cwd : undefined;
	const projectName = useProjectNames(storedCwd ? [storedCwd] : []);
	const gone = storedCwd !== undefined && projectName(storedCwd).gone;
	const usage = childUsageText(node.usage.model, node.usage.role);
	const branchNote =
		node.kind === "branch"
			? [
					node.base ? t("workTree.branchBase", { base: node.base }) : "",
					node.merge ? t(`workBoard.opened.merge.${node.merge}`) : "",
				]
					.filter(Boolean)
					.join(" · ")
			: "";
	const kinds = costKinds(node.usage, billing);
	const tooltip = [
		title,
		stateLabel,
		gone ? t("sessionFolder.goneTip") : "",
		node.device,
		usage,
		costWords(t, kinds),
		branchNote,
	]
		.filter(Boolean)
		.join("\n");
	return (
		<li>
			<button
				aria-label={[title, stateLabel, node.device].filter(Boolean).join(", ")}
				className={cx(
					PANEL_ROW_SURFACE,
					"omp-work-tree-row flex h-(--sc-control-md) w-full items-center gap-1.5 rounded-none py-0",
					node.target === null && "cursor-default hover:bg-transparent",
				)}
				data-work-tree-row={node.key}
				data-work-tree-kind={node.kind}
				data-work-tree-depth={node.depth}
				data-state={node.state ?? undefined}
				disabled={node.target === null}
				onClick={() => open(node)}
				style={{ paddingLeft: INSET_PX + node.depth * STEP_PX }}
				title={tooltip}
				type="button"
			>
				<Icon aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
				<span className={cx("min-w-0 flex-1 truncate", node.kind === "branch" && "font-mono text-sc-xs")}>
					{title}
				</span>
				{gone ? (
					<span className="shrink-0 text-sc-xs text-(--sc-warning)" data-session-folder-gone>
						{t("sessionFolder.gone")}
					</span>
				) : null}
				{node.device ? (
					<span className="max-w-24 shrink-0 truncate text-sc-xs text-(--sc-text-subtle)" data-work-tree-device>
						{node.device}
					</span>
				) : null}
				{hasCost(kinds) ? (
					<CostAmount
						className="shrink-0 text-sc-xs text-(--sc-text-muted) tabular-nums"
						data={{ "data-work-tree-cost": true }}
						kinds={kinds}
					/>
				) : null}
				{node.state ? <FamilyStatus state={node.state} /> : null}
			</button>
		</li>
	);
});

function FamilyTree({ family, billing }: { family: WorkTreeFamily; billing?: Readonly<Record<string, Billing>> }) {
	const t = useT();
	const [finishedOpen, setFinishedOpen] = useState(false);
	const summary = [
		family.running > 0 ? t("sidebar.family.running", { count: family.running }) : "",
		family.waiting > 0 ? t("sidebar.family.waiting", { count: family.waiting }) : "",
		hasCost(family.cost) ? t("workTree.familyCost", { cost: costWords(t, family.cost) }) : "",
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<section aria-label={family.root.title || t("workTree.untitled")} data-work-tree-family={family.root.key}>
			<ul>
				<li className="flex items-center">
					<div className="min-w-0 flex-1">
						<ul>
							<TreeRow billing={billing} node={family.root} />
						</ul>
					</div>
					{hasCost(family.cost) ? (
						<CostAmount
							className="shrink-0 pr-3 text-sc-xs text-(--sc-text-muted) tabular-nums"
							data={{ "data-work-tree-summary": true }}
							kinds={family.cost}
						/>
					) : summary ? (
						<span
							className="shrink-0 pr-3 text-sc-xs text-(--sc-text-muted) tabular-nums"
							data-work-tree-summary
							title={summary}
						>
							{summary}
						</span>
					) : null}
				</li>
				{family.rows.map(node => (
					<TreeRow billing={billing} key={node.key} node={node} />
				))}
			</ul>
			{family.finished.length > 0 ? (
				<>
					<DisclosureButton
						chevronClassName="size-(--sc-icon-sm)"
						className={cx(
							PANEL_ROW_SURFACE,
							"omp-work-tree-row h-(--sc-control-md) gap-1.5 rounded-none py-0 text-(--sc-text-muted)",
						)}
						data-work-tree-finished={family.finished.length}
						onToggle={() => setFinishedOpen(value => !value)}
						open={finishedOpen}
						style={{ paddingLeft: INSET_PX + STEP_PX }}
					>
						<span className="min-w-0 flex-1 truncate">
							{t("workTree.finished", { count: family.finished.length })}
						</span>
					</DisclosureButton>
					{finishedOpen ? (
						<ul data-work-tree-finished-rows>
							{family.finished.map(node => (
								<TreeRow billing={billing} key={node.key} node={{ ...node, depth: node.depth + 1 }} />
							))}
						</ul>
					) : null}
				</>
			) : null}
		</section>
	);
}

export function WorkTreePanel() {
	const t = useT();
	const billing = useSessionSpend()?.billing;
	const families = useWorkTree(billing);
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-3" data-work-tree>
			<h3 className="flex items-center gap-1 px-3 pt-3 pb-1 text-sc-xs font-medium text-(--sc-text-muted)">
				{t("workTree.sessions")}
				<SettingInfo text={t("workTree.sessionsInfo")} />
			</h3>
			{families.length === 0 ? (
				<EmptyState icon={<Network />} size="sm" title={t("workTree.empty")} />
			) : (
				<div className="flex flex-col gap-2">
					{families.map(family => (
						<FamilyTree billing={billing} family={family} key={family.root.key} />
					))}
				</div>
			)}
			<OrphanWorktrees />
			<SavedWorktrees />
		</div>
	);
}

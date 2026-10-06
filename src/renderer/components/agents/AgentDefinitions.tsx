/**
 * Agents › Definitions: every project / user / bundled agent discovered for
 * the attached workspace, with enable/disable, a per-agent model override and
 * a prewalk override (the task.disabledAgents / task.agentModelOverrides /
 * task.agentPrewalk settings the TUI agent dashboard writes). Names that only
 * survive in settings or in the live roster stay listed so their overrides
 * can still be cleared.
 */

import { RefreshCw, Users } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { RpcAgentDefinitionInfo } from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSubagentsStore } from "../../stores/subagents";
import { Badge, Button, EmptyState, IconButton, Input, SearchField, Select, Spinner, Switch, Tabs } from "../common";
import { type AgentSettingsState, agentSourceLabel, useAgentSettings } from "./agent-settings";

interface DefinitionEntry extends Partial<RpcAgentDefinitionInfo> {
	name: string;
}

type PrewalkState = "default" | "on" | "off";
const PREWALK_STATES: readonly PrewalkState[] = ["default", "on", "off"];

/** Current prewalk override for an agent (agent default → on → off). */
function prewalkStateOf(overrides: Record<string, string>, name: string): PrewalkState {
	const value = overrides[name]?.trim().toLowerCase();
	return value === "on" || value === "off" ? value : "default";
}

function formatAgentOutput(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function DefinitionDetails({
	entry,
	override,
	prewalk,
}: {
	entry: DefinitionEntry;
	override: string | undefined;
	prewalk: PrewalkState;
}) {
	const t = useT();
	const yesNo = (value: boolean | undefined) =>
		value === undefined ? undefined : value ? t("common.yes") : t("common.no");
	const details = [
		[t("agentHub.defs.detail.path"), entry.filePath],
		[t("agentHub.defs.detail.defaultPattern"), entry.defaultPatterns?.join(", ") || t("agentHub.defs.modelSession")],
		[t("agentHub.defs.detail.defaultResolved"), entry.defaultResolved],
		[
			t("agentHub.defs.detail.effectivePattern"),
			override || entry.effectivePatterns?.join(", ") || t("agentHub.defs.modelSession"),
		],
		[
			t("agentHub.defs.detail.effectiveResolved"),
			[entry.effectiveResolved, entry.effectiveThinkingLevel].filter(Boolean).join(" · ") || undefined,
		],
		[
			t("agentHub.defs.detail.prewalk"),
			[
				t(`agentHub.defs.prewalk.${prewalk}`),
				entry.prewalkPattern,
				entry.prewalkResolved ? `→ ${entry.prewalkResolved}` : undefined,
			]
				.filter(Boolean)
				.join(" "),
		],
		[t("agentHub.defs.detail.thinking"), entry.thinkingLevel],
		[t("agentHub.defs.detail.tools"), entry.tools?.join(", ")],
		[
			t("agentHub.defs.detail.spawns"),
			entry.spawns === "*" ? "*" : Array.isArray(entry.spawns) ? entry.spawns.join(", ") : undefined,
		],
		[t("agentHub.defs.detail.skills"), entry.autoloadSkills?.join(", ")],
		[t("agentHub.defs.detail.blocking"), yesNo(entry.blocking)],
		[t("agentHub.defs.detail.readSummarize"), yesNo(entry.readSummarize)],
		[t("agentHub.defs.detail.output"), formatAgentOutput(entry.output)],
	].filter((row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0);

	return (
		<details className="group/details">
			<summary className="w-fit cursor-pointer rounded-(--sc-radius-sm) text-sc-xs text-(--sc-text-muted) hover:text-(--sc-text)">
				{t("agentHub.defs.inspect")}
			</summary>
			<dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-(--sc-radius-md) bg-(--sc-surface-1) px-3 py-2 text-sc-xs">
				{details.map(([label, value]) => (
					<div className="contents" key={label}>
						<dt className="text-(--sc-text-muted)">{label}</dt>
						<dd className="font-mono break-all text-(--sc-text-secondary)">{value}</dd>
					</div>
				))}
			</dl>
		</details>
	);
}

const DefinitionRow = memo(function DefinitionRow({
	entry,
	state,
	busy,
	editing,
	onToggle,
	onBeginModelEdit,
	onCancelModelEdit,
	onSaveModel,
	onSetPrewalk,
}: {
	entry: DefinitionEntry;
	state: AgentSettingsState;
	busy: boolean;
	editing: boolean;
	onToggle: (name: string, disabled: boolean) => void;
	onBeginModelEdit: (name: string) => void;
	onCancelModelEdit: () => void;
	onSaveModel: (name: string, raw: string) => void;
	onSetPrewalk: (name: string, next: PrewalkState) => void;
}) {
	const t = useT();
	const [draft, setDraft] = useState("");
	const disabled = state.disabledAgents.includes(entry.name);
	const override = state.modelOverrides[entry.name]?.trim() || undefined;
	const prewalk = prewalkStateOf(state.prewalkOverrides, entry.name);

	// Seed the draft when this row enters edit mode.
	useEffect(() => {
		if (editing) setDraft(override ?? "");
	}, [editing, override]);

	return (
		<li className="flex flex-col gap-2.5 py-4">
			<div className="flex items-start gap-4">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<h3
							className={cx(
								"text-sc-md font-medium",
								disabled ? "text-(--sc-text-muted) line-through" : "text-(--sc-text)",
							)}
						>
							{entry.name}
						</h3>
						{entry.source && <Badge variant="default">{agentSourceLabel(t, entry.source)}</Badge>}
						{disabled && <Badge variant="warning">{t("agentHub.defs.disabledBadge")}</Badge>}
					</div>
					{entry.description && (
						<p className="mt-0.5 line-clamp-2 text-sc-sm text-(--sc-text-muted)">{entry.description}</p>
					)}
				</div>
				<Switch
					checked={!disabled}
					disabled={busy}
					label={t("agents.defs.enableAgent", { name: entry.name })}
					onCheckedChange={enabled => onToggle(entry.name, !enabled)}
				/>
			</div>
			<div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sc-sm">
				<div className="flex min-w-0 items-center gap-2">
					<span className="shrink-0 text-(--sc-text-muted)">{t("agentHub.defs.modelLabel")}</span>
					{editing ? (
						<>
							<Input
								aria-label={t("agentHub.defs.modelLabel")}
								autoFocus
								className="w-64"
								controlSize="sm"
								disabled={busy}
								mono
								onChange={event => setDraft(event.target.value)}
								onKeyDown={event => {
									if (isImeKeyEvent(event)) return;
									if (event.key === "Enter") onSaveModel(entry.name, draft);
									else if (event.key === "Escape") {
										// The edit owns Escape; the page must not close under it.
										event.preventDefault();
										event.stopPropagation();
										onCancelModelEdit();
									}
								}}
								placeholder={t("agentHub.defs.modelPlaceholder")}
								value={draft}
							/>
							<Button
								disabled={busy}
								onClick={() => onSaveModel(entry.name, draft)}
								size="sm"
								variant="secondary"
							>
								{t("common.save")}
							</Button>
							<Button disabled={busy} onClick={onCancelModelEdit} size="sm" variant="ghost">
								{t("common.cancel")}
							</Button>
						</>
					) : (
						<>
							<span
								className={cx("truncate", override ? "font-mono text-(--sc-text)" : "text-(--sc-text-subtle)")}
							>
								{override ?? t("agentHub.defs.modelSession")}
							</span>
							<Button disabled={busy} onClick={() => onBeginModelEdit(entry.name)} size="sm" variant="ghost">
								{t("agentHub.defs.modelEdit")}
							</Button>
						</>
					)}
				</div>
				<div className="flex items-center gap-2">
					<span className="text-(--sc-text-muted)">{t("agentHub.defs.prewalkLabel")}</span>
					<Select
						aria-label={t("agentHub.defs.prewalkLabel")}
						controlSize="sm"
						disabled={busy}
						onChange={event => onSetPrewalk(entry.name, event.target.value as PrewalkState)}
						options={PREWALK_STATES.map(value => ({ value, label: t(`agentHub.defs.prewalk.${value}`) }))}
						value={prewalk}
					/>
				</div>
			</div>
			<DefinitionDetails entry={entry} override={override} prewalk={prewalk} />
		</li>
	);
});

type SourceFilter = "all" | RpcAgentDefinitionInfo["source"];
const SOURCE_FILTERS: readonly SourceFilter[] = ["all", "project", "user", "bundled"];

export function AgentDefinitions() {
	const tabRpc = useTabRpc();
	const t = useT();
	const rpc = useAgentSettings();
	const subagents = useSubagentsStore(s => s.subagents);
	const [query, setQuery] = useState("");
	const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
	const [editingName, setEditingName] = useState<string | null>(null);

	// Every definition discovered for the workspace, plus settings-only and
	// live-session names in case a definition was removed.
	const entries = useMemo(() => {
		const state = rpc.state;
		const byName = new Map<string, DefinitionEntry>();
		if (state) {
			for (const definition of state.definitions) byName.set(definition.name, definition);
			const settingsNames = [
				...state.disabledAgents,
				...Object.keys(state.modelOverrides),
				...Object.keys(state.prewalkOverrides),
			];
			for (const name of settingsNames) if (!byName.has(name)) byName.set(name, { name });
		}
		for (const sub of subagents.values()) {
			const existing = byName.get(sub.agent);
			if (!existing) byName.set(sub.agent, { name: sub.agent, source: sub.agentSource });
			else if (!existing.source) byName.set(sub.agent, { ...existing, source: sub.agentSource });
		}
		return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}, [rpc.state, subagents]);

	const sourceCounts = useMemo(() => {
		const counts: Record<SourceFilter, number> = { all: entries.length, project: 0, user: 0, bundled: 0 };
		for (const entry of entries) {
			if (entry.source && entry.source in counts) counts[entry.source as RpcAgentDefinitionInfo["source"]]++;
		}
		return counts;
	}, [entries]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return entries.filter(entry => {
			if (sourceFilter !== "all" && entry.source !== sourceFilter) return false;
			return !q || entry.name.toLowerCase().includes(q) || entry.description?.toLowerCase().includes(q);
		});
	}, [entries, query, sourceFilter]);

	const toggleAgent = useCallback(
		(name: string, disabled: boolean) => {
			const state = rpc.state;
			if (!state) return;
			const next = new Set(state.disabledAgents);
			if (disabled) next.add(name);
			else next.delete(name);
			const disabledAgents = [...next].sort((a, b) => a.localeCompare(b));
			void rpc.mutate({ ...state, disabledAgents }, () => tabRpc.setSetting("task.disabledAgents", disabledAgents));
		},
		[rpc, tabRpc.setSetting],
	);

	const saveModel = useCallback(
		(name: string, raw: string) => {
			const state = rpc.state;
			if (!state) return;
			const value = raw.trim();
			const modelOverrides = { ...state.modelOverrides };
			if (value) modelOverrides[name] = value;
			else delete modelOverrides[name];
			setEditingName(null);
			void rpc.mutate({ ...state, modelOverrides }, () =>
				tabRpc.setSetting("task.agentModelOverrides", modelOverrides),
			);
		},
		[rpc, tabRpc.setSetting],
	);

	const setPrewalk = useCallback(
		(name: string, next: PrewalkState) => {
			const state = rpc.state;
			if (!state) return;
			const prewalkOverrides = { ...state.prewalkOverrides };
			if (next === "default") delete prewalkOverrides[name];
			else prewalkOverrides[name] = next;
			void rpc.mutate({ ...state, prewalkOverrides }, () =>
				tabRpc.setSetting("task.agentPrewalk", prewalkOverrides),
			);
		},
		[rpc, tabRpc.setSetting],
	);

	const loadedState = rpc.state;
	const notConnected = !rpc.ready ? t("agentHub.notConnected") : undefined;

	return (
		<div className="flex flex-col gap-4">
			<p className="text-sc-sm text-(--sc-text-muted)">{t("agentHub.defs.footerNote")}</p>
			<div className="flex flex-wrap items-center gap-3">
				<SearchField
					className="min-w-48 flex-1"
					label={t("agentHub.defs.searchPlaceholder")}
					onValueChange={setQuery}
					placeholder={t("agentHub.defs.searchPlaceholder")}
					value={query}
				/>
				<Tabs
					activeId={sourceFilter}
					ariaLabel={t("agents.defs.sourceFilter")}
					onChange={id => setSourceFilter(id as SourceFilter)}
					tabs={SOURCE_FILTERS.map(source => ({
						id: source,
						label: source === "all" ? t("agentHub.source.all") : t(`agentHub.source.${source}`),
						badge: sourceCounts[source],
					}))}
					variant="segmented"
				/>
				<IconButton
					disabled={!rpc.ready || rpc.loading}
					icon={<RefreshCw className={rpc.loading ? "animate-spin" : undefined} />}
					label={notConnected ?? t("agentHub.refresh")}
					onClick={rpc.refresh}
				/>
			</div>

			{!loadedState ? (
				rpc.loading || (!rpc.error && rpc.ready) ? (
					<div className="flex justify-center py-12">
						<Spinner label={t("common.loading")} />
					</div>
				) : (
					<EmptyState
						actions={
							<Button
								disabled={!rpc.ready}
								icon={<RefreshCw />}
								onClick={rpc.refresh}
								size="sm"
								title={notConnected}
								variant="secondary"
							>
								{t("agentHub.retry")}
							</Button>
						}
						description={<span role="alert">{rpc.error}</span>}
						icon={<Users />}
						title={t("agentHub.loadFailed")}
					/>
				)
			) : filtered.length === 0 ? (
				<EmptyState
					actions={
						query || sourceFilter !== "all" ? (
							<Button
								onClick={() => {
									setQuery("");
									setSourceFilter("all");
								}}
								size="sm"
								variant="secondary"
							>
								{t("agents.defs.clearFilters")}
							</Button>
						) : undefined
					}
					description={t("agentHub.defs.emptyHint")}
					icon={<Users />}
					title={t("agentHub.defs.empty")}
				/>
			) : (
				<ul className="divide-y divide-(--sc-divider) border-y border-(--sc-divider)">
					{filtered.map(entry => (
						<DefinitionRow
							busy={rpc.busy || !rpc.ready}
							editing={editingName === entry.name}
							entry={entry}
							key={entry.name}
							onBeginModelEdit={setEditingName}
							onCancelModelEdit={() => setEditingName(null)}
							onSaveModel={saveModel}
							onSetPrewalk={setPrewalk}
							onToggle={toggleAgent}
							state={loadedState}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

/**
 * Agents › Definitions: every project / user / bundled agent discovered for
 * the attached workspace, with enable/disable, a per-agent model override and
 * a prewalk override (the task.disabledAgents / task.agentModelOverrides /
 * task.agentPrewalk settings the TUI agent dashboard writes). Names that only
 * survive in settings or in the live roster stay listed so their overrides
 * can still be cleared.
 *
 * Authoring: New agent / Templates open the agent editor and the template
 * gallery; each row's menu edits, duplicates (a bundled or plugin agent
 * becomes an overriding user/project copy), opens, reveals or deletes the
 * definition file. Only files directly in the user or project agents
 * directory are editable.
 */

import {
	ChevronRight,
	Copy,
	ExternalLink,
	FolderOpen,
	LayoutTemplate,
	MoreHorizontal,
	Pencil,
	Plus,
	RefreshCw,
	Trash2,
	Users,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { type AgentDraft, draftFromFields, emptyAgentDraft, splitFrontmatter } from "../../../shared/agent-definition";
import { replaceModelLine, templateModelOffer } from "../../../shared/agent-template-migration";
import { type AgentTemplate, templateDraft } from "../../../shared/agent-templates";
import type {
	AgentFileScope,
	RpcAgentDefinitionDetail,
	RpcAgentDefinitionInfo,
	RpcAgentFileContent,
} from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { useTabRpc } from "../../lib/tab-rpc";
import { useFocusedTabDevice } from "../../stores/remote";
import { useSubagentsStore } from "../../stores/subagents";
import { toast, toastError } from "../../stores/toast";
import {
	Badge,
	Button,
	ConfirmDialog,
	type ContextMenuItem,
	EmptyState,
	IconButton,
	Input,
	MenuButton,
	SearchField,
	Select,
	Spinner,
	Switch,
	Tabs,
} from "../common";
import { AgentEditorSheet, type AgentEditorTarget, revealAgentFile } from "./AgentEditorSheet";
import { AgentModelUpdateDialog, type AgentModelUpdateTarget } from "./AgentModelUpdateDialog";
import { AgentTemplateGallery } from "./AgentTemplateGallery";
import { type AgentSettingsState, agentSourceLabel, useAgentSettings } from "./agent-settings";

type DefinitionAction = "edit" | "duplicate" | "open" | "reveal" | "delete";

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
			<summary className="flex min-h-(--sc-control-sm) w-fit cursor-pointer list-none items-center gap-1 rounded-(--sc-radius-sm) text-sc-xs text-(--sc-text-muted) hover:text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring) [&::-webkit-details-marker]:hidden">
				<ChevronRight aria-hidden className="size-3 shrink-0 group-open/details:rotate-90" />
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

/** The row's ⋯ menu: only files in the user/project agents directory are editable; anything discovered can be copied. */
function DefinitionMenu({
	entry,
	onAction,
}: {
	entry: DefinitionEntry;
	onAction: (action: DefinitionAction, entry: DefinitionEntry) => void;
}) {
	const t = useT();
	// A remote tab's agent files live on its host: no native app here can open or reveal them.
	const remoteTab = useFocusedTabDevice() !== undefined;
	if (!entry.source) return null;
	const editable = Boolean(entry.scope && entry.filePath);
	const onDisk = Boolean(
		!remoteTab && entry.filePath && !entry.filePath.startsWith("embedded:") && entry.source !== "bundled",
	);
	const item = (id: DefinitionAction, label: string, icon: ContextMenuItem["icon"], danger?: boolean) => ({
		id,
		label,
		icon,
		danger,
		onSelect: () => onAction(id, entry),
	});
	const items: ContextMenuItem[] = [
		...(editable ? [item("edit", t("agentStudio.row.edit"), Pencil)] : []),
		item("duplicate", entry.scope ? t("agentStudio.row.duplicate") : t("agentStudio.row.customizeCopy"), Copy),
		...(onDisk
			? [
					item("open", t("agentStudio.file.open"), ExternalLink),
					item("reveal", t("agentStudio.file.reveal"), FolderOpen),
				]
			: []),
		...(editable ? [item("delete", t("agentStudio.row.delete"), Trash2, true)] : []),
	];
	return (
		<MenuButton
			align="end"
			icon={<MoreHorizontal />}
			items={items}
			label={t("agentStudio.row.menu", { name: entry.name })}
			size="sm"
			variant="ghost"
		/>
	);
}

/** `<name>-copy`, `<name>-copy-2`, … — the first name no discovered agent uses. */
function copyName(name: string, taken: readonly string[]): string {
	const used = new Set(taken.map(entry => entry.toLowerCase()));
	for (let index = 1; ; index++) {
		const candidate = index === 1 ? `${name}-copy` : `${name}-copy-${index}`;
		if (!used.has(candidate.toLowerCase())) return candidate;
	}
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
	onOfferUpdate,
	onAction,
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
	onOfferUpdate: (entry: DefinitionEntry) => void;
	onAction: (action: DefinitionAction, entry: DefinitionEntry) => void;
}) {
	const t = useT();
	const [draft, setDraft] = useState("");
	const disabled = state.disabledAgents.includes(entry.name);
	const override = state.modelOverrides[entry.name]?.trim() || undefined;
	const prewalk = prewalkStateOf(state.prewalkOverrides, entry.name);
	const offer = templateModelOffer(entry);

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
				<DefinitionMenu entry={entry} onAction={onAction} />
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
			{offer && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sc-sm text-(--sc-text-muted)">
					<span>{t(offer.legacy ? "agentHub.defs.roleModel.hint" : "agentHub.defs.roleModel.hintEdited")}</span>
					<Button disabled={busy} onClick={() => onOfferUpdate(entry)} size="sm" variant="secondary">
						{t("agentHub.defs.roleModel.update")}
					</Button>
				</div>
			)}
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

	const [editorTarget, setEditorTarget] = useState<AgentEditorTarget | null>(null);
	const [galleryOpen, setGalleryOpen] = useState(false);
	const [deleting, setDeleting] = useState<DefinitionEntry | null>(null);
	const [deleteBusy, setDeleteBusy] = useState(false);
	const definitions = rpc.state?.definitions ?? [];

	const failed = useCallback(
		(message: string) => toastError({ title: t("agentHub.actionFailed"), error: message }),
		[t],
	);

	const readFile = useCallback(
		async (filePath: string): Promise<RpcAgentFileContent | null> => {
			const response = await tabRpc.readAgentFile(filePath);
			if (!response.success) {
				failed(response.error);
				return null;
			}
			return response.data as RpcAgentFileContent;
		},
		[tabRpc, failed],
	);

	const onAction = useCallback(
		async (action: DefinitionAction, entry: DefinitionEntry) => {
			const filePath = entry.filePath;
			if (action === "open" || action === "reveal") {
				if (filePath) await revealAgentFile(filePath, action, t("agentStudio.file.openFailed"));
				return;
			}
			if (action === "delete") {
				setDeleting(entry);
				return;
			}
			if (action === "edit" && filePath) {
				const file = await readFile(filePath);
				if (!file) return;
				const draft = file.parsed
					? draftFromFields(file.parsed.fields, file.parsed.body)
					: { ...emptyAgentDraft(), name: entry.name, instructions: splitFrontmatter(file.content).body };
				setEditorTarget({
					mode: "edit",
					draft,
					scope: file.scope,
					original: file.content,
					filePath: file.filePath,
					parseError: file.parseError,
				});
				return;
			}
			if (action !== "duplicate") return;
			const taken = (rpc.state?.definitions ?? []).map(definition => definition.name);
			if (entry.scope && filePath) {
				// A copy of an editable file keeps its unknown keys and comments.
				const file = await readFile(filePath);
				if (!file) return;
				if (!file.parsed) {
					failed(file.parseError ?? t("agentHub.actionFailed"));
					return;
				}
				const draft = draftFromFields(file.parsed.fields, file.parsed.body);
				setEditorTarget({
					mode: "create",
					draft: { ...draft, name: copyName(draft.name || entry.name, taken) },
					scope: file.scope,
					original: file.content,
				});
				return;
			}
			// Bundled and plugin agents: same name, so the copy overrides the original.
			const response = await tabRpc.getAgentDefinition(entry.name);
			if (!response.success) {
				failed(response.error);
				return;
			}
			const detail = response.data as RpcAgentDefinitionDetail;
			const { systemPrompt, ...fields } = detail;
			setEditorTarget({ mode: "create", draft: draftFromFields(fields, systemPrompt), scope: "user" });
		},
		[readFile, rpc.state, tabRpc, failed, t],
	);

	const [modelUpdate, setModelUpdate] = useState<AgentModelUpdateTarget | null>(null);

	// The offer is recomputed from the file as it is now, so the diff is what a click writes.
	const offerModelUpdate = useCallback(
		async (entry: DefinitionEntry) => {
			if (!entry.filePath) return;
			const file = await readFile(entry.filePath);
			if (!file) return;
			const offer = templateModelOffer({
				name: entry.name,
				scope: file.scope,
				filePath: file.filePath,
				model: file.parsed?.fields.model,
			});
			if (!offer) {
				rpc.refresh();
				return;
			}
			const edit = replaceModelLine(file.content, offer.to);
			if (!edit) {
				failed(t("agentHub.defs.roleModel.noLine", { name: entry.name }));
				return;
			}
			setModelUpdate({ name: entry.name, scope: file.scope, filePath: file.filePath, offer, edit });
		},
		[readFile, failed, rpc, t],
	);

	const openNew = (draft: AgentDraft = emptyAgentDraft(), scope: AgentFileScope = "user") =>
		setEditorTarget({ mode: "create", draft, scope });

	const onSaved = (saved: { name: string; filePath: string }) => {
		setEditorTarget(null);
		toast({ variant: "success", title: t("agentStudio.save.saved", { name: saved.name }), message: saved.filePath });
		rpc.refresh();
	};

	const confirmDelete = async () => {
		const filePath = deleting?.filePath;
		if (!deleting || !filePath) return;
		setDeleteBusy(true);
		try {
			const response = await tabRpc.deleteAgentFile(filePath);
			if (!response.success) failed(response.error);
			else
				toast({
					variant: "success",
					title: t("agentStudio.delete.done", { name: deleting.name }),
					message: filePath,
				});
			setDeleting(null);
			rpc.refresh();
		} finally {
			setDeleteBusy(false);
		}
	};

	const loadedState = rpc.state;
	const notConnected = !rpc.ready ? t("agentHub.notConnected") : undefined;

	return (
		<div className="flex flex-col gap-4">
			<p className="text-sc-sm text-(--sc-text-muted)">{t("agentHub.defs.footerNote")}</p>
			<div className="flex flex-wrap items-center gap-3">
				<SearchField
					className="min-w-0 flex-1 basis-48"
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
				<div className="ml-auto flex flex-wrap items-center gap-2">
					<IconButton
						disabled={!rpc.ready}
						icon={<RefreshCw />}
						label={notConnected ?? t("common.refresh")}
						loading={rpc.loading}
						onClick={rpc.refresh}
					/>
					<Button
						disabled={!rpc.ready}
						icon={<LayoutTemplate />}
						onClick={() => setGalleryOpen(true)}
						title={notConnected}
						variant="secondary"
					>
						{t("agentStudio.templates")}
					</Button>
					<Button
						disabled={!rpc.ready}
						icon={<Plus />}
						onClick={() => openNew()}
						title={notConnected}
						variant="primary"
					>
						{t("agentStudio.newAgent")}
					</Button>
				</div>
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
								{t("common.retry")}
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
							onAction={onAction}
							onBeginModelEdit={setEditingName}
							onCancelModelEdit={() => setEditingName(null)}
							onSaveModel={saveModel}
							onSetPrewalk={setPrewalk}
							onOfferUpdate={offerModelUpdate}
							onToggle={toggleAgent}
							state={loadedState}
						/>
					))}
				</ul>
			)}

			<AgentEditorSheet
				definitions={definitions}
				onClose={() => setEditorTarget(null)}
				onSaved={onSaved}
				target={editorTarget}
			/>
			<AgentModelUpdateDialog onClose={() => setModelUpdate(null)} onDone={rpc.refresh} target={modelUpdate} />
			<AgentTemplateGallery
				definitions={definitions}
				onClose={() => setGalleryOpen(false)}
				onCustomize={(template: AgentTemplate, scope) => {
					setGalleryOpen(false);
					openNew(templateDraft(template), scope);
				}}
				onInstalled={rpc.refresh}
				open={galleryOpen}
			/>
			<ConfirmDialog
				busy={deleteBusy}
				confirmLabel={t("agentStudio.row.delete")}
				message={deleting?.filePath ?? ""}
				onCancel={() => setDeleting(null)}
				onConfirm={() => void confirmDelete()}
				open={deleting !== null}
				title={t("agentStudio.delete.title", { name: deleting?.name ?? "" })}
				warning={t("agentStudio.delete.warning")}
			/>
		</div>
	);
}

/**
 * One model role in Settings › Models & accounts › Model roles: what it is
 * for, the model it really runs on (`effective`, resolved by stock in the
 * bridge, an empty role's fallback included), that model's provider account
 * state with its live quota, the thinking level, the picker filtered by stock's
 * `accepts` (the entry's candidates) and, for a custom role, the agents that
 * use it with edit and remove.
 */

import { CircleDashed, Pencil, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { BUILTIN_ROLE_IDS, presetRole } from "../../../../resources/gui-bridge/model-role-contracts";
import type { CompactionPoint, ModelRoleEntry, ProviderInfo, UsageReport } from "../../../shared/rpc-types";
import { THINKING_LEVEL_VALUES } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { usageLimitLabel } from "../../lib/usage-labels";
import { inUseReport, tightestLimit } from "../../lib/usage-reports";
import { Badge, IconButton, ProgressBar } from "../common";
import { CompactsAt } from "./CompactsAt";
import { type ModelValueGroup, ModelValueSelect } from "./ModelValueSelect";
import { ProviderMark } from "./providers/ProviderMark";
import { SettingsRow } from "./SettingsLayout";

const KIND_ORDER: readonly ModelRoleEntry["candidates"][number]["kind"][] = [
	"chat",
	"tiny",
	"image",
	"tts",
	"stt",
	"search",
	"judge",
];

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The agents using a custom role: installed definitions, and the shipped templates not installed yet. */
export interface RoleAgents {
	installed: string[];
	templates: string[];
}

function ProviderState({
	provider,
	usage,
	t,
}: {
	provider: ProviderInfo | undefined;
	usage: readonly UsageReport[];
	t: Translate;
}) {
	if (!provider) return null;
	if (provider.disabled) return <Badge variant="muted">{t("modelRoles.account.off")}</Badge>;
	if (!provider.authenticated) {
		return (
			<Badge dot variant="warning">
				{t("modelRoles.account.signedOut")}
			</Badge>
		);
	}
	const report = inUseReport(usage, provider.id);
	const quota = report ? tightestLimit(report) : null;
	const percent = quota ? Math.round(quota.fraction * 100) : null;
	const title =
		quota && percent !== null
			? t("modelRoles.quotaTitle", { limit: usageLimitLabel(quota.limit, t), percent })
			: undefined;
	return (
		<>
			<Badge dot variant="success">
				{t("modelRoles.account.signedIn")}
			</Badge>
			{quota && percent !== null && (
				<span className="inline-flex items-center gap-1.5" title={title}>
					<span className="w-12">
						<ProgressBar ariaLabel={title} height={3} value={quota.fraction} valueText="" />
					</span>
					<span className="tabular-nums">{t("modelRoles.quota", { percent })}</span>
				</span>
			)}
		</>
	);
}

/** The effective model, its source, account state and thinking level. */
function EffectiveLine({
	entry,
	roleName,
	providers,
	usage,
	compaction,
	t,
}: {
	entry: ModelRoleEntry;
	roleName: (id: string) => string;
	providers: readonly ProviderInfo[];
	usage: readonly UsageReport[];
	t: Translate;
	compaction?: CompactionPoint;
}) {
	const effective = entry.effective;
	if (!effective) {
		return compaction ? (
			<p className="text-sc-xs text-(--sc-text-muted)">
				<CompactsAt compact point={compaction} />
			</p>
		) : null;
	}
	if (!effective.model) {
		return (
			<p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sc-xs text-(--sc-text-muted)">
				{effective.unavailable ? (
					<>
						<Badge dot variant="warning">
							{t("modelRoles.unavailable")}
						</Badge>
						<span title={t("modelRoles.unavailableHint", { model: entry.model ?? "" })}>{entry.model}</span>
					</>
				) : (
					t("modelRoles.noModel")
				)}
			</p>
		);
	}
	const providerId = effective.model.slice(0, effective.model.indexOf("/"));
	const level = effective.thinkingLevel;
	const levelName =
		level && (level === "auto" || THINKING_LEVEL_VALUES.some(known => known === level))
			? t(`input.thinking.name.${level}`)
			: level;
	const source =
		effective.source === "fallback"
			? effective.via
				? t("modelRoles.src.via", { role: roleName(effective.via) })
				: t("modelRoles.src.builtin")
			: effective.source === "session"
				? t("modelRoles.src.session")
				: undefined;
	return (
		<p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sc-sm text-(--sc-text-secondary)" data-role-status>
			<span className="font-medium text-(--sc-text)" title={effective.model}>
				{effective.name ?? effective.model}
			</span>
			{source && <span className="text-(--sc-text-muted)">{source}</span>}
			<ProviderState provider={providers.find(provider => provider.id === providerId)} t={t} usage={usage} />
			<span className="text-(--sc-text-muted)">
				{levelName ? t("modelRoles.thinking", { level: levelName }) : t("modelRoles.thinkingSession")}
			</span>
			{compaction && <CompactsAt className="text-(--sc-text-muted)" compact point={compaction} />}
		</p>
	);
}

/** The provider id of the model a role resolves to (its own pick, else what it falls back to); "" when none. */
function roleProviderId(entry: ModelRoleEntry): string {
	const model = entry.effective?.model ?? entry.model ?? "";
	const slash = model.indexOf("/");
	return slash < 0 ? "" : model.slice(0, slash);
}

export function ModelRoleRow({
	entry,
	name,
	roleName,
	providers,
	usage,
	agents,
	compaction,
	busy,
	sidecarReady,
	onChange,
	onEdit,
	onRemove,
}: {
	entry: ModelRoleEntry;
	/** The role's display name. */
	name: string;
	/** A role id's display name, for "from Fast" and fallback lists. */
	roleName: (id: string) => string;
	providers: readonly ProviderInfo[];
	usage: readonly UsageReport[];
	/** Set for a custom role. */
	agents?: RoleAgents;
	/** Where the role's resolved model compacts (omp 18.8.5+; absent before). */
	compaction?: CompactionPoint;
	busy: boolean;
	sidecarReady: boolean;
	onChange: (role: string, modelId: string | null) => void;
	onEdit?: (entry: ModelRoleEntry) => void;
	onRemove?: (entry: ModelRoleEntry) => void;
}) {
	const t = useT();
	const preset = presetRole(entry.id);
	const custom = agents !== undefined;
	const candidates = entry.candidates ?? [];
	// Candidates grouped by model kind; display name first, selector beside it.
	const groups = useMemo<ModelValueGroup[]>(
		() =>
			KIND_ORDER.map(kind => ({
				label: t(`modelRoles.kind.${kind}`),
				options: candidates
					.filter(candidate => candidate.kind === kind)
					.map(candidate => {
						const value = `${candidate.provider}/${candidate.id}`;
						const named = candidate.name.length > 0 && candidate.name !== candidate.id;
						return named ? { value, label: candidate.name, detail: value } : { value };
					}),
			})).filter(group => group.options.length > 0),
		[candidates, t],
	);

	// A built-in role of a newer omp has no text here yet: its row stays quiet instead of showing a raw key.
	const known = BUILTIN_ROLE_IDS.includes(entry.id);
	const use = custom
		? (entry.description ?? (preset ? t(`modelRoles.use.${entry.id}`) : t("modelRoles.use.custom", { id: entry.id })))
		: known
			? t(`modelRoles.use.${entry.id}`)
			: undefined;
	// An empty role says what it follows.
	const empty = entry.model === undefined;
	let fallback: string | undefined;
	if (empty && preset)
		fallback = t("modelRoles.fallback.preset", { roles: preset.fallback.map(roleName).join(" → ") });
	else if (empty && custom) fallback = t("modelRoles.fallback.custom");
	else if (empty && known) fallback = t(`modelRoles.fallback.${entry.id}`);
	const used = agents && (agents.installed.length > 0 || agents.templates.length > 0);

	return (
		<SettingsRow
			// A role tag is a name, not a state: neutral like every other tag. What an empty role follows sits
			// on the same line, muted and truncated (full text on hover).
			badge={
				<>
					{custom ? <Badge>@{entry.id}</Badge> : entry.tag ? <Badge>{entry.tag}</Badge> : undefined}
					{fallback && (
						<span
							className="min-w-0 flex-1 basis-24 truncate text-sc-xs text-(--sc-text-muted)"
							data-role-fallback
							title={fallback}
						>
							{fallback}
						</span>
					)}
				</>
			}
			control={
				<div className="flex items-center gap-1">
					<ModelValueSelect
						ariaLabel={t("modelRoles.select", { role: name })}
						clearLabel={custom ? t("modelRoles.notSet") : t("modelRoles.default")}
						disabled={busy || !sidecarReady}
						groups={groups}
						kind="model"
						onCommit={next => onChange(entry.id, next === "" ? null : next)}
						placeholder={custom ? t("modelRoles.notSet") : t("modelRoles.default")}
						title={!sidecarReady ? t("modelRoles.notConnected") : undefined}
						value={entry.model ?? ""}
					/>
					{custom && onEdit && (
						<IconButton
							disabled={!sidecarReady}
							icon={<Pencil />}
							label={t("modelRoles.edit", { role: name })}
							onClick={() => onEdit(entry)}
							size="sm"
						/>
					)}
					{custom && !preset && onRemove && (
						<IconButton
							disabled={!sidecarReady}
							icon={<Trash2 />}
							label={t("modelRoles.remove", { role: name })}
							onClick={() => onRemove(entry)}
							size="sm"
						/>
					)}
				</div>
			}
			description={use}
			icon={
				roleProviderId(entry) ? (
					<ProviderMark provider={{ id: roleProviderId(entry), name: roleProviderId(entry) }} />
				) : (
					<CircleDashed />
				)
			}
			id={`model-role-${entry.id}`}
			label={name}
		>
			<div className="space-y-0.5 ps-7">
				<EffectiveLine
					compaction={compaction}
					entry={entry}
					providers={providers}
					roleName={roleName}
					t={t}
					usage={usage}
				/>
				{agents && (
					<p className="text-sc-xs text-(--sc-text-muted)">
						{agents.installed.length > 0 && (
							<span className="block">{t("modelRoles.usedBy", { agents: agents.installed.join(", ") })}</span>
						)}
						{agents.templates.length > 0 && (
							<span className="block">{t("modelRoles.templates", { agents: agents.templates.join(", ") })}</span>
						)}
						{!used && <span className="block">{t("modelRoles.unused", { id: entry.id })}</span>}
					</p>
				)}
				{entry.source === "project" && (
					<p className="text-sc-xs text-(--sc-text-muted)">{t("modelRoles.sourceProject")}</p>
				)}
				{candidates.length === 0 && (
					<p className="text-sc-xs text-(--sc-text-muted)">{t("modelRoles.noCandidates")}</p>
				)}
			</div>
		</SettingsRow>
	);
}

/**
 * One model role in Settings › Models & accounts › Model roles: what it is for
 * and what an empty one falls back to (`model-role-text.ts`, generic for a role
 * no locale knows), the model it really runs on (`effective`, resolved by stock
 * in the bridge, an empty role's fallback included), that model's provider
 * account state with its live quota, the thinking level and the picker filtered
 * by stock's `accepts` (the entry's candidates).
 */

import { CircleDashed } from "lucide-react";
import { useMemo } from "react";
import type {
	CompactionPoint,
	ModelRoleEffective,
	ModelRoleEntry,
	ProviderInfo,
	UsageReport,
} from "../../../shared/rpc-types";
import { THINKING_LEVEL_VALUES } from "../../../shared/rpc-types";
import { useLang, useT } from "../../lib/i18n";
import { usageLimitLabel } from "../../lib/usage-labels";
import { inUseReport, tightestLimit } from "../../lib/usage-reports";
import { useUiStore } from "../../stores/ui";
import { Badge, ProgressBar } from "../common";
import { SettingInfo } from "../common/SettingInfo";
import { CompactsAt } from "./CompactsAt";
import { JUDGE_ASSIST_SETTING_TARGET } from "./JudgeAssistRow";
import { type ModelValueGroup, ModelValueSelect } from "./ModelValueSelect";
import { roleFallback, rolePurpose } from "./model-role-text";
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

/**
 * What stock prefers for an empty role but cannot use for want of a key (`effective.skipped`): one muted line whose
 * provider names, each a link to its card in Providers & accounts, are the ones that would lift the skip. Names come
 * from the catalog and the provider list, never from this file. The benefit sits behind the (i): stock marks a native
 * judge model as cheaper than a prompted completion for classification (`prompts/system/workflow-notice.md`) and
 * never lets a prompted model stand in for one (`judgment/index.ts` `textJudgeRoleChain`), but says nothing about speed.
 */
function SkippedLine({
	effective,
	providers,
	t,
}: {
	effective: ModelRoleEffective;
	providers: readonly ProviderInfo[];
	t: Translate;
}) {
	const { lang } = useLang();
	const skipped = effective.skipped;
	if (!skipped) return null;
	const slot = "\u0001";
	const [before = "", after = ""] = t("modelRoles.skipped", { model: skipped.name, providers: slot }).split(slot);
	const listed = skipped.providers.map(id => providers.find(provider => provider.id === id));
	const parts = new Intl.ListFormat(lang, { type: "disjunction" }).formatToParts(
		skipped.providers.map((id, index) => listed[index]?.name ?? id),
	);
	const info = [
		t("modelRoles.skipped.info", { model: skipped.name, using: effective.name ?? effective.model ?? "" }),
		skipped.kind === "judge" ? t("modelRoles.skipped.infoJudge") : "",
	]
		.filter(Boolean)
		.join(" ");
	let element = 0;
	return (
		<p className="text-sc-xs text-(--sc-text-muted)" data-role-skipped={skipped.model}>
			{before}
			{parts.map(part => {
				if (part.type === "literal") return part.value;
				const index = element++;
				const id = skipped.providers[index] ?? "";
				return listed[index] ? (
					<button
						className="inline cursor-pointer rounded-(--sc-radius-sm) text-(--sc-accent) underline-offset-2 hover:underline focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)"
						data-provider-link={id}
						key={id}
						onClick={() => useUiStore.getState().focusProvider(id)}
						title={t("modelRoles.skipped.open", { provider: part.value })}
						type="button"
					>
						{part.value}
					</button>
				) : (
					<span key={id}>{part.value}</span>
				);
			})}
			{after}
			<span className="ms-1 inline-flex align-middle">
				<SettingInfo text={info} />
			</span>
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
	compaction,
	busy,
	sidecarReady,
	onChange,
}: {
	entry: ModelRoleEntry;
	/** The role's display name. */
	name: string;
	/** A role id's display name, for "from Fast" and fallback lists. */
	roleName: (id: string) => string;
	providers: readonly ProviderInfo[];
	usage: readonly UsageReport[];
	/** Where the role's resolved model compacts (omp 18.8.5+; absent before). */
	compaction?: CompactionPoint;
	busy: boolean;
	sidecarReady: boolean;
	onChange: (role: string, modelId: string | null) => void;
}) {
	const t = useT();
	const { lang } = useLang();
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

	// What the role is for and, while empty, what it follows: both in the info tooltip.
	const use = rolePurpose(entry, name, t, lang);
	const fallback = roleFallback(entry, t, roleName);

	return (
		<SettingsRow
			// A role tag is a name, not a state: neutral like every other tag.
			badge={entry.tag ? <Badge>{entry.tag}</Badge> : undefined}
			control={
				<ModelValueSelect
					ariaLabel={t("modelRoles.select", { role: name })}
					clearLabel={t("modelRoles.default")}
					disabled={busy || !sidecarReady}
					groups={groups}
					kind="model"
					onCommit={next => onChange(entry.id, next === "" ? null : next)}
					placeholder={t("modelRoles.default")}
					title={!sidecarReady ? t("modelRoles.notConnected") : undefined}
					value={entry.model ?? ""}
				/>
			}
			description={[use, fallback].filter(Boolean).join(" ") || undefined}
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
				{entry.effective?.skipped && <SkippedLine effective={entry.effective} providers={providers} t={t} />}
				{entry.id === "judge" && (
					// Quiet pointer to what OMPdesk asks this role (Settings › Agent behavior), never a notice about the model.
					<p className="text-sc-xs">
						<button
							className="cursor-pointer rounded-(--sc-radius-sm) text-(--sc-accent) underline-offset-2 hover:underline focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)"
							data-judge-assist-link=""
							onClick={() => useUiStore.getState().openSettings(JUDGE_ASSIST_SETTING_TARGET)}
							type="button"
						>
							{t("modelRoles.judgeSmallDecisions")}
						</button>
					</p>
				)}
				{entry.source === "project" && (
					<p className="text-sc-xs text-(--sc-text-muted)">{t("modelRoles.sourceProject")}</p>
				)}
				{/* The effective line already says whether the role resolves (a role can run on another role's
				    model with an empty pool of its own); this one speaks only for a bridge that reports no resolution. */}
				{candidates.length === 0 && !entry.effective && (
					<p className="text-sc-xs text-(--sc-text-muted)">{t("modelRoles.noCandidates")}</p>
				)}
			</div>
		</SettingsRow>
	);
}

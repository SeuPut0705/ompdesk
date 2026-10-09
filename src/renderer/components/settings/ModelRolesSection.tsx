/**
 * Settings › Models › Roles: which model each role uses, one row per role
 * with its picker. Role metadata and the eligible candidate pool per role
 * are owned by the backend (get_model_roles returns candidates inline); this
 * section renders them, grouped into chat and specialized roles, and commits
 * through set_model_role. Loads on mount and re-reads whenever the sidecar
 * (re)connects; a failed or impossible read is one quiet InlineNotice over
 * the last good rows instead of claiming no roles exist.
 */

import { RefreshCw, Tags } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CompactionPoint, ModelRoleCandidate, ModelRoleEntry, ModelRolesResult } from "../../../shared/rpc-types";
import { useCompactionPoints } from "../../lib/compaction-limits";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { toast, toastError } from "../../stores/toast";
import { Badge, type BadgeVariant, Button, EmptyState, IconButton, Spinner } from "../common";
import { CompactsAt } from "./CompactsAt";
import { InlineNotice } from "./InlineNotice";
import { type ModelValueGroup, ModelValueSelect } from "./ModelValueSelect";
import { SettingsRow, SettingsSection } from "./SettingsLayout";

const BADGE_BY_COLOR: Record<string, BadgeVariant> = {
	success: "success",
	warning: "warning",
	accent: "accent",
	error: "error",
	info: "info",
	muted: "muted",
	dim: "muted",
	default: "default",
};

const KIND_ORDER: readonly ModelRoleCandidate["kind"][] = ["chat", "tiny", "image", "tts", "stt", "search", "judge"];

function RoleRow({
	role,
	onChange,
	busy,
	sidecarReady,
	compaction,
}: {
	role: ModelRoleEntry;
	onChange: (role: string, modelId: string | null) => void;
	busy: boolean;
	sidecarReady: boolean;
	/** Where the role's resolved model compacts (omp 18.8.5+; absent before). */
	compaction?: CompactionPoint;
}) {
	const t = useT();
	const candidates = role.candidates ?? [];
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
	return (
		<SettingsRow
			badge={
				role.tag ? (
					<Badge variant={BADGE_BY_COLOR[role.color ?? "default"] ?? "default"}>{role.tag}</Badge>
				) : undefined
			}
			control={
				<ModelValueSelect
					ariaLabel={t("modelRoles.select", { role: role.name })}
					clearLabel={t("modelRoles.default")}
					disabled={busy || !sidecarReady}
					groups={groups}
					kind="model"
					onCommit={next => onChange(role.id, next === "" ? null : next)}
					placeholder={t("modelRoles.default")}
					title={!sidecarReady ? t("modelRoles.notConnected") : undefined}
					value={role.model ?? ""}
				/>
			}
			description={
				role.source === "project" || candidates.length === 0 || compaction ? (
					<>
						{role.source === "project" && t("modelRoles.sourceProject")}
						{candidates.length === 0 && <span className="block">{t("modelRoles.noCandidates")}</span>}
						{compaction && <CompactsAt className="block" point={compaction} />}
					</>
				) : undefined
			}
			id={`model-role-${role.id}`}
			label={role.name}
		/>
	);
}

export function ModelRolesSection() {
	const tabRpc = useTabRpc();
	const t = useT();
	const sidecarReady = useSessionStore(s => s.status) === "ready";
	const compactionPoints = useCompactionPoints();

	const [roles, setRoles] = useState<ModelRoleEntry[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busyRole, setBusyRole] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!sidecarReady) {
			// Not connecting is a distinct state from an empty answer: the list keeps
			// whatever it last showed and says why it cannot refresh.
			setError(null);
			setLoading(false);
			return;
		}
		setLoading(true);
		try {
			const res = await tabRpc.getModelRoles();
			if (res.success) {
				setRoles((res.data as ModelRolesResult).roles);
				setLoaded(true);
				setError(null);
			} else {
				setError(res.error);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}, [sidecarReady, tabRpc.getModelRoles]);

	// Mount and every sidecar (re)connect re-read: `load` changes identity with
	// `sidecarReady`. A role written elsewhere (the model setup assistant, the
	// advisor row, another window) pushes config_update.
	useEffect(() => {
		void load();
		return window.omp.events.onConfigUpdate(() => void load());
	}, [load]);

	const sections = useMemo(() => {
		const visible = roles.filter(role => !role.hidden);
		return [
			{ key: "chat" as const, roles: visible.filter(role => role.section === "chat") },
			{ key: "kind" as const, roles: visible.filter(role => role.section !== "chat") },
		].filter(section => section.roles.length > 0);
	}, [roles]);

	const handleChange = async (role: string, modelId: string | null) => {
		if (!sidecarReady) return;
		const entry = roles.find(candidate => candidate.id === role);
		const roleLabel = entry?.name ?? role;
		const modelLabel =
			entry?.candidates?.find(candidate => `${candidate.provider}/${candidate.id}` === modelId)?.name ?? modelId;
		setBusyRole(role);
		try {
			const res = await tabRpc.setModelRole(role, modelId);
			if (res.success) {
				toast({
					variant: "success",
					message: modelLabel
						? t("modelRoles.set", { role: roleLabel, model: modelLabel })
						: t("modelRoles.cleared", { role: roleLabel }),
				});
				await load();
			} else {
				toastError({ title: t("modelRoles.failed"), error: res });
			}
		} catch (cause) {
			toastError({ title: t("modelRoles.failed"), error: cause });
		} finally {
			setBusyRole(null);
		}
	};

	const hasRows = sections.length > 0;

	return (
		<SettingsSection
			actions={
				<IconButton
					disabled={!sidecarReady || loading}
					icon={loading ? <Spinner inheritColor size="sm" /> : <RefreshCw />}
					label={sidecarReady ? t("modelRoles.refresh") : t("modelRoles.notConnected")}
					onClick={() => void load()}
					size="sm"
				/>
			}
			description={t("settings.models.rolesDesc")}
			id="settings-models-roles"
			title={t("settings.models.roles")}
		>
			{!sidecarReady && (
				<InlineNotice
					title={`${t("modelRoles.notConnected")}. ${hasRows ? t("modelRoles.stale") : t("modelRoles.notConnectedHint")}`}
					tone="info"
				/>
			)}
			{sidecarReady && error !== null && (
				<InlineNotice
					action={
						<Button icon={<RefreshCw />} onClick={() => void load()} size="sm" variant="ghost">
							{t("common.retry")}
						</Button>
					}
					detail={error}
					live
					title={hasRows ? `${t("modelRoles.loadFailed")} ${t("modelRoles.stale")}` : t("modelRoles.loadFailed")}
					tone="danger"
				/>
			)}
			{loading && !hasRows && (
				<div className="flex justify-center py-6">
					<Spinner />
				</div>
			)}
			{sidecarReady && loaded && !loading && error === null && !hasRows && (
				<EmptyState icon={<Tags />} size="sm" title={t("modelRoles.empty")} />
			)}
			{sections.map(section => (
				<div aria-labelledby={`model-roles-${section.key}`} key={section.key} role="group">
					<h4
						className="pt-3 pb-1 text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase"
						id={`model-roles-${section.key}`}
					>
						{t(`modelRoles.section.${section.key}`)}
					</h4>
					<div className="divide-y divide-(--sc-divider)">
						{section.roles.map(role => (
							<RoleRow
								busy={busyRole === role.id}
								compaction={compactionPoints?.byRole.get(role.id)?.point}
								key={role.id}
								onChange={handleChange}
								role={role}
								sidecarReady={sidecarReady}
							/>
						))}
					</div>
				</div>
			))}
		</SettingsSection>
	);
}

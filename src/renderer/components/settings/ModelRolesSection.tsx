/**
 * Settings › Models › Roles: which model each role uses. Role metadata and
 * the eligible candidate pool per role are owned by the backend
 * (get_model_roles returns candidates inline); this section renders them,
 * grouped into chat and specialized roles, and commits through
 * set_model_role. Loads on mount and re-reads whenever the sidecar
 * (re)connects; a failed or impossible read degrades to a Banner over the
 * last good rows instead of claiming no roles exist.
 */

import { RefreshCw, Tags } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelRoleCandidate, ModelRoleEntry, ModelRolesResult } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { toast, toastError } from "../../stores/toast";
import { Badge, type BadgeVariant, Banner, Button, EmptyState, ErrorDetail, Spinner } from "../common";
import { type ModelValueGroup, ModelValueSelect } from "./ModelValueSelect";
import { SettingsRow } from "./SettingsLayout";

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
}: {
	role: ModelRoleEntry;
	onChange: (role: string, modelId: string | null) => void;
	busy: boolean;
	sidecarReady: boolean;
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
				<>
					{t("modelRoles.source", { source: role.source })}
					{candidates.length === 0 && <span className="block">{t("modelRoles.noCandidates")}</span>}
				</>
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
	// `sidecarReady`.
	useEffect(() => {
		void load();
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
	const retry = (
		<Button icon={<RefreshCw />} onClick={() => void load()} size="sm" variant="secondary">
			{t("common.retry")}
		</Button>
	);
	const refresh = (
		<Button
			disabled={!sidecarReady}
			icon={<RefreshCw />}
			loading={loading}
			onClick={() => void load()}
			size="sm"
			variant="ghost"
		>
			{t("modelRoles.refresh")}
		</Button>
	);

	return (
		<div className="flex flex-col gap-4 py-3">
			{/* The banners below carry their own retry; a second refresh above them is noise. */}
			{sidecarReady && error === null && <div className="flex justify-end">{refresh}</div>}
			{!sidecarReady && (
				<Banner live title={t("modelRoles.notConnected")} variant="warning">
					{hasRows ? t("modelRoles.stale") : t("modelRoles.notConnectedHint")}
				</Banner>
			)}
			{sidecarReady && error !== null && (
				<Banner actions={retry} live title={t("modelRoles.loadFailed")} variant="danger">
					{hasRows && <span className="block">{t("modelRoles.stale")}</span>}
					<ErrorDetail error={error} />
				</Banner>
			)}
			{loading && !hasRows && (
				<div className="flex justify-center py-10">
					<Spinner />
				</div>
			)}
			{sidecarReady && loaded && !loading && error === null && !hasRows && (
				<EmptyState icon={<Tags />} size="sm" title={t("modelRoles.empty")} />
			)}
			{sections.map(section => (
				<div aria-labelledby={`model-roles-${section.key}`} key={section.key} role="group">
					<h3
						className="text-sc-xs font-semibold tracking-wide text-(--sc-text-muted) uppercase"
						id={`model-roles-${section.key}`}
					>
						{t(`modelRoles.section.${section.key}`)}
					</h3>
					<div className="divide-y divide-(--sc-divider)">
						{section.roles.map(role => (
							<RoleRow
								busy={busyRole === role.id}
								key={role.id}
								onChange={handleChange}
								role={role}
								sidecarReady={sidecarReady}
							/>
						))}
					</div>
				</div>
			))}
		</div>
	);
}

/**
 * Settings › Models & accounts › Model roles: which model each of stock's
 * built-in roles uses, grouped by purpose (Conversation, Agent work, Input &
 * output). Role metadata, the eligible candidate pool per role (stock's
 * `accepts`) and the model each role really resolves to (empty-role fallbacks
 * included) come from the backend (get_model_roles, built-in roles only); this
 * section adds the account state and live quota of that model's provider
 * (get_usage) and commits through set_model_role. Loads on mount and re-reads
 * whenever the sidecar (re)connects; a failed or impossible read is one quiet
 * InlineNotice over the last good rows instead of claiming no roles exist.
 */

import { RefreshCw, Tags } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	BUILTIN_ROLE_IDS,
	HIDDEN_ROLE_IDS,
	type RoleGroupId,
	roleGroup,
} from "../../../../resources/gui-bridge/model-role-contracts";
import type { ModelRoleEntry, ModelRolesResult } from "../../../shared/rpc-types";
import { useUsageRead, useUsageReports } from "../../hooks/use-usage-reports";
import { useCompactionPoints } from "../../lib/compaction-limits";
import { useLang, useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { toast, toastError } from "../../stores/toast";
import { Button, EmptyState, IconButton, InlineNotice, SettingInfo, SkeletonRows } from "../common";
import { ModelRoleRow } from "./ModelRoleRow";
import { SettingsSection } from "./SettingsLayout";
import { modelRoleName } from "./schema-i18n";

const GROUP_ORDER: readonly RoleGroupId[] = ["conversation", "agent", "io"];

/** Rows within a group: stock's built-ins in the contract's order, a newer omp's unknown ones after them. */
function rank(entry: ModelRoleEntry): number {
	const index = BUILTIN_ROLE_IDS.indexOf(entry.id);
	return index >= 0 ? index : BUILTIN_ROLE_IDS.length;
}

export function ModelRolesSection() {
	const tabRpc = useTabRpc();
	const t = useT();
	const { lang } = useLang();
	const sidecarReady = useSessionStore(s => s.status) === "ready";
	const compactionPoints = useCompactionPoints();
	const providers = useModelStore(s => s.providers);
	const refreshProviders = useModelStore(s => s.refreshProviders);

	const [roles, setRoles] = useState<ModelRoleEntry[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busyRole, setBusyRole] = useState<string | null>(null);

	// The account state and quota beside a row are context, read through the tab's one usage poll
	// (hooks/use-usage-reports.ts): a failed read leaves the rows, never blocks them.
	const usage = useUsageReports() ?? [];
	const readUsage = useUsageRead();

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
	useEffect(() => {
		if (!sidecarReady) return;
		// The account state beside each row; the catalog the app already holds shows until this answers.
		refreshProviders().catch(() => undefined);
	}, [sidecarReady, refreshProviders]);

	const visible = useMemo(() => roles.filter(role => !role.hidden && !HIDDEN_ROLE_IDS.includes(role.id)), [roles]);
	const roleName = useCallback(
		(id: string) => {
			const entry = roles.find(candidate => candidate.id === id);
			return entry ? modelRoleName(lang, entry.name) : id;
		},
		[roles, lang],
	);

	const groups = useMemo(
		() =>
			GROUP_ORDER.map(id => ({
				id,
				roles: visible.filter(entry => roleGroup(entry.id, entry.section) === id).sort((a, b) => rank(a) - rank(b)),
			})).filter(group => group.roles.length > 0),
		[visible],
	);

	const handleChange = async (role: string, modelId: string | null) => {
		if (!sidecarReady) return;
		const roleLabel = roleName(role);
		const entry = roles.find(candidate => candidate.id === role);
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

	const hasRows = visible.length > 0;

	return (
		<SettingsSection
			actions={
				<IconButton
					disabled={!sidecarReady}
					icon={<RefreshCw />}
					label={sidecarReady ? t("common.refresh") : t("modelRoles.notConnected")}
					loading={loading}
					onClick={() => {
						void load();
						void readUsage();
					}}
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
				<SkeletonRows className="py-2" label={t("common.loading")} widths={[60, 44, 70, 52]} />
			)}
			{sidecarReady && loaded && !loading && error === null && !hasRows && (
				<EmptyState icon={<Tags />} size="sm" title={t("modelRoles.empty")} />
			)}
			{groups.map(group => (
				<div aria-labelledby={`model-roles-${group.id}`} key={group.id} role="group">
					<div className="flex items-center justify-between gap-3 pt-2 pb-0.5">
						<div className="flex min-w-0 items-center gap-1.5">
							<h5 className="text-sc-xs font-medium text-(--sc-text-muted)" id={`model-roles-${group.id}`}>
								{t(`modelRoles.group.${group.id}`)}
							</h5>
							<SettingInfo text={t(`modelRoles.group.${group.id}.desc`)} />
						</div>
					</div>
					<div className="divide-y divide-(--sc-divider)">
						{group.roles.map(entry => (
							<ModelRoleRow
								busy={busyRole === entry.id}
								compaction={compactionPoints?.byRole.get(entry.id)?.point}
								entry={entry}
								key={entry.id}
								name={roleName(entry.id)}
								onChange={handleChange}
								providers={providers}
								roleName={roleName}
								sidecarReady={sidecarReady}
								usage={usage}
							/>
						))}
					</div>
				</div>
			))}
		</SettingsSection>
	);
}

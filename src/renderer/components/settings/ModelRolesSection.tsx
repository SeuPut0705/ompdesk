/**
 * Settings › Models & accounts › Model roles: which model each role uses,
 * grouped by purpose (Conversation, Agent work, Input & output, Custom roles).
 * Role metadata, the eligible candidate pool per role (stock's `accepts`) and
 * the model each role really resolves to (empty-role fallbacks included) come
 * from the backend (get_model_roles); this section adds the account state and
 * live quota of that model's provider (get_usage), the agents using each custom
 * role (get_agent_definitions) and commits through set_model_role,
 * define_model_role and forget_model_role. Loads on mount and re-reads whenever
 * the sidecar (re)connects; a failed or impossible read is one quiet
 * InlineNotice over the last good rows instead of claiming no roles exist.
 */

import { Plus, RefreshCw, Tags } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	BUILTIN_ROLE_IDS,
	modelRoleRefs,
	PRESET_ROLES,
	type RoleGroupId,
	roleGroup,
} from "../../../../resources/gui-bridge/model-role-contracts";
import { AGENT_TEMPLATES } from "../../../shared/agent-templates";
import type { ModelRoleEntry, ModelRolesResult, RpcAgentDefinitionInfo } from "../../../shared/rpc-types";
import { useUsageRead, useUsageReports } from "../../hooks/use-usage-reports";
import { useCompactionPoints } from "../../lib/compaction-limits";
import { useLang, useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { toast, toastError } from "../../stores/toast";
import { Button, ConfirmDialog, EmptyState, IconButton, InlineNotice, Spinner } from "../common";
import { CustomRoleDialog, type CustomRoleFields } from "./CustomRoleDialog";
import { ModelRoleRow, type RoleAgents } from "./ModelRoleRow";
import { SettingInfo, SettingsSection } from "./SettingsLayout";
import { modelRoleName } from "./schema-i18n";

const GROUP_ORDER: readonly (RoleGroupId | "custom")[] = ["conversation", "agent", "io", "custom"];

/** Rows within a group: stock's built-ins in the contract's order, presets in theirs, then the rest as listed. */
function rank(entry: ModelRoleEntry): number {
	const builtin = BUILTIN_ROLE_IDS.indexOf(entry.id);
	if (builtin >= 0) return builtin;
	const preset = PRESET_ROLES.findIndex(role => role.id === entry.id);
	return preset >= 0 ? preset : PRESET_ROLES.length;
}

function groupOf(entry: ModelRoleEntry): RoleGroupId | "custom" {
	return roleGroup(entry.id, entry.section, entry.builtin ?? BUILTIN_ROLE_IDS.includes(entry.id));
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
	const [agents, setAgents] = useState<RpcAgentDefinitionInfo[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busyRole, setBusyRole] = useState<string | null>(null);
	const [dialog, setDialog] = useState<{ edit?: ModelRoleEntry } | null>(null);
	const [removing, setRemoving] = useState<ModelRoleEntry | null>(null);

	// The account state and quota beside a row are context, read through the tab's one usage poll
	// (hooks/use-usage-reports.ts): a failed read leaves the rows, never blocks them.
	const usage = useUsageReports() ?? [];
	const readUsage = useUsageRead();

	const loadAgents = useCallback(async () => {
		try {
			const res = await tabRpc.getAgentDefinitions();
			if (res.success) setAgents((res.data as { agents: RpcAgentDefinitionInfo[] }).agents);
		} catch {
			/* The "used by" lines keep their last value. */
		}
	}, [tabRpc.getAgentDefinitions]);

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
		void loadAgents();
		// The account state beside each row; the catalog the app already holds shows until this answers.
		refreshProviders().catch(() => undefined);
	}, [sidecarReady, loadAgents, refreshProviders]);

	const visible = useMemo(() => roles.filter(role => !role.hidden), [roles]);
	const nameOf = useCallback(
		(entry: ModelRoleEntry) => {
			if (entry.builtin ?? BUILTIN_ROLE_IDS.includes(entry.id)) return modelRoleName(lang, entry.name);
			if (entry.label) return entry.label;
			return PRESET_ROLES.some(role => role.id === entry.id) ? t(`modelRoles.name.${entry.id}`) : entry.name;
		},
		[lang, t],
	);
	const roleName = useCallback(
		(id: string) => {
			const entry = roles.find(candidate => candidate.id === id);
			return entry ? nameOf(entry) : id;
		},
		[roles, nameOf],
	);

	const groups = useMemo(
		() =>
			GROUP_ORDER.map(id => ({
				id,
				roles: visible.filter(entry => groupOf(entry) === id).sort((a, b) => rank(a) - rank(b)),
			})).filter(group => group.roles.length > 0 || (group.id === "custom" && loaded)),
		[visible, loaded],
	);

	/** Who uses a custom role: installed agents naming `@id`, then the shipped templates not installed yet. */
	const agentsOf = useCallback(
		(id: string): RoleAgents => {
			const installed = agents.filter(agent => modelRoleRefs(agent.model).includes(id)).map(agent => agent.name);
			const present = new Set(agents.map(agent => agent.name));
			const templates = AGENT_TEMPLATES.filter(template => template.role === id && !present.has(template.name)).map(
				template => template.name,
			);
			return { installed, templates };
		},
		[agents],
	);

	const handleChange = async (role: string, modelId: string | null) => {
		if (!sidecarReady) return;
		const entry = roles.find(candidate => candidate.id === role);
		const roleLabel = entry ? nameOf(entry) : role;
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

	const define = async (fields: CustomRoleFields) => {
		setBusyRole(fields.id);
		try {
			const res = await tabRpc.defineModelRole(fields.id, { name: fields.name, description: fields.description });
			if (res.success) {
				toast({ variant: "success", message: t("modelRoles.defined", { role: fields.name || fields.id }) });
				setDialog(null);
				await load();
			} else {
				toastError({ title: t("modelRoles.defineFailed"), error: res });
			}
		} catch (cause) {
			toastError({ title: t("modelRoles.defineFailed"), error: cause });
		} finally {
			setBusyRole(null);
		}
	};

	const remove = async (entry: ModelRoleEntry) => {
		setBusyRole(entry.id);
		try {
			const res = await tabRpc.forgetModelRole(entry.id);
			if (res.success) {
				toast({ variant: "success", message: t("modelRoles.removed", { role: nameOf(entry) }) });
				setRemoving(null);
				await load();
			} else {
				toastError({ title: t("modelRoles.removeFailed"), error: res });
			}
		} catch (cause) {
			toastError({ title: t("modelRoles.removeFailed"), error: cause });
		} finally {
			setBusyRole(null);
		}
	};

	const hasRows = visible.length > 0;
	const editing = dialog?.edit;
	const affected = removing ? agentsOf(removing.id).installed : [];

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
						void loadAgents();
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
			{loading && !hasRows && <Spinner className="w-full justify-center py-6" label={t("common.loading")} />}
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
						{group.id === "custom" && (
							<Button
								disabled={!sidecarReady}
								icon={<Plus />}
								onClick={() => setDialog({})}
								size="sm"
								variant="secondary"
							>
								{t("modelRoles.add")}
							</Button>
						)}
					</div>
					<div className="divide-y divide-(--sc-divider)">
						{group.roles.map(entry => (
							<ModelRoleRow
								agents={group.id === "custom" ? agentsOf(entry.id) : undefined}
								busy={busyRole === entry.id}
								compaction={compactionPoints?.byRole.get(entry.id)?.point}
								entry={entry}
								key={entry.id}
								name={nameOf(entry)}
								onChange={handleChange}
								onEdit={target => setDialog({ edit: target })}
								onRemove={setRemoving}
								providers={providers}
								roleName={roleName}
								sidecarReady={sidecarReady}
								usage={usage}
							/>
						))}
					</div>
				</div>
			))}
			{dialog && (
				<CustomRoleDialog
					busy={busyRole !== null}
					editing={
						editing
							? {
									id: editing.id,
									title: nameOf(editing),
									name: editing.label ?? "",
									description: editing.description ?? "",
								}
							: undefined
					}
					key={editing?.id ?? "new"}
					knownIds={roles.map(entry => entry.id)}
					onClose={() => setDialog(null)}
					onSubmit={fields => void define(fields)}
				/>
			)}
			<ConfirmDialog
				busy={removing !== null && busyRole === removing.id}
				confirmLabel={t("modelRoles.removeConfirm")}
				message={t("modelRoles.removeBody", { id: removing?.id ?? "" })}
				onCancel={() => setRemoving(null)}
				onConfirm={() => {
					if (removing) void remove(removing);
				}}
				open={removing !== null}
				title={t("modelRoles.removeTitle", { role: removing ? nameOf(removing) : "" })}
				warning={affected.length > 0 ? t("modelRoles.removeAgents", { agents: affected.join(", ") }) : undefined}
			/>
		</SettingsSection>
	);
}

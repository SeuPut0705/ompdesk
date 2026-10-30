/**
 * Settings › Models & accounts, above Model roles: the model setup assistant's entry. When this machine has an
 * apply record it shows its date and an Undo; when the connected models or accounts differ from what the last
 * apply saw it adds one quiet line that opens the dialog. Nothing here changes a role by itself.
 */

import { Sparkles, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { setupSignature } from "../../../../shared/role-plan";
import type { ModelRolesResult } from "../../../../shared/rpc-types";
import { errorDetail } from "../../../lib/error-detail";
import { formatClock } from "../../../lib/format";
import { useLang, useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useFocusedTabDevice } from "../../../stores/remote";
import { useSessionStore } from "../../../stores/session";
import { toast } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { Button, LinkButton } from "../../common";
import { SettingsRow, SettingsSection } from "../SettingsLayout";
import { modelRoleName } from "../schema-i18n";
import {
	loadSetupRecord,
	offersNewSetup,
	parseSetupFacts,
	planRoleInputs,
	type SetupRecord,
	saveSetupRecord,
	undoSteps,
} from "./model-setup-logic";

export function ModelSetupEntry() {
	const t = useT();
	const { lang } = useLang();
	const tabRpc = useTabRpc();
	const device = useFocusedTabDevice();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const dialogOpen = useUiStore(state => state.modelSetupOpen);
	const [record, setRecord] = useState<SetupRecord | undefined>();
	// The signature of the roles and facts as they are now; read only when a record has one to compare with.
	const [signature, setSignature] = useState<string | undefined>();
	const [undoing, setUndoing] = useState(false);

	// Read when the entry mounts, the sidecar reconnects and the dialog closes (an apply stores a new record).
	useEffect(() => {
		if (dialogOpen) return;
		let cancelled = false;
		void (async () => {
			try {
				const stored = await loadSetupRecord(device);
				if (cancelled) return;
				setRecord(stored);
				if (!sidecarReady || stored?.signature === undefined) {
					setSignature(undefined);
					return;
				}
				const [rolesRes, factsRes] = await Promise.all([tabRpc.getModelRoles(), tabRpc.getModelSetupFacts()]);
				const facts = factsRes.success ? parseSetupFacts(factsRes.data) : undefined;
				if (cancelled || !rolesRes.success || !facts) return;
				setSignature(setupSignature(planRoleInputs((rolesRes.data as ModelRolesResult).roles), facts));
			} catch {
				// No record or no answer: no date, no offer.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [device, dialogOpen, sidecarReady, tabRpc]);

	const undo = async () => {
		const applied = record?.applied;
		if (!applied) return;
		setUndoing(true);
		try {
			const rolesRes = await tabRpc.getModelRoles();
			if (!rolesRes.success) {
				toast({ variant: "error", title: t("modelSetup.undo.failedTitle"), message: errorDetail(rolesRes) });
				return;
			}
			const roles = (rolesRes.data as ModelRolesResult).roles;
			const nameOf = (id: string) => modelRoleName(lang, roles.find(role => role.id === id)?.name ?? id);
			const { restore, skipped } = undoSteps(applied, roles);
			const failures: Array<{ role: string; error: unknown }> = [];
			for (const step of restore) {
				try {
					const res = await tabRpc.setModelRole(step.role, step.model);
					if (!res.success) failures.push({ role: step.role, error: res });
				} catch (error) {
					failures.push({ role: step.role, error });
				}
			}
			await saveSetupRecord(device, undefined).catch(() => {});
			setRecord(undefined);
			setSignature(undefined);
			if (failures.length > 0) {
				toast({
					variant: "error",
					title: t("modelSetup.undo.failedTitle"),
					message: t("modelSetup.undo.partial", {
						count: restore.length - failures.length,
						failed: failures.length,
					}),
					detail: failures.map(failure => `${nameOf(failure.role)}: ${errorDetail(failure.error)}`).join("\n"),
				});
				return;
			}
			const left = skipped.length > 0 ? t("modelSetup.undo.skipped", { roles: skipped.map(nameOf).join(", ") }) : "";
			toast(
				restore.length > 0
					? {
							variant: "success",
							message: [t("modelSetup.undo.done", { count: restore.length }), left].filter(Boolean).join(" "),
						}
					: { variant: "info", message: [t("modelSetup.undo.nothing"), left].filter(Boolean).join(" ") },
			);
		} catch (error) {
			toast({ variant: "error", title: t("modelSetup.undo.failedTitle"), message: errorDetail(error) });
		} finally {
			setUndoing(false);
		}
	};

	const applied = record?.applied;
	const offer = signature !== undefined && offersNewSetup(record, signature);

	return (
		<SettingsSection id="settings-models-setup" title={t("modelSetup.title")}>
			<SettingsRow
				badge={
					applied && (
						<span className="text-sc-xs text-(--sc-text-muted)" data-model-setup-last>
							<span aria-hidden>· </span>
							{t("modelSetup.entryLast", { date: formatClock(applied.at) })}
						</span>
					)
				}
				control={
					<div className="flex items-center gap-2">
						{applied && (
							<Button
								disabled={!sidecarReady || undoing}
								icon={<Undo2 />}
								loading={undoing}
								onClick={() => void undo()}
								size="sm"
								variant="ghost"
							>
								{t("modelSetup.undo")}
							</Button>
						)}
						<Button
							disabled={!sidecarReady}
							icon={<Sparkles />}
							onClick={() => useUiStore.getState().openModelSetup()}
							size="sm"
							variant="secondary"
						>
							{t("modelSetup.open")}
						</Button>
					</div>
				}
				description={t("modelSetup.entryDesc")}
				footer={
					offer && (
						<LinkButton
							className="text-sc-xs"
							data-model-setup-offer
							onClick={() => useUiStore.getState().openModelSetup()}
							tone="muted"
						>
							{t("modelSetup.entryOffer")}
						</LinkButton>
					)
				}
				label={t("modelSetup.entryLabel")}
			/>
		</SettingsSection>
	);
}

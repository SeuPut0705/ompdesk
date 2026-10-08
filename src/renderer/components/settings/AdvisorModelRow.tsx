/**
 * Settings › Features, under the advisor switch while it is on: the model the
 * advisor runs on (its own role, else the Thinking role, like stock's
 * fallback) with a picker that sets the `advisor` role, and — when the
 * advisor is on but not running — that state with the model setup assistant
 * one click away. Manual setup stays on this one screen.
 */

import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelRoleEntry, ModelRolesResult } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useModelStore } from "../../stores/model";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button } from "../common";
import { InlineNotice } from "./InlineNotice";
import { type ModelValueGroup, ModelValueSelect } from "./ModelValueSelect";
import { effectiveAdvisorModel } from "./model-setup/model-setup-logic";
import { SettingsRow } from "./SettingsLayout";

export function AdvisorModelRow({ active, sidecarReady }: { active: boolean | undefined; sidecarReady: boolean }) {
	const t = useT();
	const tabRpc = useTabRpc();
	const providers = useModelStore(state => state.providers);
	const [roles, setRoles] = useState<ModelRoleEntry[]>([]);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		if (!sidecarReady) return;
		try {
			const res = await tabRpc.getModelRoles();
			if (res.success) setRoles((res.data as ModelRolesResult).roles);
		} catch {
			// The row keeps the last roles it showed; the picker still works.
		}
	}, [sidecarReady, tabRpc.getModelRoles]);

	useEffect(() => {
		void load();
		return window.omp.events.onConfigUpdate(() => void load());
	}, [load]);

	const advisorRole = roles.find(role => role.id === "advisor");
	const slowRole = roles.find(role => role.id === "slow");
	const effective = effectiveAdvisorModel(roles);
	const candidates = advisorRole?.candidates ?? [];
	const nameOf = (selector: string | undefined) => {
		const match = candidates.find(candidate => `${candidate.provider}/${candidate.id}` === selector);
		return match?.name || selector;
	};
	const groups = useMemo<ModelValueGroup[]>(() => {
		const byProvider = new Map<string, ModelValueGroup["options"][number][]>();
		for (const candidate of candidates) {
			if (candidate.kind !== "chat") continue;
			const value = `${candidate.provider}/${candidate.id}`;
			const named = candidate.name.length > 0 && candidate.name !== candidate.id;
			byProvider.set(candidate.provider, [
				...(byProvider.get(candidate.provider) ?? []),
				named ? { value, label: candidate.name, detail: value } : { value },
			]);
		}
		return [...byProvider].map(([provider, options]) => ({
			label: providers.find(entry => entry.id === provider)?.name ?? provider,
			options,
		}));
	}, [candidates, providers]);

	const commit = async (next: string) => {
		setBusy(true);
		try {
			const res = await tabRpc.setModelRole("advisor", next === "" ? null : next);
			if (!res.success) {
				toastError({ title: t("modelRoles.failed"), error: res });
				return;
			}
			const role = advisorRole?.name ?? "advisor";
			toast({
				variant: "success",
				message:
					next === ""
						? t("modelRoles.cleared", { role })
						: t("modelRoles.set", { role, model: nameOf(next) ?? next }),
			});
			await load();
		} catch (error) {
			toastError({ title: t("modelRoles.failed"), error });
		} finally {
			setBusy(false);
		}
	};

	const idle = active === false;
	const description =
		effective?.via === "slow"
			? t("settings.features.advisorModelViaSlow", {
					role: slowRole?.name ?? "slow",
					model: nameOf(effective.model) ?? effective.model,
				})
			: effective
				? undefined
				: t("settings.features.advisorModelUnset");

	return (
		<SettingsRow
			control={
				<ModelValueSelect
					ariaLabel={t("settings.features.advisorModel")}
					clearLabel={t("modelRoles.default")}
					disabled={busy || !sidecarReady}
					groups={groups}
					kind="model"
					onCommit={next => void commit(next)}
					placeholder={
						effective?.via === "slow"
							? (nameOf(effective.model) ?? effective.model)
							: t("settings.features.advisorModelNone")
					}
					value={advisorRole?.model ?? ""}
				/>
			}
			description={description}
			footer={
				idle ? (
					<InlineNotice
						action={
							<Button
								icon={<Sparkles />}
								onClick={() => useUiStore.getState().openModelSetup()}
								size="sm"
								variant="secondary"
							>
								{t("modelSetup.open")}
							</Button>
						}
						className="mt-1"
						live
						title={t("settings.features.advisorIdle")}
						tone="warning"
					/>
				) : undefined
			}
			id="setting-advisor-model"
			label={t("settings.features.advisorModel")}
		/>
	);
}

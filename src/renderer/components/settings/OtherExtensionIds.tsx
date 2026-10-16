import { Blocks } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { RpcContextFilesResult, RpcHooksResult, RpcSkillsResult } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { toastError } from "../../stores/toast";
import { Banner, Button } from "../common";
import { ArrayChipEditor } from "./editors/ArrayChipEditor";
import { SettingsRow } from "./SettingsLayout";
import { useSettingsData } from "./settings-data";

/** Preserve ids with no discovered skill/hook/instruction-file editor, without duplicating their switches. */
export function OtherExtensionIds() {
	const t = useT();
	const rpc = useTabRpc();
	const { values, sidecarReady, onCommitted } = useSettingsData();
	const [covered, setCovered] = useState<string[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const load = useCallback(async () => {
		if (!sidecarReady) return;
		setError(null);
		try {
			const [skills, hooks, contextFiles] = await Promise.all([
				rpc.getSkills(),
				rpc.getHooks(),
				rpc.getContextFiles(),
			]);
			const failed = [skills, hooks, contextFiles].find(response => !response.success);
			if (failed && !failed.success) throw new Error(failed.error);
			setCovered([
				...(skills.data as RpcSkillsResult).skills.map(skill => `skill:${skill.name}`),
				...(hooks.data as RpcHooksResult).hooks.map(hook => hook.id),
				...(contextFiles.data as RpcContextFilesResult).files.map(file => file.id),
			]);
		} catch (cause) {
			setError(String(cause));
		}
	}, [sidecarReady, rpc.getSkills, rpc.getHooks, rpc.getContextFiles]);
	useEffect(() => {
		void load();
		return window.omp.events.onConfigUpdate(() => void load());
	}, [load]);
	const ids = Array.isArray(values.disabledExtensions)
		? values.disabledExtensions.filter((value): value is string => typeof value === "string")
		: [];
	const commit = async (next: string[]) => {
		if (!covered) return false;
		setSaving(true);
		try {
			const merged = [...ids.filter(id => covered.includes(id)), ...next.filter(id => !covered.includes(id))];
			const result = await rpc.setSetting("disabledExtensions", merged);
			if (!result.success) throw new Error(result.error);
			onCommitted("disabledExtensions", merged);
			return true;
		} catch (cause) {
			toastError({ title: t("settings.saveFailed"), error: cause });
			return false;
		} finally {
			setSaving(false);
		}
	};
	return (
		<SettingsRow
			id="settings-tools-other-extensions"
			icon={<Blocks />}
			label={t("settings.extensions.otherIds")}
			description={t("settings.extensions.otherIdsDesc")}
		>
			{error ? (
				<Banner
					variant="danger"
					actions={
						<Button onClick={() => void load()} size="sm">
							{t("common.retry")}
						</Button>
					}
				>
					{error}
				</Banner>
			) : (
				<ArrayChipEditor
					disabled={saving || covered === null}
					values={ids.filter(id => !covered?.includes(id))}
					onCommit={commit}
				/>
			)}
		</SettingsRow>
	);
}

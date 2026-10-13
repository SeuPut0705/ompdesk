import { useEffect, useRef, useState } from "react";
import {
	type BuiltinReaState,
	REA_CURATED_TOOL_COUNT,
	REA_NODE_REQUIREMENT,
	REA_VERSION,
} from "../../../shared/builtin-mcp";
import type { RpcMcpServerInfo } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { toastError } from "../../stores/toast";
import { Badge } from "../common";
import { SettingsSwitchRow } from "./SettingsLayout";

/** Machine-owned preference: only new OMPdesk sessions receive the MCP root. */
export function BuiltinReaRow({
	device,
	server,
	query = "",
}: {
	device?: string;
	server?: RpcMcpServerInfo;
	query?: string;
}) {
	const t = useT();
	const [state, setState] = useState<BuiltinReaState | null>(null);
	const [saving, setSaving] = useState(false);
	const request = useRef(0);
	useEffect(() => {
		const version = ++request.current;
		setState(null);
		setSaving(false);
		window.omp.builtinRea
			.get(device)
			.then(next => {
				if (version === request.current) setState(next);
			})
			.catch((error: unknown) => {
				if (version === request.current) toastError({ title: t("mcp.rea.loadFailed"), error });
			});
		return () => {
			request.current++;
		};
	}, [device, t]);
	const choose = (enabled: boolean) => {
		if (!state || saving) return;
		const version = ++request.current;
		setSaving(true);
		window.omp.builtinRea
			.set(enabled, device)
			.then(next => {
				if (version === request.current) setState(next);
			})
			.catch((error: unknown) => {
				if (version === request.current) toastError({ title: t("mcp.rea.saveFailed"), error });
			})
			.finally(() => {
				if (version === request.current) setSaving(false);
			});
	};
	const status = !state
		? t("mcp.rea.loading")
		: !state.available
			? t("mcp.rea.unavailable")
			: !state.enabled
				? t("mcp.rea.disabled")
				: t("mcp.rea.available");
	if (
		query &&
		!`${t("mcp.rea.title")} rea npx node ${REA_VERSION} ${status}`.toLowerCase().includes(query.toLowerCase())
	)
		return null;
	return (
		<div data-builtin-rea="true">
			<SettingsSwitchRow
				label={t("mcp.rea.title")}
				badge={<Badge>{REA_VERSION}</Badge>}
				checked={state?.enabled ?? true}
				disabled={!state || saving}
				onCheckedChange={choose}
				description={t("mcp.rea.description", { count: REA_CURATED_TOOL_COUNT })}
				footer={
					<div className="mt-1 flex flex-col gap-1 text-sc-xs text-(--sc-text-muted)">
						<p role="status">
							{status}
							{server && ` · ${t(`extPanel.status.${server.status}`)} · ${server.toolCount}`}
						</p>
						{state?.reason && <p>{t(`mcp.rea.${state.reason}`, { version: state.nodeVersion ?? "" })}</p>}
						<p>{t("mcp.rea.requirement", { range: REA_NODE_REQUIREMENT })}</p>
					</div>
				}
			/>
		</div>
	);
}

/**
 * Settings › Updates & about › This computer, after the tool CLIs: the marketplaces, plugins, skills and MCP
 * servers of this computer's omp (main `ext-update/`, contract `shared/extension-update.ts`). One switch
 * (default on), then one row per listed item: its installed and newest version, how it is kept current, the
 * last result or why OMPdesk leaves it alone, and "Update now". The renderer names rows by key and never a
 * command, a path or a version to install.
 */
import { Puzzle, RefreshCw, Server, Sparkles, Store } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import {
	EXTENSION_AUTO_UPDATE_PREF,
	type ExtensionKind,
	type ExtensionRow,
	type ExtensionUpdateState,
} from "../../../shared/extension-update";
import { isNewer } from "../../../shared/version";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { useExtensionUpdateStore } from "../../stores/extension-update";
import { Badge, IconButton, InlineNotice } from "../common";
import { SettingsRow, SettingsSwitchRow } from "./SettingsLayout";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const KIND_ICON: Record<ExtensionKind, ReactNode> = {
	marketplace: <Store />,
	plugin: <Puzzle />,
	skill: <Sparkles />,
	mcp: <Server />,
};

/** A row key (`plugin:name@market:user`) as a DOM id / test id fragment. */
export function extensionDomId(key: string): string {
	return key.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** The row's own name; the two grouped skill rows carry placeholder names. */
export function extensionRowName(t: Translate, row: ExtensionRow): string {
	if (row.kind === "skill" && row.count !== null && (row.name === "plugin" || row.name === "local")) {
		return t(`extensionUpdate.skill.${row.name}`);
	}
	return row.name;
}

/** What the row is doing, or what the last check found; a failure's own detail goes in a notice below. */
export function extensionStatusText(
	t: Translate,
	row: ExtensionRow,
	state: Pick<ExtensionUpdateState, "scheduled">,
): string {
	if (row.skip === "pinned") {
		const pinned = row.installed ?? row.detail;
		const latest = row.latest ?? (row.last?.kind === "available" ? row.last.latest : null);
		if (row.phase === "checking") return t("extensionUpdate.status.checking");
		if (row.phase === "updating") return t("extensionUpdate.status.updating");
		if (latest && row.installed && isNewer(latest, row.installed)) {
			return t("extensionUpdate.status.available", { installed: row.installed, latest });
		}
		return pinned ? t("extensionUpdate.status.pinned", { installed: pinned }) : t("extensionUpdate.skip.pinned");
	}
	if (row.skip) return t(`extensionUpdate.skip.${row.skip}`);
	if (row.phase === "checking") return t("extensionUpdate.status.checking");
	if (row.phase === "updating") return t("extensionUpdate.status.updating");
	const last = row.last;
	if (!last) return state.scheduled ? t("extensionUpdate.status.notChecked") : t("extensionUpdate.status.manualOnly");
	switch (last.kind) {
		case "refreshed":
			return t("extensionUpdate.status.refreshed");
		case "current":
			return t("extensionUpdate.status.current");
		case "updated":
			return last.from
				? t("extensionUpdate.status.updatedFrom", { from: last.from, to: last.to })
				: t("extensionUpdate.status.updated", { to: last.to });
		case "available":
			return t("extensionUpdate.status.available", { installed: row.installed ?? "", latest: last.latest });
		case "deferred":
			return t(`extensionUpdate.status.deferred.${last.why}`);
		case "failed":
			return t(`extensionUpdate.failure.${last.failure.reason}`);
	}
}

function versionText(t: Translate, row: ExtensionRow): string | null {
	if (row.kind === "marketplace" && !row.installed && !row.latest) return null;
	const installed = row.installed
		? t("extensionUpdate.version.installed", { version: row.installed })
		: t("extensionUpdate.version.unknown");
	return row.latest ? `${installed} · ${t("extensionUpdate.version.latest", { version: row.latest })}` : installed;
}

function metaText(t: Translate, row: ExtensionRow): string {
	const parts = [t(`extensionUpdate.kind.${row.kind}`)];
	if (row.detail) parts.push(row.detail);
	if (row.count !== null) parts.push(t("extensionUpdate.count", { count: row.count }));
	return parts.join(" · ");
}

function ExtensionRowView({ row, state }: { row: ExtensionRow; state: ExtensionUpdateState }) {
	const t = useT();
	const updateNow = useExtensionUpdateStore(store => store.updateNow);
	const id = extensionDomId(row.key);
	const name = extensionRowName(t, row);
	const busy = row.phase !== "idle";
	const failure = !row.skip && row.last?.kind === "failed" ? row.last.failure : null;
	const version = versionText(t, row);
	const status = extensionStatusText(t, row, state);
	return (
		<SettingsRow
			className="min-w-0"
			compactControl
			control={
				<IconButton
					data-key={row.key}
					data-testid={`extension-update-now-${id}`}
					disabled={busy || row.skip !== null}
					icon={<RefreshCw />}
					label={t("extensionUpdate.nowFor", { name })}
					onClick={() => void updateNow(row.key)}
					size="sm"
					variant="secondary"
				/>
			}
			icon={KIND_ICON[row.kind]}
			id={`setting-extension-${id}`}
			label={name}
			badge={
				<Badge variant="muted">
					{row.method
						? t("extensionUpdate.method", { method: t(`extensionUpdate.method.${row.method}`) })
						: t("extensionUpdate.method.none")}
				</Badge>
			}
		>
			<div data-extension-row={row.key} data-phase={row.phase}>
				<p className="min-w-0 truncate text-sc-xs text-(--sc-text-muted)" data-testid={`extension-meta-${id}`}>
					{metaText(t, row)}
				</p>
				{version && (
					<p className="text-sc-xs text-(--sc-text-secondary)" data-testid={`extension-version-${id}`}>
						{version}
					</p>
				)}
				<p className="min-w-0 text-sc-xs break-words text-(--sc-text-muted)" data-testid={`extension-status-${id}`}>
					{status}
				</p>
				{failure && <InlineNotice detail={failure.detail} title={t("extensionUpdate.retryNote")} tone="warning" />}
			</div>
		</SettingsRow>
	);
}

export function ExtensionUpdateRows() {
	const t = useT();
	const state = useExtensionUpdateStore(store => store.state);
	useEffect(() => {
		void useExtensionUpdateStore.getState().load();
	}, []);
	return (
		<>
			<h4 className="pt-3 text-sc-sm font-medium text-(--sc-text-secondary)" data-testid="extension-update-group">
				{t("extensionUpdate.group")}
			</h4>
			<SettingsSwitchRow
				icon={<Puzzle />}
				checked={state?.enabled ?? true}
				description={t("extensionUpdate.autoDesc")}
				tipOnly
				disabled={state === null}
				id="setting-gui-extensionAutoUpdate"
				label={t("extensionUpdate.auto")}
				onCheckedChange={next => void saveGuiPreference(EXTENSION_AUTO_UPDATE_PREF, next, () => {})}
			/>
			{state?.rows.map(row => (
				<ExtensionRowView key={row.key} row={row} state={state} />
			))}
			{state && state.rows.length === 0 && (
				<p className="py-2 text-sc-sm text-(--sc-text-muted)" data-testid="extension-update-none">
					{t("extensionUpdate.none")}
				</p>
			)}
		</>
	);
}

/**
 * Settings › Mobile web: the connected devices (name with Rename, a connected dot, last seen, Tailscale user,
 * today's model use, the access tier with a select for the presets and per-permission switches under a
 * disclosure, Limits, Block), the blocked ones with Unblock, and the Tailscale users allowed to reach the page.
 * Block keeps a device out for good (its Tailscale node, or its whole login when Tailscale gave no node
 * identity: the confirm says so). Main owns the lists; every action answers with the whole new list (devices,
 * blocks) or state (users).
 */
import { Ban, Pencil, Smartphone } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { PeerView } from "../../../shared/ipc-types";
import {
	type MobileWebState,
	WEB_GRANT_PRESETS,
	type WebBlockedInfo,
	type WebDeviceInfo,
	type WebGrantPreset,
	webDeviceTier,
} from "../../../shared/mobile-web";
import { WEB_PERMISSIONS, type WebPermission } from "../../../shared/web-protocol";
import { formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { onEscape } from "../../lib/keymap";
import { mobileWebCommand, mobileWebDeviceAction, mobileWebUnblock } from "../../stores/mobile-web";
import { Badge, Button, ConfirmDialog, IconButton, Input, ListRow, Select, Switch } from "../common";
import { PeerLimitsDialog, peerUsageLine } from "./PeerLimitsDialog";
import { SettingsSection } from "./SettingsLayout";

/** Every permission a device can hold: `pairing-admin` is never granted to one. */
const GRANTABLE = WEB_PERMISSIONS.filter(permission => permission !== "pairing-admin");

const PRESET_NAMES = Object.keys(WEB_GRANT_PRESETS) as WebGrantPreset[];

/** The device as the limits dialog and the usage line read a paired computer. */
function asPeer(device: WebDeviceInfo): PeerView {
	return {
		deviceId: device.id,
		name: device.name,
		online: device.connected,
		lastSeenAt: device.lastSeenAt,
		limits: device.limits,
		usage: device.usage,
	};
}

function DeviceName({ device, onDone }: { device: WebDeviceInfo; onDone: () => void }) {
	const t = useT();
	const [draft, setDraft] = useState(device.name);
	/** Escape leaves the field without saving; the blur that follows must not. */
	const cancelled = useRef(false);
	const commit = (value: string) => {
		if (cancelled.current) return;
		const next = value.trim();
		if (!next || next === device.name) return;
		void mobileWebDeviceAction(
			() => window.omp.mobileWeb.devices.rename(device.id, next),
			t("mobileWeb.devices.renameFailed"),
		);
	};
	return (
		<Input
			aria-label={t("remote.host.name")}
			autoFocus
			controlSize="sm"
			maxLength={64}
			onBlur={event => {
				commit(event.currentTarget.value);
				onDone();
			}}
			onChange={event => setDraft(event.target.value)}
			onKeyDown={event => {
				if (isImeKeyEvent(event)) return;
				if (event.key === "Enter") event.currentTarget.blur();
				onEscape(event, () => {
					cancelled.current = true;
					onDone();
				});
			}}
			value={draft}
		/>
	);
}

/** One paired device: its row, its access tier and its permissions. */
function DeviceRow({
	device,
	onLimits,
	onRevoke,
}: {
	device: WebDeviceInfo;
	onLimits: () => void;
	onRevoke: () => void;
}) {
	const t = useT();
	const [renaming, setRenaming] = useState(false);
	const tier = webDeviceTier(device.grants);
	const seen =
		device.lastSeenAt === null
			? t("remote.host.neverSeen")
			: t("remote.host.lastSeen", { time: formatTimeAgo(new Date(device.lastSeenAt).toISOString()) });
	const parts = [
		seen,
		device.tailscaleLogin ? t("mobileWeb.devices.user", { user: device.tailscaleLogin }) : "",
		peerUsageLine(asPeer(device), t) ?? "",
	].filter(Boolean);
	const line = parts.join(" · ");

	const setGrants = (grants: readonly WebPermission[]) =>
		void mobileWebDeviceAction(
			() => window.omp.mobileWeb.devices.setGrants(device.id, [...grants]),
			t("mobileWeb.grantsFailed"),
		);
	const toggle = (permission: WebPermission, on: boolean) =>
		setGrants(WEB_PERMISSIONS.filter(entry => (entry === permission ? on : device.grants.includes(entry))));

	return (
		<div data-web-device={device.id}>
			<ListRow
				actions={
					<IconButton
						icon={<Pencil />}
						label={t("mobileWeb.devices.rename", { name: device.name })}
						onClick={() => setRenaming(true)}
						size="sm"
					/>
				}
				description={
					<span data-device-line title={line}>
						{line}
					</span>
				}
				leading={<Smartphone aria-hidden />}
				meta={
					<span className="flex items-center gap-1.5">
						<Badge dot variant={device.connected ? "success" : "muted"}>
							{t(device.connected ? "remote.state.online" : "remote.state.offline")}
						</Badge>
						<Badge variant={tier === "full" ? "default" : "info"}>{t(`mobileWeb.tier.${tier}`)}</Badge>
					</span>
				}
				title={renaming ? <DeviceName device={device} onDone={() => setRenaming(false)} /> : device.name}
				titleText={device.name}
				trailing={
					<div className="flex items-center gap-1">
						<Button
							aria-label={t("remote.limits.label", { name: device.name })}
							onClick={onLimits}
							size="sm"
							variant="ghost"
						>
							{t("remote.limits.button")}
						</Button>
						<Button
							aria-label={t("mobileWeb.devices.revokeLabel", { name: device.name })}
							data-web-device-revoke
							onClick={onRevoke}
							size="sm"
							variant="ghost"
						>
							{t("mobileWeb.devices.revoke")}
						</Button>
					</div>
				}
			/>
			<div className="flex min-w-0 flex-col gap-1 pr-2 pb-2 pl-9">
				<Select
					aria-label={t("mobileWeb.tier.label", { name: device.name })}
					controlSize="sm"
					data-web-device-tier
					onChange={event => {
						const preset = PRESET_NAMES.find(name => name === event.target.value);
						if (preset) setGrants(WEB_GRANT_PRESETS[preset]);
					}}
					options={[
						...PRESET_NAMES.map(name => ({ value: name, label: t(`mobileWeb.tier.${name}`) })),
						...(tier === "custom"
							? [{ value: "custom", label: t("mobileWeb.tier.custom"), disabled: true }]
							: []),
					]}
					value={tier}
				/>
				<details className="min-w-0 text-sc-sm" data-web-device-permissions>
					<summary className="cursor-pointer py-0.5 text-sc-xs text-(--sc-text-muted)">
						{t("mobileWeb.perms")}
					</summary>
					<ul className="mt-1 flex flex-col gap-1">
						{GRANTABLE.map(permission => (
							<li className="flex items-center justify-between gap-3" key={permission}>
								<span className="min-w-0 break-words text-(--sc-text-secondary)">
									{t(`mobileWeb.perm.${permission}`)}
								</span>
								<Switch
									checked={device.grants.includes(permission)}
									label={t("mobileWeb.perm.label", {
										name: device.name,
										permission: t(`mobileWeb.perm.${permission}`),
									})}
									onCheckedChange={on => toggle(permission, on)}
									size="sm"
								/>
							</li>
						))}
					</ul>
				</details>
			</div>
		</div>
	);
}

export function MobileWebDevices({ devices }: { devices: WebDeviceInfo[] }) {
	const t = useT();
	const [limitsFor, setLimitsFor] = useState<string | null>(null);
	/** The device a Block waits on: it stays out until it is unblocked. */
	const [revoking, setRevoking] = useState<WebDeviceInfo | null>(null);
	const limited = devices.find(device => device.id === limitsFor);
	return (
		<SettingsSection title={t("mobileWeb.devices.title")}>
			{devices.length > 0 ? (
				<div className="flex flex-col gap-px py-2" data-mobile-web-devices>
					{devices.map(device => (
						<DeviceRow
							device={device}
							key={device.id}
							onLimits={() => setLimitsFor(device.id)}
							onRevoke={() => setRevoking(device)}
						/>
					))}
				</div>
			) : (
				<p className="py-3 text-sc-sm text-(--sc-text-muted)">{t("mobileWeb.devices.empty")}</p>
			)}
			<ConfirmDialog
				confirmLabel={t("mobileWeb.devices.revoke")}
				message={
					revoking?.blockScope === "login"
						? t("mobileWeb.devices.revokeBodyLogin", {
								name: revoking.name,
								user: revoking.tailscaleLogin ?? "",
							})
						: t("mobileWeb.devices.revokeBody", { name: revoking?.name ?? "" })
				}
				onCancel={() => setRevoking(null)}
				onConfirm={() => {
					const target = revoking;
					setRevoking(null);
					if (target) {
						void mobileWebDeviceAction(
							() => window.omp.mobileWeb.devices.revoke(target.id),
							t("mobileWeb.devices.revokeFailed"),
						);
					}
				}}
				open={revoking !== null}
				title={t("mobileWeb.devices.revokeTitle", { name: revoking?.name ?? "" })}
			/>
			<PeerLimitsDialog
				key={limitsFor ?? ""}
				onClose={() => setLimitsFor(null)}
				onSave={async (deviceId, limits) => {
					await mobileWebDeviceAction(
						() => window.omp.mobileWeb.devices.setLimits(deviceId, limits),
						t("remote.limits.saveFailed"),
					);
				}}
				peer={limited ? asPeer(limited) : null}
			/>
		</SettingsSection>
	);
}

/** The blocks: a device (its node) or every device of a login, each with Unblock. */
export function MobileWebBlocked({ blocked }: { blocked: WebBlockedInfo[] }) {
	const t = useT();
	return (
		<SettingsSection description={t("mobileWeb.blocked.desc")} title={t("mobileWeb.blocked.title")}>
			<div className="flex flex-col gap-px py-2" data-mobile-web-blocked>
				{blocked.map(entry => {
					const user = entry.tailscaleLogin ?? "";
					const line =
						entry.scope === "login"
							? t("mobileWeb.blocked.login", { user })
							: t("mobileWeb.blocked.node", { user });
					return (
						<div data-web-blocked={entry.id} key={entry.id}>
							<ListRow
								description={<span title={line}>{line}</span>}
								leading={<Ban aria-hidden />}
								title={entry.name}
								titleText={entry.name}
								trailing={
									<Button
										aria-label={t("mobileWeb.blocked.unblockLabel", { name: entry.name })}
										data-web-unblock
										onClick={() => void mobileWebUnblock(entry.id, t("mobileWeb.blocked.failed"))}
										size="sm"
										variant="ghost"
									>
										{t("mobileWeb.blocked.unblock")}
									</Button>
								}
							/>
						</div>
					);
				})}
			</div>
		</SettingsSection>
	);
}

/** The Tailscale logins that may open the page; this computer's own login stays. */
export function MobileWebAllowedUsers({ state }: { state: MobileWebState }) {
	const t = useT();
	const inputId = useId();
	const [draft, setDraft] = useState("");
	const [saving, setSaving] = useState(false);
	const own = state.user?.trim().toLowerCase() ?? null;
	const save = async (users: string[]) => {
		setSaving(true);
		await mobileWebCommand({ action: "set-allowed-users", users }, t("mobileWeb.users.failed"));
		setSaving(false);
	};
	const add = async () => {
		const login = draft.trim();
		if (!login || saving) return;
		setDraft("");
		if (state.allowedUsers.some(entry => entry.trim().toLowerCase() === login.toLowerCase())) return;
		await save([...state.allowedUsers, login]);
	};
	return (
		<SettingsSection description={t("mobileWeb.users.desc")} title={t("mobileWeb.users.title")}>
			<ul className="flex flex-col gap-px py-2" data-mobile-web-users>
				{state.allowedUsers.map(user => {
					const isOwn = user.trim().toLowerCase() === own;
					return (
						<li
							className="flex min-h-(--sc-control-md) min-w-0 items-center gap-2 px-2 text-sc-md"
							data-mobile-web-user={user}
							key={user}
						>
							<span className="min-w-0 flex-1 truncate" title={user}>
								{user}
							</span>
							{isOwn ? (
								<Badge variant="muted">{t("mobileWeb.users.you")}</Badge>
							) : (
								<Button
									aria-label={t("mobileWeb.users.remove", { user })}
									disabled={saving}
									onClick={() => void save(state.allowedUsers.filter(entry => entry !== user))}
									size="sm"
									variant="ghost"
								>
									{t("remote.remove")}
								</Button>
							)}
						</li>
					);
				})}
			</ul>
			<form
				className="flex min-w-0 items-center gap-2"
				onSubmit={event => {
					event.preventDefault();
					void add();
				}}
			>
				<Input
					aria-label={t("mobileWeb.users.add")}
					className="min-w-0 flex-1"
					controlSize="sm"
					data-mobile-web-user-input
					id={inputId}
					onChange={event => setDraft(event.target.value)}
					onKeyDown={event => {
						if (isImeKeyEvent(event) && event.key === "Enter") event.preventDefault();
					}}
					placeholder={t("mobileWeb.users.placeholder")}
					value={draft}
				/>
				<Button
					data-mobile-web-user-add
					disabled={draft.trim() === "" || saving}
					size="sm"
					type="submit"
					variant="secondary"
				>
					{t("mobileWeb.users.addButton")}
				</Button>
			</form>
		</SettingsSection>
	);
}

/**
 * Settings › Devices & connections, OMPdesk sharing between computers, over Tailscale only (no pairing code). Two
 * roles on one page:
 *
 * - Tailscale's side: when it is missing, stopped or signed out, one row says so with the button that fixes it
 *   (Mobile web's own install and start-the-app steps).
 * - This computer's device name (editable at any time, also while sharing is off: a device that only
 *   connects to others is known by it too). Saving announces it live to every connected computer and device.
 * - This computer (B, host): "Let other devices use this computer". While on, it shows "Keep this computer awake
 *   while a device is using it", the tailnet addresses it listens on (or why it listens nowhere: every port it
 *   may use is taken), "Approve new devices on this computer", the devices that use it with an online dot,
 *   today's model use against the daily limits this computer sets for each (Limits), Rename (asks a connected
 *   device to rename itself), Remove (it may connect again while its account is allowed) and Block (keeps its
 *   Tailscale device out), then the allowed Tailscale accounts and the blocked devices, both shared with Mobile web.
 * - Other devices (A, client): the hosts this computer runs sessions on, with their link state, Rename (the host
 *   renames itself; needs the link) and Remove, then the computers of the tailnet with Connect.
 *
 * Main owns the state; every action answers with the whole new RemoteState.
 */
import {
	Ban,
	Coffee,
	Monitor,
	MonitorSmartphone,
	Network,
	Palette,
	Pencil,
	RefreshCw,
	ShieldCheck,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { RemoteHostState, RemoteState, TailnetComputer } from "../../../shared/ipc-types";
import { useHostAppearanceStore } from "../../hooks/use-host-appearance";
import { formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { onEscape } from "../../lib/keymap";
import { loadMobileWeb, useMobileWebStore } from "../../stores/mobile-web";
import { loadRemoteState, useRemoteStore } from "../../stores/remote";
import { toastError } from "../../stores/toast";
import {
	Badge,
	Banner,
	Button,
	ConfirmDialog,
	CopyButton,
	ErrorDetail,
	IconButton,
	Input,
	ListRow,
	SkeletonRows,
} from "../common";
import { LINK_BADGE } from "../remote/DeviceChip";
import { DeviceNameField } from "./DeviceNameField";
import { MobileWebAllowedUsers, MobileWebBlocked } from "./MobileWebDevices";
import { PeerLimitsDialog, peerUsageLine } from "./PeerLimitsDialog";
import { SettingsRow, SettingsSection, SettingsSwitchRow, SettingsTipOnly } from "./SettingsLayout";

/** Apply a mutation's reply, or toast why it failed. */
async function mutate(action: () => Promise<RemoteState>, failureTitle: string): Promise<void> {
	try {
		useRemoteStore.getState().apply(await action());
	} catch (error) {
		toastError({ title: failureTitle, error });
	}
}

/** Selectable monospace value with a copy button. */
function CopyableValue({ value }: { value: string }) {
	const t = useT();
	return (
		<span className="inline-flex min-w-0 items-center gap-1">
			<span className="min-w-0 truncate font-mono text-sc-sm text-(--sc-text) select-all" data-copyable={value}>
				{value}
			</span>
			<CopyButton label={t("remote.copy", { value })} text={value} />
		</span>
	);
}

/** Tailscale missing, stopped or signed out: what is wrong and the one button that fixes it. */
function TailscaleRow({ phase }: { phase: RemoteState["tailnet"] }) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	if (phase === "ready") return null;
	const action = phase === "not-installed" ? "install" : "start-app";
	return (
		<SettingsRow
			control={
				<Button
					data-remote-tailscale-action={action}
					loading={busy}
					onClick={() => {
						setBusy(true);
						void mutate(() => window.omp.remote.tailscaleAction(action), t("remote.tailscale.failed")).finally(
							() => setBusy(false),
						);
					}}
					size="sm"
					variant="secondary"
				>
					{t(action === "install" ? "remote.tailscale.install" : "remote.tailscale.open")}
				</Button>
			}
			icon={<Network />}
			id="settings-remote-tailscale"
			label={<span data-remote-tailscale={phase}>{t(`remote.tailscale.${phase}`)}</span>}
		/>
	);
}

/** Code-paired computers an older release kept that were not found on the tailnet: said once, then dismissed. */
function ForgottenNotice({ names }: { names: string[] }) {
	const t = useT();
	if (names.length === 0) return null;
	return (
		<Banner
			actions={
				<Button
					data-remote-forgotten-dismiss
					onClick={() => void mutate(() => window.omp.remote.dismissForgotten(), t("remote.loadFailed"))}
					size="sm"
					variant="secondary"
				>
					{t("remote.forgotten.dismiss")}
				</Button>
			}
			title={t("remote.forgotten.title")}
			variant="info"
		>
			<span data-remote-forgotten>{t("remote.forgotten.body", { names: names.join(", ") })}</span>
		</Banner>
	);
}

/** The tailnet's computers while this view is open: who shares OMPdesk, who refuses this device and why, Connect. */
function TailnetComputers({ ready }: { ready: boolean }) {
	const t = useT();
	const [computers, setComputers] = useState<TailnetComputer[] | null>(null);
	const [connecting, setConnecting] = useState<string | null>(null);
	useEffect(() => {
		const off = window.omp.remote.onTailnet(setComputers);
		window.omp.remote.watchTailnet(true).then(
			list => setComputers(Array.isArray(list) ? list : []),
			() => setComputers([]),
		);
		return () => {
			off();
			void window.omp.remote.watchTailnet(false).catch(() => {});
		};
	}, []);
	const connect = async (computer: TailnetComputer) => {
		setConnecting(computer.nodeId);
		try {
			await window.omp.remote.connect(computer.nodeId);
			await loadRemoteState();
		} catch (error) {
			toastError({ title: t("remote.tailnet.connectFailed"), error });
		} finally {
			setConnecting(null);
		}
	};
	return (
		<SettingsRow description={t("remote.tailnet.desc")} label={t("remote.tailnet.title")} tipOnly>
			{!ready ? null : computers === null ? (
				<p className="text-sc-sm text-(--sc-text-muted)">{t("remote.tailnet.searching")}</p>
			) : computers.length === 0 ? (
				<p className="text-sc-sm text-(--sc-text-muted)" data-remote-tailnet-empty>
					{t("remote.tailnet.empty")}
				</p>
			) : (
				<div className="flex flex-col gap-px" data-remote-tailnet>
					{computers.map(computer => {
						const status =
							computer.state === "refused"
								? t(`remote.tailnet.refused.${computer.refusal ?? "protocol"}`)
								: t(computer.state === "available" ? "remote.tailnet.available" : "remote.tailnet.absent");
						return (
							<ListRow
								description={
									<span title={computer.login ?? undefined}>
										{computer.login ? `${computer.login} · ${status}` : status}
									</span>
								}
								key={computer.nodeId}
								leading={<Monitor aria-hidden />}
								rowProps={{
									"data-remote-tailnet-row": computer.nodeId,
									"data-remote-tailnet-state": computer.state,
								}}
								title={computer.name}
								titleText={computer.name}
								trailing={
									computer.connected ? (
										<Badge variant="muted">{t("remote.tailnet.connected")}</Badge>
									) : computer.state === "available" ? (
										<Button
											aria-label={t("remote.tailnet.connectLabel", { name: computer.name })}
											data-remote-tailnet-connect={computer.nodeId}
											loading={connecting === computer.nodeId}
											onClick={() => void connect(computer)}
											size="sm"
											variant="secondary"
										>
											{t("remote.tailnet.connect")}
										</Button>
									) : undefined
								}
							/>
						);
					})}
				</div>
			)}
		</SettingsRow>
	);
}

function DeviceNameRow({ name }: { name: string }) {
	const t = useT();
	const inputId = useId();
	const [draft, setDraft] = useState(name);
	const [editing, setEditing] = useState(false);
	useEffect(() => {
		if (!editing) setDraft(name);
	}, [editing, name]);
	const commit = (value: string) => {
		setEditing(false);
		const next = value.trim();
		if (!next || next === name) {
			setDraft(name);
			return;
		}
		void mutate(() => window.omp.remote.setDeviceName(next), t("remote.host.renameFailed"));
	};
	return (
		<SettingsRow
			control={
				<Input
					controlSize="sm"
					id={inputId}
					maxLength={64}
					onBlur={event => commit(event.currentTarget.value)}
					onChange={event => setDraft(event.target.value)}
					onFocus={() => setEditing(true)}
					onKeyDown={event => {
						if (isImeKeyEvent(event)) return;
						if (event.key === "Enter") event.currentTarget.blur();
						onEscape(event, () => {
							setDraft(name);
							setEditing(false);
						});
					}}
					value={draft}
				/>
			}
			htmlFor={inputId}
			label={t("remote.host.name")}
		/>
	);
}

/** The host's keep-awake option; its description is the live state while it is on. */
function KeepAwakeRow({ host }: { host: RemoteHostState }) {
	const t = useT();
	const [saving, setSaving] = useState(false);
	let description = t("remote.host.keepAwakeDesc");
	if (host.keepAwake && host.keepingAwake) {
		description =
			host.usedBy.length > 0
				? t("remote.host.keepingAwakeFor", { names: host.usedBy.join(", ") })
				: t("remote.host.keepingAwake");
	}
	return (
		<SettingsSwitchRow
			icon={<Coffee />}
			checked={host.keepAwake}
			description={<span data-remote-keep-awake-state>{description}</span>}
			disabled={saving}
			id="settings-remote-keep-awake"
			label={t("remote.host.keepAwake")}
			onCheckedChange={enabled => {
				setSaving(true);
				void mutate(() => window.omp.remote.setKeepAwake(enabled), t("remote.host.keepAwakeFailed")).finally(() =>
					setSaving(false),
				);
			}}
		/>
	);
}

/** A row's Rename; the other device renames itself, so it needs the link (the tooltip says why). */
function RenameButton({ name, offline, onClick }: { name: string; offline: boolean; onClick: () => void }) {
	const t = useT();
	return (
		<IconButton
			data-device-rename-button
			disabled={offline}
			icon={<Pencil />}
			label={offline ? t("remote.renameOffline", { name }) : t("remote.rename", { name })}
			onClick={onClick}
			size="sm"
		/>
	);
}

/** B16: show a paired host's theme and language while one of its tabs is focused (never saved here). */
function HostAppearanceRow() {
	const t = useT();
	const enabled = useHostAppearanceStore(state => state.enabled);
	const setEnabled = useHostAppearanceStore(state => state.setEnabled);
	return (
		<SettingsSwitchRow
			icon={<Palette />}
			checked={enabled}
			description={t("remote.hosts.useHostAppearanceDesc")}
			tipOnly
			id="setting-remote-host-appearance"
			label={t("remote.hosts.useHostAppearance")}
			onCheckedChange={next => void setEnabled(next)}
		/>
	);
}

export function RemoteSection() {
	const t = useT();
	const state = useRemoteStore(store => store.state);
	const loadError = useRemoteStore(store => store.loadError);
	const [toggling, setToggling] = useState(false);
	/** The device a Remove or Block is waiting to be confirmed for. */
	const [pendingRemove, setPendingRemove] = useState<{
		kind: "peer" | "host" | "block";
		deviceId: string;
		name: string;
	} | null>(null);
	/** The device whose Limits dialog is open. */
	const [limitsFor, setLimitsFor] = useState<string | null>(null);
	/** The row whose name is being edited: `peer:<id>` or `host:<id>`. */
	const [renaming, setRenaming] = useState<string | null>(null);
	// The allowed accounts and the blocks are Mobile web's (one list, one set of blocks for both).
	const mobileWeb = useMobileWebStore(store => store.state);
	const blocked = useMobileWebStore(store => store.blocked);

	const confirmRemove = () => {
		const target = pendingRemove;
		setPendingRemove(null);
		if (!target) return;
		const action = {
			peer: () => window.omp.remote.revokePeer(target.deviceId),
			host: () => window.omp.remote.removeHost(target.deviceId),
			block: () => window.omp.remote.blockPeer(target.deviceId),
		}[target.kind];
		void mutate(action, t(target.kind === "block" ? "remote.blockFailed" : "remote.removeFailed")).then(() => {
			if (target.kind === "block") void loadMobileWeb();
		});
	};

	useEffect(() => {
		void loadRemoteState();
		void loadMobileWeb();
	}, []);

	if (!state) {
		return loadError ? (
			<Banner
				actions={
					<Button icon={<RefreshCw />} onClick={() => void loadRemoteState()} size="sm" variant="secondary">
						{t("common.retry")}
					</Button>
				}
				live
				title={t("remote.loadFailed")}
				variant="danger"
			>
				<ErrorDetail error={loadError} />
			</Banner>
		) : (
			<SkeletonRows className="py-2" label={t("common.loading")} widths={[60, 44, 70, 52]} />
		);
	}

	const { host, hosts } = state;
	return (
		<div className="flex flex-col gap-8" data-remote-section>
			<ForgottenNotice names={state.forgotten} />
			<SettingsSection title={t("remote.host.title")}>
				<TailscaleRow phase={state.tailnet} />
				<SettingsSwitchRow
					icon={<MonitorSmartphone />}
					checked={host.enabled}
					description={t("remote.host.toggleDesc")}
					tipOnly
					disabled={toggling}
					id="settings-remote-host"
					label={t("remote.host.toggle")}
					onCheckedChange={enabled => {
						setToggling(true);
						void mutate(() => window.omp.remote.setHostEnabled(enabled), t("remote.host.toggleFailed")).finally(
							() => setToggling(false),
						);
					}}
				/>
				<DeviceNameRow name={host.name} />
				{host.enabled && (
					<>
						<KeepAwakeRow host={host} />
						<SettingsRow description={t("remote.host.addressesDesc")} tipOnly label={t("remote.host.addresses")}>
							{host.listenError ? (
								<p className="text-sc-sm text-(--sc-warning)" data-remote-port-in-use role="status">
									{t("remote.host.portInUse", {
										first: String(host.listenError.ports[0] ?? ""),
										last: String(host.listenError.ports.at(-1) ?? ""),
									})}
								</p>
							) : host.addresses.length > 0 ? (
								<ul className="flex flex-col gap-1" data-remote-addresses>
									{host.addresses.map(address => (
										<li key={address}>
											<CopyableValue value={address} />
										</li>
									))}
								</ul>
							) : (
								<p className="text-sc-sm text-(--sc-text-muted)">{t("remote.host.noAddresses")}</p>
							)}
						</SettingsRow>
						<SettingsSwitchRow
							icon={<ShieldCheck />}
							checked={host.confirmNewDevices}
							description={t("remote.host.confirmNewDesc")}
							tipOnly
							id="settings-remote-confirm-new"
							label={t("remote.host.confirmNew")}
							onCheckedChange={on =>
								void mutate(() => window.omp.remote.setConfirmNewDevices(on), t("remote.host.confirmNewFailed"))
							}
						/>
						<SettingsRow label={t("remote.host.peers")}>
							{host.peers.length > 0 ? (
								<div className="flex flex-col gap-px" data-remote-peers>
									{host.peers.map(peer => {
										const seen =
											peer.lastSeenAt === null
												? t("remote.host.neverSeen")
												: t("remote.host.lastSeen", {
														time: formatTimeAgo(new Date(peer.lastSeenAt).toISOString()),
													});
										const usage = peerUsageLine(peer, t);
										const line = usage ? `${seen} · ${usage}` : seen;
										return (
											<ListRow
												actions={
													<RenameButton
														name={peer.name}
														offline={!peer.online}
														onClick={() => setRenaming(`peer:${peer.deviceId}`)}
													/>
												}
												// A narrow window truncates both lines; hover names them in full.
												description={
													<span data-peer-usage title={line}>
														{line}
													</span>
												}
												key={peer.deviceId}
												leading={<Monitor aria-hidden />}
												meta={
													<Badge dot variant={peer.online ? "success" : "muted"}>
														{t(peer.online ? "remote.state.online" : "remote.state.offline")}
													</Badge>
												}
												rowProps={{ "data-remote-peer": peer.deviceId }}
												title={
													renaming === `peer:${peer.deviceId}` ? (
														<DeviceNameField
															name={peer.name}
															onDone={() => setRenaming(null)}
															onSave={next =>
																void mutate(
																	() => window.omp.remote.renamePeer(peer.deviceId, next),
																	t("remote.renameFailed"),
																)
															}
														/>
													) : (
														peer.name
													)
												}
												titleText={peer.name}
												trailing={
													<div className="flex items-center gap-1">
														<Button
															aria-label={t("remote.limits.label", { name: peer.name })}
															onClick={() => setLimitsFor(peer.deviceId)}
															size="sm"
															variant="ghost"
														>
															{t("remote.limits.button")}
														</Button>
														<Button
															aria-label={t("remote.removeLabel", { name: peer.name })}
															onClick={() =>
																setPendingRemove({
																	kind: "peer",
																	deviceId: peer.deviceId,
																	name: peer.name,
																})
															}
															size="sm"
															variant="ghost"
														>
															{t("remote.remove")}
														</Button>
														<Button
															aria-label={t("remote.blockLabel", { name: peer.name })}
															data-remote-peer-block={peer.deviceId}
															icon={<Ban />}
															onClick={() =>
																setPendingRemove({
																	kind: "block",
																	deviceId: peer.deviceId,
																	name: peer.name,
																})
															}
															size="sm"
															variant="ghost"
														>
															{t("remote.block")}
														</Button>
													</div>
												}
											/>
										);
									})}
								</div>
							) : (
								<p className="text-sc-sm text-(--sc-text-muted)">{t("remote.host.noPeers")}</p>
							)}
						</SettingsRow>
					</>
				)}
			</SettingsSection>
			{host.enabled && mobileWeb && <MobileWebAllowedUsers state={mobileWeb} />}
			{host.enabled && blocked && blocked.length > 0 && <MobileWebBlocked blocked={blocked} />}

			<SettingsTipOnly value>
				<SettingsSection description={t("remote.hosts.desc")} title={t("remote.hosts.title")}>
					{hosts.length > 0 && (
						<div className="flex flex-col gap-px py-2" data-remote-hosts>
							{hosts.map(entry => (
								<ListRow
									actions={
										<RenameButton
											name={entry.name}
											offline={entry.state !== "online"}
											onClick={() => setRenaming(`host:${entry.deviceId}`)}
										/>
									}
									description={
										entry.home ? (
											// The row truncates the host's folder; hover names it in full.
											<span className="font-mono" title={entry.home}>
												{entry.home}
											</span>
										) : undefined
									}
									key={entry.deviceId}
									leading={<Monitor aria-hidden />}
									meta={
										<Badge dot pulse={entry.state === "connecting"} variant={LINK_BADGE[entry.state]}>
											{t(`remote.state.${entry.state}`)}
										</Badge>
									}
									rowProps={{ "data-remote-host": entry.deviceId }}
									title={
										renaming === `host:${entry.deviceId}` ? (
											<DeviceNameField
												name={entry.name}
												onDone={() => setRenaming(null)}
												onSave={next =>
													void mutate(
														() => window.omp.remote.renameHost(entry.deviceId, next),
														t("remote.renameFailed"),
													)
												}
											/>
										) : (
											entry.name
										)
									}
									titleText={entry.name}
									trailing={
										<Button
											aria-label={t("remote.removeLabel", { name: entry.name })}
											onClick={() =>
												setPendingRemove({ kind: "host", deviceId: entry.deviceId, name: entry.name })
											}
											size="sm"
											variant="ghost"
										>
											{t("remote.remove")}
										</Button>
									}
								/>
							))}
						</div>
					)}
					<TailnetComputers ready={state.tailnet === "ready"} />
					<HostAppearanceRow />
				</SettingsSection>
			</SettingsTipOnly>
			<ConfirmDialog
				confirmLabel={t(pendingRemove?.kind === "block" ? "remote.block" : "remote.remove")}
				message={t(
					pendingRemove?.kind === "host"
						? "remote.removeHostBody"
						: pendingRemove?.kind === "block"
							? "remote.blockBody"
							: "remote.removePeerBody",
					{ name: pendingRemove?.name ?? "" },
				)}
				onCancel={() => setPendingRemove(null)}
				onConfirm={confirmRemove}
				open={pendingRemove !== null}
				title={t(pendingRemove?.kind === "block" ? "remote.blockTitle" : "remote.removeTitle", {
					name: pendingRemove?.name ?? "",
				})}
			/>
			<PeerLimitsDialog
				key={limitsFor ?? ""}
				onClose={() => setLimitsFor(null)}
				onSave={(deviceId, limits) =>
					mutate(() => window.omp.remote.setPeerLimits(deviceId, limits), t("remote.limits.saveFailed"))
				}
				peer={host.peers.find(peer => peer.deviceId === limitsFor) ?? null}
			/>
		</div>
	);
}

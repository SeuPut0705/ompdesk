/**
 * Settings › Devices & connections, OMPdesk sharing. Two roles on one page:
 *
 * - This computer (B, host): "Let other devices use this computer". While on,
 *   it shows "Keep this computer awake while a device is using it" (on by
 *   default; its description says whether sleep is blocked now and for whom),
 *   the device name (editable), the LAN addresses and a single-use pairing
 *   code with its countdown — both selectable and copyable — and the paired
 *   devices with an online dot and Remove (revoke). An expired code is
 *   replaced on its own.
 * - Other devices (A, client): the hosts this computer can run sessions on,
 *   with their link state and Remove, plus "Connect to a device".
 *
 * Either Remove asks first: the pair only comes back with a new code.
 *
 * Main owns the state; every action answers with the whole new RemoteState.
 */
import { Copy, Monitor, Plus, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { RemoteHostState, RemoteState } from "../../../shared/ipc-types";
import { copyText, formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { onEscape } from "../../lib/keymap";
import { loadRemoteState, useRemoteStore } from "../../stores/remote";
import { toast, toastError } from "../../stores/toast";
import { Badge, Banner, Button, ConfirmDialog, ErrorDetail, IconButton, Input, ListRow, Spinner } from "../common";
import { LINK_BADGE } from "../remote/DeviceChip";
import { RemoteConnectDialog } from "../remote/RemoteConnectDialog";
import { SettingsRow, SettingsSection, SettingsSwitchRow } from "./SettingsLayout";

/** Apply a mutation's reply, or toast why it failed. */
async function mutate(action: () => Promise<RemoteState>, failureTitle: string): Promise<void> {
	try {
		useRemoteStore.getState().apply(await action());
	} catch (error) {
		toastError({ title: failureTitle, error });
	}
}

/** Selectable monospace value with a copy button. */
function CopyableValue({ value, large }: { value: string; large?: boolean }) {
	const t = useT();
	return (
		<span className="inline-flex min-w-0 items-center gap-1">
			<span
				className={
					large
						? "font-mono text-sc-xl font-semibold tracking-[0.12em] text-(--sc-text) select-all"
						: "min-w-0 truncate font-mono text-sc-sm text-(--sc-text) select-all"
				}
				data-copyable={value}
			>
				{value}
			</span>
			<IconButton
				icon={<Copy />}
				label={t("remote.copy", { value })}
				onClick={() =>
					void copyText(value).then(ok =>
						toast(
							ok
								? { variant: "success", message: t("remote.copied") }
								: { variant: "error", message: t("remote.copyFailed") },
						),
					)
				}
				size="sm"
			/>
		</span>
	);
}

/** m:ss until `expiresAt`. */
function remaining(expiresAt: number, now: number): string {
	const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The pairing code, its countdown, and the refresh; an expired code is replaced automatically. */
function PairingCode({ code, expiresAt }: { code: string | null; expiresAt: number | null }) {
	const t = useT();
	// Re-renders every second; the countdown itself reads the clock at render time,
	// so a code that just arrived never shows more than its lifetime.
	const [, setTick] = useState(0);
	const [rotating, setRotating] = useState(false);
	/** The expiry already handed to an automatic refresh, so a slow reply is not asked for twice. */
	const rotatedFor = useRef<number | null>(null);

	useEffect(() => {
		const timer = window.setInterval(() => setTick(tick => tick + 1), 1000);
		return () => window.clearInterval(timer);
	}, []);

	const rotate = async () => {
		setRotating(true);
		await mutate(() => window.omp.remote.rotateCode(), t("remote.host.codeFailed"));
		setRotating(false);
	};

	useEffect(() => {
		if (expiresAt === null || Date.now() < expiresAt || rotatedFor.current === expiresAt) return;
		rotatedFor.current = expiresAt;
		void rotate();
	});

	return (
		<SettingsRow description={t("remote.host.codeDesc")} id="settings-remote-code" label={t("remote.host.code")}>
			<div className="flex flex-wrap items-center gap-3" data-remote-code>
				{code ? <CopyableValue large value={code} /> : <Spinner size="sm" />}
				{expiresAt !== null && (
					<span className="text-sc-sm text-(--sc-text-muted) tabular-nums" data-remote-code-expiry>
						{t("remote.host.expiresIn", { time: remaining(expiresAt, Date.now()) })}
					</span>
				)}
				<Button
					data-remote-rotate
					icon={<RefreshCw />}
					loading={rotating}
					onClick={() => void rotate()}
					size="sm"
					variant="secondary"
				>
					{t("remote.host.newCode")}
				</Button>
			</div>
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
			description={t("remote.host.nameDesc")}
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

export function RemoteSection() {
	const t = useT();
	const state = useRemoteStore(store => store.state);
	const loadError = useRemoteStore(store => store.loadError);
	const [toggling, setToggling] = useState(false);
	const [connectOpen, setConnectOpen] = useState(false);
	/** The device a Remove is waiting to be confirmed for; it can only come back with a new code. */
	const [pendingRemove, setPendingRemove] = useState<{
		kind: "peer" | "host";
		deviceId: string;
		name: string;
	} | null>(null);

	const confirmRemove = () => {
		const target = pendingRemove;
		setPendingRemove(null);
		if (!target) return;
		void mutate(
			() =>
				target.kind === "peer"
					? window.omp.remote.revokePeer(target.deviceId)
					: window.omp.remote.removeHost(target.deviceId),
			t("remote.removeFailed"),
		);
	};

	useEffect(() => {
		void loadRemoteState();
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
			<div className="flex justify-center py-8">
				<Spinner />
			</div>
		);
	}

	const { host, hosts } = state;
	return (
		<div className="flex flex-col gap-8" data-remote-section>
			<SettingsSection title={t("remote.host.title")}>
				<SettingsSwitchRow
					checked={host.enabled}
					description={t("remote.host.toggleDesc")}
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
				{host.enabled && (
					<>
						<KeepAwakeRow host={host} />
						<DeviceNameRow name={host.name} />
						<SettingsRow description={t("remote.host.addressesDesc")} label={t("remote.host.addresses")}>
							{host.addresses.length > 0 ? (
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
						<PairingCode code={host.code} expiresAt={host.expiresAt} />
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
										return (
											<ListRow
												// A narrow window truncates both lines; hover names them in full.
												description={<span title={seen}>{seen}</span>}
												key={peer.deviceId}
												leading={<Monitor aria-hidden />}
												meta={
													<Badge dot variant={peer.online ? "success" : "muted"}>
														{t(peer.online ? "remote.state.online" : "remote.state.offline")}
													</Badge>
												}
												rowProps={{ "data-remote-peer": peer.deviceId }}
												title={peer.name}
												titleText={peer.name}
												trailing={
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

			<SettingsSection
				actions={
					<Button
						data-remote-connect
						icon={<Plus />}
						onClick={() => setConnectOpen(true)}
						size="sm"
						variant="secondary"
					>
						{t("remote.hosts.connect")}
					</Button>
				}
				description={t("remote.hosts.desc")}
				title={t("remote.hosts.title")}
			>
				{hosts.length > 0 ? (
					<div className="flex flex-col gap-px py-2" data-remote-hosts>
						{hosts.map(entry => (
							<ListRow
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
								title={entry.name}
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
				) : (
					<p className="py-3 text-sc-sm text-(--sc-text-muted)">{t("remote.hosts.empty")}</p>
				)}
			</SettingsSection>
			<RemoteConnectDialog onClose={() => setConnectOpen(false)} open={connectOpen} />
			<ConfirmDialog
				confirmLabel={t("remote.remove")}
				message={t(pendingRemove?.kind === "host" ? "remote.removeHostBody" : "remote.removePeerBody", {
					name: pendingRemove?.name ?? "",
				})}
				onCancel={() => setPendingRemove(null)}
				onConfirm={confirmRemove}
				open={pendingRemove !== null}
				title={t("remote.removeTitle", { name: pendingRemove?.name ?? "" })}
			/>
		</div>
	);
}

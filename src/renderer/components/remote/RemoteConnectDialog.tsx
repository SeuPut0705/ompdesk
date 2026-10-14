/**
 * "Connect to a device": pairs this computer (A) with another OMPdesk (B).
 * LAN discovery runs only while the dialog is open; a discovered device fills
 * the address, and a typed `host` / `host:port` works without discovery (VPNs,
 * Tailscale). The code is the one B shows in Settings › Devices & connections.
 * Pairing failures show B's localized reason (wrong code, expired, locked,
 * unreachable, version mismatch); success closes the dialog.
 */
import { Monitor } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { RemoteDiscoveredDevice } from "../../../shared/ipc-types";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { toast } from "../../stores/toast";
import { Badge, Button, ErrorDetail, InlineNotice, Input, ListRow, Modal, Spinner } from "../common";

/** Codes are 8 Crockford base32 characters shown as XXXX-XXXX; accept any case and spacing. */
function formatCode(raw: string): string {
	const chars = raw
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, "")
		.slice(0, 8);
	return chars.length > 4 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars;
}

export function RemoteConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const t = useT();
	const headingId = useId();
	const [devices, setDevices] = useState<RemoteDiscoveredDevice[]>([]);
	const [discovering, setDiscovering] = useState(false);
	const [discoverError, setDiscoverError] = useState<InlineFailure | null>(null);
	const [address, setAddress] = useState("");
	const [code, setCode] = useState("");
	const [pairing, setPairing] = useState(false);
	const [error, setError] = useState<InlineFailure | null>(null);

	// Discovery lives exactly as long as the dialog is open.
	useEffect(() => {
		if (!open) return;
		let alive = true;
		setAddress("");
		setCode("");
		setError(null);
		setDiscoverError(null);
		setDevices([]);
		setDiscovering(true);
		const unsubscribe = window.omp.remote.onDiscovered(next => {
			if (alive) setDevices(next);
		});
		void window.omp.remote
			.discover("start")
			.then(
				initial => {
					if (alive) setDevices(current => (current.length > 0 ? current : initial));
				},
				(cause: unknown) => {
					if (alive) setDiscoverError(inlineFailure(cause, t("remote.connect.discoverFailed")));
				},
			)
			.finally(() => {
				if (alive) setDiscovering(false);
			});
		return () => {
			alive = false;
			unsubscribe();
			void window.omp.remote.discover("stop").catch(() => {});
		};
	}, [open, t]);

	const normalizedCode = code.replace("-", "");
	const canSubmit = address.trim() !== "" && normalizedCode.length === 8 && !pairing;
	const requestClose = () => {
		if (!pairing) onClose();
	};
	const submit = async () => {
		if (!canSubmit) return;
		setPairing(true);
		setError(null);
		try {
			const host = await window.omp.remote.pair({ address: address.trim(), code });
			toast({ variant: "success", message: t("remote.connect.success", { name: host.name }) });
			onClose();
		} catch (cause) {
			setError(inlineFailure(cause, t("remote.connect.failed")));
		} finally {
			setPairing(false);
		}
	};

	return (
		<Modal
			footer={
				<>
					<Button disabled={pairing} onClick={requestClose} variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button
						data-remote-connect-submit
						disabled={!canSubmit}
						loading={pairing}
						onClick={() => void submit()}
						variant="primary"
					>
						{t("remote.connect.submit")}
					</Button>
				</>
			}
			onClose={requestClose}
			open={open}
			title={t("remote.connect.title")}
		>
			<div className="flex flex-col gap-4">
				<section aria-labelledby={headingId} className="flex flex-col gap-1.5">
					<div className="flex items-center gap-2">
						<h3 className="text-sc-sm font-medium text-(--sc-text-secondary)" id={headingId}>
							{t("remote.connect.discovered")}
						</h3>
						{discovering && <Spinner size="sm" />}
					</div>
					<div className="flex flex-col gap-px" data-remote-discovered>
						{devices.map(device => (
							<ListRow
								buttonProps={{ "data-remote-device": device.deviceId }}
								description={<span className="break-all font-mono">{device.address}</span>}
								key={`${device.deviceId}@${device.address}`}
								leading={<Monitor aria-hidden />}
								meta={device.paired ? <Badge variant="muted">{t("remote.connect.paired")}</Badge> : undefined}
								onClick={() => setAddress(device.address)}
								selected={address.trim() === device.address}
								title={device.name}
							/>
						))}
					</div>
					{devices.length === 0 && (
						<p className="text-sc-sm text-(--sc-text-muted)" role="status">
							{discovering ? t("remote.connect.searching") : t("remote.connect.noneFound")}
						</p>
					)}
					{discoverError && (
						<p className="text-sc-sm text-(--sc-warning)">
							{discoverError.message}
							<ErrorDetail className="mt-0.5" error={discoverError.cause} />
						</p>
					)}
				</section>
				<Input
					autoCapitalize="off"
					autoCorrect="off"
					data-remote-address
					disabled={pairing}
					hint={t("remote.connect.addressHint")}
					label={t("remote.connect.address")}
					mono
					onChange={event => setAddress(event.target.value)}
					placeholder="192.168.0.12:47821"
					spellCheck={false}
					value={address}
				/>
				<Input
					autoCapitalize="characters"
					autoComplete="one-time-code"
					data-remote-code
					disabled={pairing}
					hint={t("remote.connect.codeHint")}
					label={t("remote.connect.code")}
					mono
					onChange={event => setCode(formatCode(event.target.value))}
					onKeyDown={event => {
						if (event.key === "Enter" && !isImeKeyEvent(event)) void submit();
					}}
					placeholder="XXXX-XXXX"
					spellCheck={false}
					value={code}
				/>
				{error && (
					<div data-remote-connect-error>
						<InlineNotice detail={error.cause} live title={error.message} tone="danger" />
					</div>
				)}
			</div>
		</Modal>
	);
}

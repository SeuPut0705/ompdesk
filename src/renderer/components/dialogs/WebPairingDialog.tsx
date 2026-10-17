/**
 * Desktop-only approval of a new device (`mobileWeb.pairing.onRequest`), asked only while "Approve new devices on
 * this computer" is on: a device signed in to an allowed Tailscale account opened Mobile web and waits. The dialog
 * shows who asks (name, browser, Tailscale user, address), lets the user pick the access preset and answers
 * Approve or Decline (`pairing.respond`). Closing it declines. Requests queue; one that expires unanswered drops out.
 */
import { useEffect, useState } from "react";
import {
	WEB_GRANT_PRESETS,
	type WebGrantPreset,
	type WebPairingRequest,
	webDeviceTier,
} from "../../../shared/mobile-web";
import { useT } from "../../lib/i18n";
import { toastError } from "../../stores/toast";
import { Button, Modal, Select } from "../common";

const PRESET_NAMES = Object.keys(WEB_GRANT_PRESETS) as WebGrantPreset[];

function Detail({ label, value }: { label: string; value: string }) {
	return (
		<>
			<dt className="text-(--sc-text-muted)">{label}</dt>
			<dd className="min-w-0 break-words text-(--sc-text) select-text">{value}</dd>
		</>
	);
}

/** One request; mounted per request id, so its preset choice starts from what the request proposes. */
function PairingRequestDialog({
	request,
	onAnswered,
}: {
	request: WebPairingRequest;
	onAnswered: (id: string) => void;
}) {
	const t = useT();
	const proposed = webDeviceTier(request.grants);
	const [tier, setTier] = useState<string>(proposed);
	const [busy, setBusy] = useState(false);

	const respond = async (approve: boolean) => {
		setBusy(true);
		const preset = PRESET_NAMES.find(name => name === tier);
		try {
			await window.omp.mobileWeb.pairing.respond({
				id: request.id,
				approve,
				...(approve && preset ? { grants: [...WEB_GRANT_PRESETS[preset]] } : {}),
			});
		} catch (error) {
			toastError({ title: t("mobileWeb.request.failed"), error });
		} finally {
			setBusy(false);
			onAnswered(request.id);
		}
	};

	return (
		<Modal
			description={t("mobileWeb.request.body")}
			footer={
				<>
					<Button disabled={busy} onClick={() => void respond(false)} variant="secondary">
						{t("mobileWeb.request.decline")}
					</Button>
					<Button
						autoFocus
						data-web-pairing-approve
						loading={busy}
						onClick={() => void respond(true)}
						variant="primary"
					>
						{t("mobileWeb.request.approve")}
					</Button>
				</>
			}
			onClose={() => void respond(false)}
			open
			size="sm"
			title={t("mobileWeb.request.title", { name: request.name })}
		>
			<div className="flex flex-col gap-3" data-web-pairing-request={request.id}>
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sc-sm">
					<Detail label={t("mobileWeb.request.device")} value={request.name} />
					<Detail label={t("mobileWeb.request.browser")} value={request.userAgent} />
					{request.tailscaleLogin && <Detail label={t("mobileWeb.request.user")} value={request.tailscaleLogin} />}
					{request.ip && <Detail label={t("mobileWeb.request.address")} value={request.ip} />}
				</dl>
				<Select
					controlSize="sm"
					label={t("mobileWeb.request.access")}
					onChange={event => setTier(event.target.value)}
					options={[
						...PRESET_NAMES.map(name => ({ value: name, label: t(`mobileWeb.tier.${name}`) })),
						...(proposed === "custom" ? [{ value: "custom", label: t("mobileWeb.tier.custom") }] : []),
					]}
					value={tier}
				/>
			</div>
		</Modal>
	);
}

export function WebPairingDialog() {
	const [requests, setRequests] = useState<WebPairingRequest[]>([]);
	useEffect(
		() =>
			window.omp.mobileWeb.pairing.onRequest(request =>
				setRequests(queue => [...queue.filter(entry => entry.id !== request.id), request]),
			),
		[],
	);
	const current = requests[0];
	// A request nobody answered in time is gone on main's side too.
	useEffect(() => {
		if (!current) return;
		const timer = window.setTimeout(
			() => setRequests(queue => queue.filter(entry => entry.id !== current.id)),
			Math.max(0, current.expiresAt - Date.now()),
		);
		return () => window.clearTimeout(timer);
	}, [current]);
	if (!current) return null;
	return (
		<PairingRequestDialog
			key={current.id}
			onAnswered={id => setRequests(queue => queue.filter(entry => entry.id !== id))}
			request={current}
		/>
	);
}

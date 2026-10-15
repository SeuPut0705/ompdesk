/**
 * Settings › Devices & connections › paired device › Limits (D65): how many
 * model requests and tokens the device may spend on this computer's models per
 * day. An empty field has no limit. Main enforces them on the host
 * (remote/peer-quota.ts); the device sees "limit reached" on its next request.
 */
import { useState } from "react";
import type { PeerLimits, PeerView } from "../../../shared/ipc-types";
import { formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Button, Input, Modal } from "../common";

/** "" → no limit; a whole number ≥ 0 → that limit; anything else → invalid (null). */
function parseLimit(raw: string): number | undefined | null {
	const trimmed = raw.trim().replaceAll(",", "");
	if (trimmed === "") return undefined;
	if (!/^\d+$/.test(trimmed)) return null;
	const value = Number(trimmed);
	return Number.isSafeInteger(value) ? value : null;
}

export function PeerLimitsDialog({
	peer,
	onClose,
	onSave,
}: {
	peer: PeerView | null;
	onClose: () => void;
	onSave: (deviceId: string, limits: PeerLimits) => Promise<void>;
}) {
	const t = useT();
	// Mounted per device (keyed by the caller), so live usage updates never reset typing.
	const [requests, setRequests] = useState(peer?.limits.requestsPerDay?.toString() ?? "");
	const [tokens, setTokens] = useState(peer?.limits.tokensPerDay?.toString() ?? "");
	const [saving, setSaving] = useState(false);
	const requestsLimit = parseLimit(requests);
	const tokensLimit = parseLimit(tokens);
	const valid = requestsLimit !== null && tokensLimit !== null;
	const save = async () => {
		if (!peer || !valid) return;
		setSaving(true);
		try {
			await onSave(peer.deviceId, {
				...(requestsLimit !== undefined ? { requestsPerDay: requestsLimit } : {}),
				...(tokensLimit !== undefined ? { tokensPerDay: tokensLimit } : {}),
			});
			onClose();
		} finally {
			setSaving(false);
		}
	};
	return (
		<Modal
			description={t("remote.limits.desc")}
			footer={
				<>
					<Button onClick={onClose} variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button disabled={!valid} loading={saving} onClick={() => void save()} variant="primary">
						{t("common.save")}
					</Button>
				</>
			}
			onClose={onClose}
			open={peer !== null}
			title={peer ? t("remote.limits.title", { name: peer.name }) : ""}
		>
			<form
				className="flex flex-col gap-3"
				data-peer-limits
				onSubmit={event => {
					event.preventDefault();
					void save();
				}}
			>
				<Input
					error={requestsLimit === null ? t("remote.limits.invalid") : undefined}
					hint={t("remote.limits.requestsHint")}
					inputMode="numeric"
					label={t("remote.limits.requests")}
					onChange={event => setRequests(event.target.value)}
					placeholder={t("remote.limits.none")}
					value={requests}
				/>
				<Input
					error={tokensLimit === null ? t("remote.limits.invalid") : undefined}
					hint={t("remote.limits.tokensHint")}
					inputMode="numeric"
					label={t("remote.limits.tokens")}
					onChange={event => setTokens(event.target.value)}
					placeholder={t("remote.limits.none")}
					value={tokens}
				/>
				{peer && (
					<p className="text-sc-xs text-(--sc-text-muted)">
						{t("remote.limits.today", {
							requests: peer.usage.requests,
							tokens: formatTokens(peer.usage.tokens),
						})}
					</p>
				)}
				<button className="hidden" type="submit" />
			</form>
		</Modal>
	);
}

/** One line for the device row: today's use against its limits, or null when it has none and used nothing. */
export function peerUsageLine(
	peer: PeerView,
	t: (key: string, params?: Record<string, string | number>) => string,
): string | null {
	const { requestsPerDay, tokensPerDay } = peer.limits;
	if (requestsPerDay === undefined && tokensPerDay === undefined) {
		return peer.usage.requests > 0 || peer.usage.tokens > 0
			? t("remote.limits.today", { requests: peer.usage.requests, tokens: formatTokens(peer.usage.tokens) })
			: null;
	}
	return t("remote.limits.todayOf", {
		requests: peer.usage.requests,
		requestsLimit: requestsPerDay ?? "∞",
		tokens: formatTokens(peer.usage.tokens),
		tokensLimit: tokensPerDay === undefined ? "∞" : formatTokens(tokensPerDay),
	});
}

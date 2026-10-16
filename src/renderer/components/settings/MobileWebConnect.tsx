/**
 * Settings › Mobile web, once it is `ready`: the link, then the three steps that add a phone — Tailscale on the
 * phone (a QR link per store and the download page), the same account, and the pairing QR. "Pair a phone" asks
 * main for a single-use code (`pairing.newCode`) and shows it with its m:ss countdown and the QR of the page
 * that takes it (`webPairingUrl`: the code rides the URL fragment); an expired code is replaced on its own.
 */
import { ExternalLink, QrCode as QrIcon, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type MobileWebState, type WebPairingCode, webPairingUrl } from "../../../shared/mobile-web";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { toastError } from "../../stores/toast";
import { Button, CopyButton, Spinner } from "../common";
import { QrCode } from "../common/QrCode";
import { SettingsRow, SettingsSection } from "./SettingsLayout";
import { IosInstallSteps } from "./WebNotificationsSection";

const IOS_APP_URL = "https://apps.apple.com/app/tailscale/id1470499037";
const ANDROID_APP_URL = "https://play.google.com/store/apps/details?id=com.tailscale.ipn";
const DOWNLOAD_URL = "https://tailscale.com/download";

/** m:ss until `expiresAt`. */
function remaining(expiresAt: number, now: number): string {
	const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
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
			<CopyButton label={t("remote.copy", { value })} text={value} />
		</span>
	);
}

function StepNumber({ n }: { n: number }) {
	return (
		<span
			aria-hidden
			className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-(--sc-surface-3) text-sc-2xs font-semibold text-(--sc-text-secondary)"
		>
			{n}
		</span>
	);
}

/** A store's QR link: scan it from the phone, or click it here. */
function StoreLink({ label, qrTitle, url }: { label: string; qrTitle: string; url: string }) {
	return (
		<div className="flex flex-col items-center gap-1" data-mobile-web-store={url}>
			<QrCode size={88} title={qrTitle} value={url} />
			<Button
				icon={<ExternalLink />}
				onClick={() => void window.omp.system.openExternal(url)}
				size="sm"
				variant="ghost"
			>
				{label}
			</Button>
		</div>
	);
}

/** "Pair a phone": the code, its countdown and QR; replaced when it expires. */
function PairPhone({ url }: { url: string }) {
	const t = useT();
	const [code, setCode] = useState<WebPairingCode | null>(null);
	const [busy, setBusy] = useState(false);
	// Re-renders every second while a code counts down.
	useNowTick(code !== null);
	/** The expiry already handed to an automatic replacement, so a slow reply is not asked for twice. */
	const replacedFor = useRef<number | null>(null);

	const request = async () => {
		setBusy(true);
		try {
			setCode(await window.omp.mobileWeb.pairing.newCode());
		} catch (error) {
			toastError({ title: t("mobileWeb.pairFailed"), error });
		} finally {
			setBusy(false);
		}
	};

	useEffect(() => {
		if (!code || Date.now() < code.expiresAt || replacedFor.current === code.expiresAt) return;
		replacedFor.current = code.expiresAt;
		void request();
	});

	if (!code) {
		return (
			<Button
				data-mobile-web-pair
				icon={<QrIcon />}
				loading={busy}
				onClick={() => void request()}
				size="sm"
				variant="primary"
			>
				{t("mobileWeb.pair")}
			</Button>
		);
	}
	return (
		<div className="flex min-w-0 flex-wrap items-start gap-4" data-mobile-web-pairing>
			<QrCode title={t("mobileWeb.pairQr")} value={webPairingUrl(url, code.code)} />
			<div className="flex min-w-0 flex-1 basis-48 flex-col gap-2">
				<div className="flex flex-wrap items-center gap-3">
					<CopyableValue large value={code.code} />
					<span className="text-sc-sm text-(--sc-text-muted) tabular-nums" data-mobile-web-code-expiry>
						{t("remote.host.expiresIn", { time: remaining(code.expiresAt, Date.now()) })}
					</span>
				</div>
				<p className="text-sc-xs break-words break-keep text-(--sc-text-muted)">{t("mobileWeb.pairHint")}</p>
				<div>
					<Button
						data-mobile-web-pair
						icon={<RefreshCw />}
						loading={busy}
						onClick={() => void request()}
						size="sm"
						variant="secondary"
					>
						{t("remote.host.newCode")}
					</Button>
				</div>
			</div>
		</div>
	);
}

export function MobileWebConnect({ state, url }: { state: MobileWebState; url: string }) {
	const t = useT();
	return (
		<SettingsSection description={t("mobileWeb.linkDesc")} title={t("mobileWeb.connect.title")}>
			<SettingsRow id="settings-mobile-web-link" label={t("mobileWeb.link")}>
				<CopyableValue value={url} />
			</SettingsRow>
			<div className="settings-row py-2">
				<ol className="flex flex-col gap-4" data-mobile-web-steps>
					<li className="flex min-w-0 gap-2.5">
						<StepNumber n={1} />
						<div className="flex min-w-0 flex-1 flex-col gap-2">
							<p className="text-sc-md">{t("mobileWeb.step1")}</p>
							<div className="flex flex-wrap items-start gap-4">
								<StoreLink label={t("mobileWeb.step1Ios")} qrTitle={t("mobileWeb.qrIos")} url={IOS_APP_URL} />
								<StoreLink
									label={t("mobileWeb.step1Android")}
									qrTitle={t("mobileWeb.qrAndroid")}
									url={ANDROID_APP_URL}
								/>
							</div>
							<div>
								<Button
									icon={<ExternalLink />}
									onClick={() => void window.omp.system.openExternal(DOWNLOAD_URL)}
									size="sm"
									variant="ghost"
								>
									{t("mobileWeb.download")}
								</Button>
							</div>
						</div>
					</li>
					<li className="flex min-w-0 gap-2.5">
						<StepNumber n={2} />
						<div className="flex min-w-0 flex-1 flex-col gap-1">
							<p className="text-sc-md break-words">
								{state.user ? t("mobileWeb.step2", { user: state.user }) : t("mobileWeb.step2NoUser")}
							</p>
							{state.phones.length > 0 ? (
								<ul className="flex flex-col gap-0.5" data-mobile-web-phones>
									{state.phones.map(name => (
										<li className="text-sc-sm text-(--sc-success)" key={name}>
											{t("mobileWeb.phoneConnected", { name })}
										</li>
									))}
								</ul>
							) : (
								<Spinner label={t("mobileWeb.phoneWaiting")} size="sm" />
							)}
						</div>
					</li>
					<li className="flex min-w-0 gap-2.5">
						<StepNumber n={3} />
						<div className="flex min-w-0 flex-1 flex-col gap-2">
							<p className="text-sc-md">{t("mobileWeb.step3")}</p>
							<PairPhone key={url} url={url} />
						</div>
					</li>
					<li className="flex min-w-0 gap-2.5" data-mobile-web-ios-install>
						<StepNumber n={4} />
						<div className="flex min-w-0 flex-1 flex-col gap-2">
							<p className="text-sc-md">{t("mobileWeb.step4")}</p>
							<IosInstallSteps />
						</div>
					</li>
				</ol>
			</div>
		</SettingsSection>
	);
}

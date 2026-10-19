/**
 * Settings › Mobile web, once it is `ready`: the link with a big Copy button and one QR of it, then the short
 * steps that get a phone onto it — Tailscale on the phone (a QR link per store and the download page), the same
 * account, open the link. There is no pairing code: a device signed in to an allowed Tailscale account connects on
 * its first visit (the computer only hears of it afterwards, or asks first when that setting is on).
 */
import { Check, Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import type { MobileWebState } from "../../../shared/mobile-web";
import { copyText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { Button, Spinner } from "../common";
import { QrCode } from "../common/QrCode";
import { SettingsSection } from "./SettingsLayout";
import { IosInstallSteps } from "./WebNotificationsSection";

const IOS_APP_URL = "https://apps.apple.com/app/tailscale/id1470499037";
const ANDROID_APP_URL = "https://play.google.com/store/apps/details?id=com.tailscale.ipn";
const DOWNLOAD_URL = "https://tailscale.com/download";
/** How long the button reads "Copied" before it goes back to "Copy link". */
const COPIED_MS = 1500;

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
			<QrCode size={72} title={qrTitle} value={url} />
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

/** The big Copy button: the label turns into "Copied" for a moment; a refused clipboard is a toast. */
function CopyLinkButton({ url }: { url: string }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
		return () => window.clearTimeout(timer);
	}, [copied]);
	return (
		<>
			<Button
				data-copied={copied || undefined}
				data-mobile-web-copy
				icon={copied ? <Check /> : <Copy />}
				onClick={() => {
					void copyText(url).then(ok => {
						if (ok) setCopied(true);
						else toast({ variant: "error", message: t("common.copyFailed") });
					});
				}}
				size="lg"
				variant="primary"
			>
				{copied ? t("mobileWeb.linkCopied") : t("mobileWeb.copyLink")}
			</Button>
			<span aria-live="polite" className="sr-only" role="status">
				{copied ? t("common.copied") : ""}
			</span>
		</>
	);
}

export function MobileWebConnect({ state, url }: { state: MobileWebState; url: string }) {
	const t = useT();
	return (
		<SettingsSection title={t("mobileWeb.connect.title")}>
			<div className="settings-row flex min-w-0 flex-wrap items-center gap-4 py-3" data-mobile-web-link>
				<div className="flex min-w-0 flex-1 basis-56 flex-col gap-3">
					<span
						className="min-w-0 font-mono text-sc-lg break-all text-(--sc-text) select-all"
						data-copyable={url}
						id="settings-mobile-web-link"
					>
						{url}
					</span>
					<div>
						<CopyLinkButton url={url} />
					</div>
				</div>
				<QrCode size={132} title={t("mobileWeb.qr")} value={url} />
			</div>
			<div className="settings-row py-2">
				<ol className="flex flex-col gap-3" data-mobile-web-steps>
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
						<p className="min-w-0 flex-1 text-sc-md break-words">{t("mobileWeb.step3")}</p>
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

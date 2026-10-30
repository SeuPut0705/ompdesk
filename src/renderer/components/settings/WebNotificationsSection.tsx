/**
 * Settings › Mobile web on the web page itself (a paired phone or tablet): this device's notifications and
 * how to install the page as an app. The pairing, Tailscale and the device list are the computer's; here the
 * device only manages its own Web Push subscription — turn it on (the permission prompt needs this click),
 * hide the content, pick the categories, turn it off — and sees why push cannot work when it cannot (denied,
 * unsupported, not HTTPS, iOS in a Safari tab). On iOS push exists only for a page on the Home Screen, so the
 * Add to Home Screen steps show there; Chromium offers its own install prompt; Samsung Internet and Firefox get their menu steps.
 */
import { Download } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { WEB_PUSH_CATEGORIES, type WebPushCategory } from "../../../shared/web-push";
import { useT } from "../../lib/i18n";
import { toastError } from "../../stores/toast";
import { installStepKeys } from "../../web/install";
import { useInstallGuidance } from "../../web/install-ui";
import type { PushAvailability, PushViewState } from "../../web/push-client";
import type { WebPwa } from "../../web/pwa";
import { Banner, Button, SkeletonRows } from "../common";
import { SettingsRow, SettingsSection, SettingsSwitchRow } from "./SettingsLayout";

const UNAVAILABLE_KEY: Record<Exclude<PushAvailability, "ready" | "needs-install">, string> = {
	insecure: "web.push.insecure",
	unsupported: "web.push.unsupported",
	"host-off": "web.push.hostOff",
};

const CATEGORY_KEY: Record<WebPushCategory, string> = {
	completion: "web.push.category.completion",
	error: "web.push.category.error",
	ask: "web.push.category.ask",
};

/** Share › Add to Home Screen, for iOS and iPadOS. */
export function IosInstallSteps() {
	const t = useT();
	return (
		<ol
			className="flex list-decimal flex-col gap-1 ps-5 text-sc-sm text-(--sc-text-secondary)"
			data-web-install-steps
		>
			<li>{t("web.install.ios1")}</li>
			<li>{t("web.install.ios2")}</li>
			<li>{t("web.install.ios3")}</li>
		</ol>
	);
}

function InstallSection({ pwa }: { pwa: WebPwa }) {
	const t = useT();
	const guidance = useInstallGuidance(pwa);
	const [busy, setBusy] = useState(false);
	if (guidance === "none") return null;
	const steps = installStepKeys(guidance);
	return (
		<SettingsSection title={t("web.install.title")}>
			<div data-web-install={guidance}>
				{guidance === "installed" && <SettingsRow id="settings-web-install" label={t("web.install.installed")} />}
				{guidance === "ios-share" && (
					<SettingsRow id="settings-web-install" label={t("web.install.iosTitle")}>
						<IosInstallSteps />
					</SettingsRow>
				)}
				{(guidance === "samsung-menu" || guidance === "firefox-menu") && (
					<SettingsRow id="settings-web-install" label={t("web.install.menu")}>
						<ol
							className="flex list-decimal flex-col gap-1 ps-5 text-sc-sm text-(--sc-text-secondary)"
							data-web-install-steps
						>
							{steps.map(key => (
								<li key={key}>{t(key)}</li>
							))}
						</ol>
					</SettingsRow>
				)}
				{guidance === "prompt" && (
					<SettingsRow
						compactControl
						control={
							<Button
								icon={<Download />}
								loading={busy}
								onClick={() => {
									setBusy(true);
									void pwa.install.install().finally(() => setBusy(false));
								}}
								size="sm"
							>
								{t("web.install.menu")}
							</Button>
						}
						id="settings-web-install"
						label={t("web.install.androidTitle")}
					/>
				)}
			</div>
		</SettingsSection>
	);
}

function NotificationsSection({ pwa }: { pwa: WebPwa }) {
	const t = useT();
	const view: PushViewState = useSyncExternalStore(
		listener => pwa.push.onChange(listener),
		() => pwa.push.state,
	);
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let cancelled = false;
		pwa.push
			.load()
			.catch(error => toastError({ title: t("web.push.loadFailed"), error }))
			.finally(() => {
				if (!cancelled) setLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, [pwa, t]);

	const run = (action: () => Promise<unknown>) => {
		setBusy(true);
		void action()
			.catch(error => toastError({ title: t("web.push.failed"), error }))
			.finally(() => setBusy(false));
	};

	if (view.availability === "needs-install") {
		return (
			<SettingsSection title={t("web.push.title")}>
				<div data-web-push-state="needs-install">
					<Banner variant="info">{t("web.push.needsInstall")}</Banner>
				</div>
			</SettingsSection>
		);
	}
	if (view.availability !== "ready") {
		return (
			<SettingsSection title={t("web.push.title")}>
				<div data-web-push-state={view.availability}>
					<Banner variant="info">{t(UNAVAILABLE_KEY[view.availability])}</Banner>
				</div>
			</SettingsSection>
		);
	}
	if (!loaded) {
		return (
			<SettingsSection title={t("web.push.title")}>
				<SkeletonRows className="py-2" label={t("common.loading")} widths={[60, 44, 70, 52]} />
			</SettingsSection>
		);
	}
	const denied = view.permission === "denied";
	return (
		<SettingsSection title={t("web.push.title")}>
			<div data-web-push-state={view.subscribed ? "on" : denied ? "denied" : "off"}>
				{denied && (
					<Banner variant="warning">
						<span data-web-push-denied>{t("web.push.denied")}</span>
					</Banner>
				)}
				<SettingsRow
					compactControl
					control={
						view.subscribed ? (
							<Button
								data-web-push-disable
								loading={busy}
								onClick={() => run(() => pwa.push.disable())}
								size="sm"
								variant="secondary"
							>
								{t("web.push.disable")}
							</Button>
						) : (
							<Button
								data-web-push-enable
								disabled={denied}
								loading={busy}
								// The permission prompt must start from this click: `enable()` asks before it awaits anything.
								onClick={() => run(() => pwa.push.enable())}
								size="sm"
							>
								{t("web.push.enable")}
							</Button>
						)
					}
					id="settings-web-push"
					label={view.subscribed ? t("web.push.on") : t("web.push.off")}
				/>
				{view.subscribed && (
					<>
						<SettingsSwitchRow
							checked={view.hideContent}
							description={t("web.push.hideContentDesc")}
							tipOnly
							disabled={busy}
							id="settings-web-push-hide"
							label={t("web.push.hideContent")}
							onCheckedChange={hideContent => run(() => pwa.push.configure({ hideContent }))}
						/>
						{WEB_PUSH_CATEGORIES.map(category => (
							<SettingsSwitchRow
								checked={view.categories.includes(category)}
								disabled={busy}
								id={`settings-web-push-${category}`}
								key={category}
								label={t(CATEGORY_KEY[category])}
								onCheckedChange={on =>
									run(() =>
										pwa.push.configure({
											categories: WEB_PUSH_CATEGORIES.filter(item =>
												item === category ? on : view.categories.includes(item),
											),
										}),
									)
								}
							/>
						))}
					</>
				)}
			</div>
		</SettingsSection>
	);
}

/** The device's own notification and install controls (the web page's Settings › Mobile web). */
export function WebNotificationsSection({ pwa }: { pwa: WebPwa }) {
	return (
		<div data-web-device-section>
			<NotificationsSection pwa={pwa} />
			<InstallSection pwa={pwa} />
		</div>
	);
}

/**
 * GitHub sign-in without a terminal (main: src/main/github-auth/): the GitHub
 * CLI's status, a device-code sign-in (copy the code, open GitHub, wait for the
 * approval), sign-out, switching between signed-in accounts, and the git commit
 * identity filled from the account where it was empty. One component for the
 * first-run step, Settings › General and the PR center's signed-out state.
 */

import { ExternalLink, Github, LogOut, RefreshCw, Users } from "lucide-react";
import { useEffect, useRef } from "react";
import type { GithubAuthState, GithubLoginFlow } from "../../../shared/github-auth";
import { copyText, cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useGithubAuthStore } from "../../stores/github-auth";
import { Badge, Button, CopyButton, InlineNotice, MenuButton, Spinner } from "../common";

const GH_DOWNLOAD_URL = "https://cli.github.com";

/** The shared store, subscribed and checked once the first caller mounts. */
export function useGithubAuth(): GithubAuthState {
	const state = useGithubAuthStore(store => store.state);
	useEffect(() => void useGithubAuthStore.getState().refresh(), []);
	return state;
}

function CodeStep({ flow }: { flow: Extract<GithubLoginFlow, { state: "code" }> }) {
	const t = useT();
	const run = useGithubAuthStore(store => store.run);
	const openGithub = async () => {
		// The code goes to the clipboard first, so it is ready to paste when the page opens.
		await copyText(flow.code);
		void window.omp.system.openExternal(flow.url);
		await run(api => api.openLogin(), t("githubAuth.actionFailed"));
	};
	return (
		<div className="mt-3 flex min-w-0 flex-col gap-3" data-testid="github-device-code">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-sc-sm text-(--sc-text-muted)">{t("githubAuth.code.label")}</span>
				<code className="rounded-(--sc-radius-sm) border border-(--sc-border-subtle) px-2 py-0.5 font-mono text-sc-xl font-semibold tracking-widest text-(--sc-text) select-all">
					{flow.code}
				</code>
				<CopyButton label={t("githubAuth.code.copy")} text={flow.code} />
			</div>
			<p className="text-sc-sm break-keep text-(--sc-text-secondary)">{t("githubAuth.code.instructions")}</p>
			{flow.opened && <InlineNotice live title={t("githubAuth.code.waiting")} tone="pending" />}
			<div className="flex flex-wrap items-center gap-2">
				{flow.opened ? (
					<Button
						icon={<ExternalLink />}
						onClick={() => void window.omp.system.openExternal(flow.url)}
						size="sm"
						variant="secondary"
					>
						{t("githubAuth.code.reopen")}
					</Button>
				) : (
					<Button
						data-testid="github-open"
						icon={<ExternalLink />}
						onClick={() => void openGithub()}
						size="sm"
						variant="primary"
					>
						{t("githubAuth.code.open")}
					</Button>
				)}
				<Button
					onClick={() => void run(api => api.cancelLogin(), t("githubAuth.actionFailed"))}
					size="sm"
					variant="ghost"
				>
					{t("common.cancel")}
				</Button>
			</div>
		</div>
	);
}

export interface GithubSignInProps {
	/** Draw the card's own hairline frame (first run, PR center); Settings rows have none. */
	framed?: boolean;
	/** Called once whenever the active account becomes signed in while mounted. */
	onSignedIn?: () => void;
	className?: string;
}

export function GithubSignIn({ framed = true, onSignedIn, className }: GithubSignInProps) {
	const t = useT();
	const state = useGithubAuth();
	const run = useGithubAuthStore(store => store.run);
	const { status, flow, identity, busy, error } = state;
	const authenticated = status?.authenticated === true;
	const signedInRef = useRef(authenticated);
	useEffect(() => {
		if (authenticated && !signedInRef.current) onSignedIn?.();
		signedInRef.current = authenticated;
	}, [authenticated, onSignedIn]);

	const failed = t("githubAuth.actionFailed");
	const startLogin = () => void run(api => api.startLogin(), failed);
	const live = flow?.state === "starting" || flow?.state === "code";
	const phase =
		status === null ? "checking" : !status.installed ? "missing" : authenticated ? "signed-in" : "signed-out";

	let badge: { variant: "success" | "muted" | "warning"; label: string } | null = null;
	if (phase === "signed-in") badge = { variant: "success", label: t("githubAuth.badge.signedIn") };
	else if (phase === "signed-out") badge = { variant: "muted", label: t("githubAuth.badge.signedOut") };
	else if (phase === "missing") badge = { variant: "warning", label: t("githubAuth.badge.missing") };

	const switchItems = [
		...(status?.otherAccounts ?? []).map(login => ({
			id: `account-${login}`,
			label: login,
			onSelect: () => void run(api => api.switchAccount(login), failed),
		})),
		{
			id: "another",
			label: t("githubAuth.switch.other"),
			separatorBefore: (status?.otherAccounts.length ?? 0) > 0,
			onSelect: startLogin,
		},
	];

	return (
		<div
			className={cx(
				"min-w-0",
				framed && "rounded-(--sc-radius-lg) border border-(--sc-border-subtle) px-4 py-3",
				className,
			)}
			data-github-phase={live ? "login" : phase}
			data-testid="github-sign-in"
		>
			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
				<Github aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-text)" />
				<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
					<span className="truncate text-sc-md font-medium text-(--sc-text)">
						{authenticated && status?.login ? status.login : t("githubAuth.connect")}
					</span>
					{badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
					{status?.version && (
						<Badge variant="muted">{t("githubAuth.version", { version: status.version })}</Badge>
					)}
				</div>
				{phase === "signed-in" && !live && (
					<div className="flex flex-wrap items-center gap-2">
						<MenuButton
							align="end"
							disabled={busy !== null}
							icon={<Users />}
							items={switchItems}
							label={t("githubAuth.switch")}
							size="sm"
							variant="secondary"
						>
							{t("githubAuth.switch")}
						</MenuButton>
						<Button
							icon={<LogOut />}
							loading={busy === "logout"}
							onClick={() => void run(api => api.logout(), failed)}
							data-testid="github-sign-out"
							size="sm"
							variant="secondary"
						>
							{t("githubAuth.signOut")}
						</Button>
					</div>
				)}
			</div>

			{phase === "checking" && <InlineNotice title={t("githubAuth.checking")} tone="pending" />}

			{phase === "missing" && (
				<InlineNotice
					action={
						<>
							<Button
								icon={<ExternalLink />}
								onClick={() => void window.omp.system.openExternal(GH_DOWNLOAD_URL)}
								size="sm"
								variant="ghost"
							>
								{t("githubAuth.missing.download")}
							</Button>
							<Button
								icon={<RefreshCw />}
								loading={state.checking}
								onClick={() => void useGithubAuthStore.getState().refresh(true)}
								size="sm"
								variant="ghost"
							>
								{t("githubAuth.recheck")}
							</Button>
						</>
					}
					title={t("githubAuth.missing.title")}
					tone="info"
				/>
			)}

			{flow?.state === "starting" && (
				<div className="mt-3 flex flex-wrap items-center gap-3">
					<Spinner label={t("githubAuth.starting")} size="sm" />
					<Button onClick={() => void run(api => api.cancelLogin(), failed)} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
				</div>
			)}
			{flow?.state === "code" && <CodeStep flow={flow} />}

			{phase === "signed-out" && !live && (
				<div className="mt-2 flex min-w-0 flex-col gap-3">
					<p className="text-sc-sm break-keep text-(--sc-text-secondary)">
						{t("githubAuth.signedOut.description")}
					</p>
					{flow?.state === "failed" && (
						<InlineNotice detail={flow.detail} live title={t(`githubAuth.failed.${flow.reason}`)} tone="danger" />
					)}
					<div>
						<Button
							data-testid="github-sign-in-start"
							icon={<Github />}
							onClick={startLogin}
							size="sm"
							variant="primary"
						>
							{flow?.state === "failed" ? t("common.retry") : t("githubAuth.signIn")}
						</Button>
					</div>
				</div>
			)}

			{phase === "signed-in" && !live && (
				<div className="mt-2 flex min-w-0 flex-col gap-2">
					{flow?.state === "failed" && (
						<InlineNotice detail={flow.detail} title={t(`githubAuth.failed.${flow.reason}`)} tone="danger" />
					)}
					{identity?.name && identity.email ? (
						<p className="text-sc-sm break-words text-(--sc-text-secondary)" data-testid="github-identity">
							{t("githubAuth.identity.commitsAs", { name: identity.name, email: identity.email })}
							{state.identityFilled.length > 0 && (
								<span className="text-(--sc-text-muted)"> · {t("githubAuth.identity.filled")}</span>
							)}
						</p>
					) : (
						identity !== null && (
							<InlineNotice
								action={
									<Button
										loading={busy === "identity"}
										onClick={() => void run(api => api.fillIdentity(), failed)}
										size="sm"
										variant="secondary"
									>
										{t("githubAuth.identity.fill")}
									</Button>
								}
								title={t("githubAuth.identity.missing")}
								tone="warning"
							/>
						)
					)}
				</div>
			)}

			{error && (
				<InlineNotice detail={error.message} live title={t(`githubAuth.error.${error.action}`)} tone="danger" />
			)}
		</div>
	);
}

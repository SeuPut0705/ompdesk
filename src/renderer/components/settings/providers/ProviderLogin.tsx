/**
 * Inline provider sign-in. omp's `login` RPC drives every flow (OAuth in the
 * browser, API key paste, device code) through `open_url` and `input`
 * extension requests; while a sign-in started here is in flight those
 * requests render inside the provider row instead of as a global dialog
 * (`inlineLogin` in the extension-ui store). The key/code field is masked.
 *
 * On a tab that runs on a paired host, omp and its OAuth callback server run
 * there while the browser opens here: the link is the provider's own URL
 * (never the host's `localhost/launch`), and the panel tells the user to
 * paste the address the browser ends on — stock omp asks for exactly that
 * ("Paste the authorization code (or full redirect URL)") alongside its
 * callback server, so the code reaches the host through the paste.
 */

import { ExternalLink, Eye, EyeOff } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useExtensionUiResponder } from "../../../hooks/use-extension-ui";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { openUrlTarget, useExtensionUiStore } from "../../../stores/extension-ui";
import { useFocusedHost, useFocusedTabDevice } from "../../../stores/remote";
import { Banner, Button, IconButton, Input, Spinner } from "../../common";

interface LoginPrompt {
	id: string;
	title: string;
	placeholder?: string;
}

export interface ProviderLoginState {
	/** Provider whose sign-in is in flight, or whose last attempt failed. */
	providerId: string | null;
	running: boolean;
	/** Sign-in or key page omp asked to open. `oauth`: a browser sign-in with a callback server (it sent a `launchUrl`). */
	link: { url: string; instructions?: string; oauth: boolean } | null;
	/** omp is waiting for a pasted key / code. */
	prompt: LoginPrompt | null;
	error: string | null;
}

const IDLE: ProviderLoginState = { providerId: null, running: false, link: null, prompt: null, error: null };

export interface ProviderLogin {
	state: ProviderLoginState;
	start: (providerId: string) => Promise<boolean>;
	submit: (value: string) => void;
	cancel: () => void;
}

/** Run `login` for one provider at a time and answer its prompts inline. */
export function useProviderLogin(onConnected: (providerId: string) => Promise<void> | void): ProviderLogin {
	const tabRpc = useTabRpc();
	const sendResponse = useExtensionUiResponder();
	const pending = useExtensionUiStore(state => state.pendingRequests);
	const removeRequest = useExtensionUiStore(state => state.removeRequest);
	const setInlineLogin = useExtensionUiStore(state => state.setInlineLogin);
	const remote = useFocusedTabDevice() !== undefined;
	const [state, setState] = useState<ProviderLoginState>(IDLE);
	const attempt = useRef(0);
	const promptRef = useRef<LoginPrompt | null>(null);
	promptRef.current = state.prompt;

	const respond = useCallback(
		(id: string, response: { value: string } | { cancelled: true }) => {
			sendResponse({ type: "extension_ui_response", id, ...response });
			removeRequest(id);
		},
		[removeRequest, sendResponse],
	);

	useEffect(() => {
		if (!state.running) return;
		for (const request of pending) {
			if (request.method === "open_url") {
				// omp never waits on this answer; acknowledge it so the next
				// request (the key prompt) is not queued behind it.
				setState(prev => ({
					...prev,
					link: {
						url: openUrlTarget(request, remote),
						instructions: request.instructions,
						oauth: request.launchUrl !== undefined,
					},
				}));
				respond(request.id, { value: "done" });
			} else if (request.method === "input" && promptRef.current?.id !== request.id) {
				setState(prev => ({
					...prev,
					prompt: { id: request.id, title: request.title, placeholder: request.placeholder },
				}));
			}
		}
	}, [pending, remote, respond, state.running]);

	const finish = useCallback(() => {
		setInlineLogin(false);
	}, [setInlineLogin]);

	useEffect(() => finish, [finish]);

	const start = useCallback(
		async (providerId: string): Promise<boolean> => {
			const current = ++attempt.current;
			setInlineLogin(true);
			setState({ ...IDLE, providerId, running: true });
			try {
				const response = await tabRpc.login(providerId);
				if (current !== attempt.current) return false;
				if (!response.success) {
					setState({ ...IDLE, providerId, error: response.error ?? null });
					return false;
				}
				setState(IDLE);
				await onConnected(providerId);
				return true;
			} catch (cause) {
				if (current === attempt.current) {
					setState({ ...IDLE, providerId, error: cause instanceof Error ? cause.message : String(cause) });
				}
				return false;
			} finally {
				if (current === attempt.current) finish();
			}
		},
		[finish, onConnected, setInlineLogin, tabRpc],
	);

	const submit = useCallback(
		(value: string) => {
			const prompt = promptRef.current;
			if (!prompt) return;
			respond(prompt.id, { value });
			setState(prev => ({ ...prev, prompt: null }));
		},
		[respond],
	);

	const cancel = useCallback(() => {
		attempt.current++;
		const prompt = promptRef.current;
		if (prompt) respond(prompt.id, { cancelled: true });
		setState(IDLE);
		finish();
	}, [finish, respond]);

	return { state, start, submit, cancel };
}

/** Inline body under a provider row while its sign-in runs or after it failed. */
export function ProviderLoginPanel({
	providerName,
	login,
	onRetry,
}: {
	providerName: string;
	login: ProviderLogin;
	onRetry: () => void;
}) {
	const t = useT();
	const { state } = login;
	const host = useFocusedHost();
	const [value, setValue] = useState("");
	const [reveal, setReveal] = useState(false);
	const promptId = state.prompt?.id;

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new prompt starts empty and masked.
	useEffect(() => {
		setValue("");
		setReveal(false);
	}, [promptId]);

	if (!state.running && state.error) {
		return (
			<Banner
				actions={
					<>
						<Button onClick={onRetry} size="sm" variant="secondary">
							{t("providerList.login.retry")}
						</Button>
						<Button onClick={login.cancel} size="sm" variant="ghost">
							{t("common.close")}
						</Button>
					</>
				}
				live
				title={t("providerList.login.failed", { provider: providerName })}
				variant="danger"
			>
				{state.error}
			</Banner>
		);
	}

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (value.trim()) login.submit(value);
	};
	// An OAuth sign-in also asks for the pasted code/redirect beside its callback
	// server; only a link without one is a page to copy a key from.
	const keyPage = state.prompt !== null && state.link?.oauth === false;

	return (
		<div className="flex flex-col gap-3 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-surface-1) p-3">
			{state.link && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<p className="min-w-0 flex-1 text-sc-sm text-(--sc-text-secondary)">
						{state.link.instructions ||
							t(keyPage ? "providerList.login.keyPage" : "providerList.login.browser", {
								provider: providerName,
							})}
					</p>
					<Button
						icon={<ExternalLink />}
						onClick={() => {
							if (state.link) void window.omp.system.openExternal(state.link.url);
						}}
						size="sm"
						variant={keyPage ? "secondary" : "primary"}
					>
						{keyPage ? t("providerList.login.openKeyPage") : t("providerList.login.openBrowser")}
					</Button>
				</div>
			)}
			{state.link && host && (
				<p className="text-sc-xs break-keep text-(--sc-text-muted)" data-remote-login-hint="true">
					{t("providerList.login.remoteHint", { name: host.name ?? t("remote.tab.unknownDevice") })}
				</p>
			)}
			{state.prompt ? (
				<form className="flex items-end gap-2" onSubmit={submit}>
					<div className="min-w-0 flex-1">
						<Input
							autoComplete="off"
							autoFocus
							label={state.prompt.title}
							mono
							onChange={event => setValue(event.target.value)}
							placeholder={state.prompt.placeholder}
							spellCheck={false}
							trailing={
								<IconButton
									icon={reveal ? <EyeOff /> : <Eye />}
									label={reveal ? t("providerList.login.hide") : t("providerList.login.show")}
									onClick={() => setReveal(prev => !prev)}
									size="sm"
								/>
							}
							type={reveal ? "text" : "password"}
							value={value}
						/>
					</div>
					<Button disabled={!value.trim()} type="submit" variant="primary">
						{t("providerList.login.submit")}
					</Button>
					<Button onClick={login.cancel} variant="ghost">
						{t("common.cancel")}
					</Button>
				</form>
			) : (
				<div className="flex items-center gap-2 text-sc-sm text-(--sc-text-muted)" role="status">
					<Spinner size="sm" />
					<span className="min-w-0 flex-1">
						{state.link ? t("providerList.login.waiting") : t("providerList.login.starting")}
					</span>
					<Button onClick={login.cancel} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
				</div>
			)}
		</div>
	);
}

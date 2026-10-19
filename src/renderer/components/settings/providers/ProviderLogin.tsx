/**
 * Inline provider sign-in. omp's `login` RPC drives every flow (OAuth in the
 * browser, API key paste, device code) through `open_url`, `input` and info
 * `notify` extension requests; the ones that arrive while a sign-in started
 * here is in flight belong to it (`loginRequestIds` in the extension-ui store)
 * and render in the provider row, never as a chat card. The key/code field is
 * masked.
 *
 * A browser sign-in (stock's callback-server flows, e.g. Claude and ChatGPT)
 * finishes on its own once the browser reaches omp's loopback callback. Stock
 * still races a code paste against that callback ("Paste the authorization
 * code (or full redirect URL)", callback-server.ts `#waitForCallback`) and
 * never closes it, so the panel keeps waiting for the browser first, offers
 * the paste as a secondary fallback, and answers the leftover request once
 * `login` returns. An empty answer before that would only make stock ask again.
 * A browser sign-in this page starts on a local tab opens the browser by itself; a
 * device code, a key page, a resumed sign-in and a paired host's tab leave it to the button.
 *
 * On a tab that runs on a paired host, omp and its OAuth callback server run
 * there while the browser opens here: the link is the provider's own URL
 * (never the host's `localhost/launch`) and the paste is how the code reaches
 * the host, so the fallback starts open.
 */

import { ChevronDown, ExternalLink, Eye, EyeOff } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ExtensionUIRequest } from "../../../../shared/rpc-types";
import { useExtensionUiResponder } from "../../../hooks/use-extension-ui";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { openUrlTarget, useExtensionUiStore } from "../../../stores/extension-ui";
import { useFocusedHost, useFocusedTabDevice } from "../../../stores/remote";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { tabReady } from "../../../stores/tab-ready-gate";
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
	/** When this sign-in sent `login`: only requests that arrived since are its own. */
	since: number;
	/**
	 * Sign-in or key page omp asked to open. `target` is what the button opens,
	 * `url` stock's authorization URL. `oauth`: a browser sign-in with a
	 * callback server (it sent a `launchUrl`).
	 */
	link: { target: string; url: string; instructions?: string; oauth: boolean } | null;
	/** omp is waiting for a pasted key / code. */
	prompt: LoginPrompt | null;
	/** Stock's latest progress line for this sign-in (`onProgress`, an info `notify`). */
	progress: string | null;
	error: string | null;
	/** This page took the sign-in over from main after a reload (`adoptedLogin`), so it shows no step yet. */
	resumed: boolean;
}

const IDLE: ProviderLoginState = {
	providerId: null,
	running: false,
	since: 0,
	link: null,
	prompt: null,
	progress: null,
	error: null,
	resumed: false,
};

/** Stock's progress lines for a browser sign-in (callback-server.ts `login`, openai-codex.ts), in the UI language. */
const STOCK_PROGRESS: Record<string, string> = {
	"Waiting for browser authentication...": "providerList.login.waiting",
	"Exchanging authorization code for tokens...": "providerList.login.exchanging",
	"Exchanging authorization code for tokens…": "providerList.login.exchanging",
};

/** The browser page an `open_url` request asks to open, as the panel keeps it. */
function loginLink(
	request: Extract<ExtensionUIRequest, { method: "open_url" }>,
	remote: boolean,
): NonNullable<ProviderLoginState["link"]> {
	return {
		target: openUrlTarget(request, remote),
		url: request.url,
		instructions: request.instructions,
		oauth: request.launchUrl !== undefined,
	};
}

export interface ProviderLogin {
	state: ProviderLoginState;
	start: (providerId: string) => Promise<boolean>;
	submit: (value: string) => void;
	cancel: () => void;
}

/** Run `login` for one provider at a time and answer its prompts inline. */
export function useProviderLogin(onConnected: (providerId: string) => Promise<void> | void): ProviderLogin {
	const tabRpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const sendResponse = useExtensionUiResponder();
	const pending = useExtensionUiStore(state => state.pendingRequests);
	const arrivedAt = useExtensionUiStore(state => state.arrivedAt);
	const owned = useExtensionUiStore(state => state.loginRequestIds);
	const removeRequest = useExtensionUiStore(state => state.removeRequest);
	const beginInlineLogin = useExtensionUiStore(state => state.beginInlineLogin);
	const endInlineLogin = useExtensionUiStore(state => state.endInlineLogin);
	const adopted = useExtensionUiStore(state => state.adoptedLogin);
	const hideAdoptedLogin = useExtensionUiStore(state => state.hideAdoptedLogin);
	const dismissAdoptedLogin = useExtensionUiStore(state => state.dismissAdoptedLogin);
	const remote = useFocusedTabDevice() !== undefined;
	const [state, setState] = useState<ProviderLoginState>(IDLE);
	const attempt = useRef(0);
	const adoptedShown = useRef(false);
	const stateRef = useRef(state);
	stateRef.current = state;

	// A prompt's card stays until main handed the answer on (a paired host's tab with its link down refuses it).
	const respond = useCallback(
		async (id: string, response: { value: string } | { cancelled: true }): Promise<boolean> => {
			const delivered = await sendResponse({ type: "extension_ui_response", id, ...response });
			if (delivered) removeRequest(id);
			return delivered;
		},
		[removeRequest, sendResponse],
	);

	useEffect(() => {
		if (!state.running) return;
		for (const request of pending) {
			if (!Object.hasOwn(owned, request.id) || (arrivedAt[request.id] ?? 0) < state.since) continue;
			if (request.method === "open_url") {
				const link = loginLink(request, remote);
				setState(prev => ({ ...prev, link }));
				// A browser sign-in this page started on this computer opens by itself; the panel's button reopens it.
				if (link.oauth && !remote && !state.resumed && state.since > 0)
					void window.omp.system.openExternal(link.target);
				// omp never waits on this answer; acknowledge it all the same.
				void sendResponse({ type: "extension_ui_response", id: request.id, value: "done" });
				removeRequest(request.id);
			} else if (request.method === "input" && stateRef.current.prompt?.id !== request.id) {
				setState(prev => ({
					...prev,
					prompt: { id: request.id, title: request.title, placeholder: request.placeholder },
				}));
			} else if (request.method === "notify") {
				setState(prev => ({ ...prev, progress: request.message }));
				removeRequest(request.id);
			}
		}
	}, [arrivedAt, owned, pending, remote, removeRequest, sendResponse, state.resumed, state.running, state.since]);

	// A sign-in main still runs for this tab that this page did not start (it reloaded, or the link to a
	// paired host came back): show it again, with the paste fallback and Cancel, until main answers `login`.
	useEffect(() => {
		if (!adopted) return;
		if (adopted.ended) {
			dismissAdoptedLogin();
			if (!adoptedShown.current) return;
			adoptedShown.current = false;
			if (adopted.ended.error) setState({ ...IDLE, providerId: adopted.providerId, error: adopted.ended.error });
			else {
				setState(IDLE);
				if (adopted.ended.error === null) void onConnected(adopted.providerId);
			}
			return;
		}
		const link = adopted.link ? loginLink(adopted.link, remote) : null;
		if (adoptedShown.current) {
			if (link) setState(prev => (prev.link ? prev : { ...prev, link }));
		} else if (!adopted.hidden && !stateRef.current.running) {
			adoptedShown.current = true;
			setState({ ...IDLE, providerId: adopted.providerId, running: true, resumed: true, since: 0, link });
		}
	}, [adopted, dismissAdoptedLogin, onConnected, remote]);

	const start = useCallback(
		async (providerId: string): Promise<boolean> => {
			const current = ++attempt.current;
			beginInlineLogin();
			setState({ ...IDLE, providerId, running: true, since: Date.now() });
			// A starting omp would get `login` the moment it is ready (tab-runtime holds it), after a Cancel that had
			// nothing to cancel yet: wait here instead, and send nothing for an attempt that was cancelled meanwhile.
			const starting = tabId === null ? null : tabReady(tabId);
			if (starting) {
				await starting;
				if (current !== attempt.current) {
					endInlineLogin();
					return false;
				}
			}
			let outcome: { ok: true } | { ok: false; error: string | null };
			try {
				const response = await tabRpc.login(providerId);
				outcome = response.success ? { ok: true } : { ok: false, error: response.error ?? null };
			} catch (cause) {
				outcome = { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
			}
			// `login` is over, so whatever it left open is answered now: the code
			// paste stock raced against the callback stays pending until then.
			for (const request of endInlineLogin()) {
				if (request.method === "input")
					void sendResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
			}
			const live = current === attempt.current;
			if (!outcome.ok) {
				// A cancelled or superseded sign-in fails quietly.
				if (live) setState({ ...IDLE, providerId, error: outcome.error });
				return false;
			}
			// Connected even when the user cancelled a moment too late: the account is stored.
			if (live) setState(IDLE);
			await onConnected(providerId);
			return live;
		},
		[beginInlineLogin, endInlineLogin, onConnected, sendResponse, tabId, tabRpc],
	);

	const submit = useCallback(
		(value: string) => {
			const prompt = stateRef.current.prompt;
			if (!prompt) return;
			// The prompt stays open when the answer was refused, so it can be sent again.
			void respond(prompt.id, { value }).then(delivered => {
				if (delivered) setState(prev => ({ ...prev, prompt: null }));
			});
		},
		[respond],
	);

	const cancel = useCallback(() => {
		attempt.current++;
		const { link, prompt } = stateRef.current;
		if (link?.oauth) {
			// Stock's RPC `login` takes no cancel and re-asks an empty paste, while it
			// holds omp's command queue; its callback's denial ends it at once.
			void tabRpc.cancelLogin(link.url);
		} else if (prompt) {
			void respond(prompt.id, { cancelled: true });
		}
		// A sign-in taken over after a reload stays counted until main answers `login`, but is no longer shown.
		if (adoptedShown.current) {
			adoptedShown.current = false;
			hideAdoptedLogin();
		}
		setState(IDLE);
	}, [hideAdoptedLogin, respond, tabRpc]);

	return { state, start, submit, cancel };
}

/** A masked one-line answer to omp's prompt (`input`), with Show/Hide. */
function PromptForm({
	prompt,
	label,
	describedBy,
	autoFocus,
	primary,
	onSubmit,
	onCancel,
}: {
	prompt: LoginPrompt;
	label: string;
	/** Id of the text that explains the field, shown outside the form row. */
	describedBy?: string;
	autoFocus: boolean;
	primary: boolean;
	onSubmit: (value: string) => void;
	onCancel?: () => void;
}) {
	const t = useT();
	const [value, setValue] = useState("");
	const [reveal, setReveal] = useState(false);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (value.trim()) onSubmit(value);
	};
	return (
		<form className="flex items-end gap-2" onSubmit={submit}>
			<div className="min-w-0 flex-1">
				<Input
					aria-describedby={describedBy}
					autoComplete="off"
					autoFocus={autoFocus}
					label={label}
					mono
					onChange={event => setValue(event.target.value)}
					placeholder={prompt.placeholder}
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
			<Button disabled={!value.trim()} type="submit" variant={primary ? "primary" : "secondary"}>
				{t("providerList.login.submit")}
			</Button>
			{onCancel && (
				<Button onClick={onCancel} variant="ghost">
					{t("common.cancel")}
				</Button>
			)}
		</form>
	);
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
	const [pasteOpen, setPasteOpen] = useState(false);
	const pasteId = useId();

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

	// A browser sign-in's code paste is stock's fallback beside its callback;
	// any other prompt (an API key, a device flow's answer) is the step itself.
	const fallback = state.link?.oauth === true ? state.prompt : null;
	const primaryPrompt = fallback ? null : state.prompt;
	const keyPage = primaryPrompt !== null && state.link?.oauth === false;
	// A paired host's callback is out of this browser's reach: the paste is the way back.
	const pasteShown = fallback !== null && (pasteOpen || host !== undefined);
	const progressKey = state.progress === null ? undefined : STOCK_PROGRESS[state.progress];

	return (
		<div className="flex flex-col gap-3 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-surface-1) p-3">
			{state.link && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<p className="min-w-0 flex-1 text-sc-sm text-(--sc-text-secondary)">
						{/* Stock's OAuth instructions are English and point at the paste; the fallback below covers it. */}
						{state.link.oauth
							? t("providerList.login.browser", { provider: providerName })
							: state.link.instructions ||
								t(keyPage ? "providerList.login.keyPage" : "providerList.login.browser", {
									provider: providerName,
								})}
					</p>
					<Button
						icon={<ExternalLink />}
						onClick={() => {
							if (state.link) void window.omp.system.openExternal(state.link.target);
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
			{primaryPrompt ? (
				<PromptForm
					autoFocus
					key={primaryPrompt.id}
					label={primaryPrompt.title}
					onCancel={login.cancel}
					onSubmit={login.submit}
					primary
					prompt={primaryPrompt}
				/>
			) : (
				<div className="flex items-center gap-2">
					<span className="min-w-0 flex-1" data-login-progress="true">
						<Spinner
							label={
								progressKey
									? t(progressKey)
									: (state.progress ??
										(state.resumed
											? t("providerList.login.inProgress")
											: state.link
												? t("providerList.login.waiting")
												: t("providerList.login.starting")))
							}
							size="sm"
						/>
					</span>
					<Button onClick={login.cancel} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
				</div>
			)}
			{fallback && (
				<div className="flex flex-col gap-2 border-t border-(--sc-border-subtle) pt-3" data-login-paste="true">
					{host === undefined && (
						<Button
							aria-controls={pasteId}
							aria-expanded={pasteShown}
							className="-ml-2.5 self-start"
							onClick={() => setPasteOpen(open => !open)}
							size="sm"
							trailingIcon={<ChevronDown className={pasteShown ? "rotate-180" : undefined} />}
							variant="ghost"
						>
							{t("providerList.login.pasteToggle")}
						</Button>
					)}
					{pasteShown && (
						<div className="flex flex-col gap-2" id={pasteId}>
							<p className="text-sc-xs break-keep text-(--sc-text-muted)" id={`${pasteId}-hint`}>
								{t("providerList.login.pasteHint")}
							</p>
							<PromptForm
								autoFocus={host === undefined}
								describedBy={`${pasteId}-hint`}
								key={fallback.id}
								label={t("providerList.login.pasteLabel")}
								onSubmit={login.submit}
								primary={false}
								prompt={fallback}
							/>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

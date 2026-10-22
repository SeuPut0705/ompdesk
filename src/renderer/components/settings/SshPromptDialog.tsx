/**
 * C147/C148/C150: the questions OMPdesk's ssh asks (host keys of the server or any ProxyJump hop, passwords,
 * passphrases, codes), one dialog at a time. App mounts it in every window, so it lives apart from Settings' SSH
 * tools (SshTools.tsx): the phone's first screen loads this, not the settings rows.
 */
import { useEffect, useState } from "react";
import type { SshPrompt } from "../../../shared/ssh-tools";
import { useT } from "../../lib/i18n";
import { Button, Input, Modal } from "../common";

/** Ticks once a second while `active`, for countdowns. */
export function useNow(active: boolean): number {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

/** One question at a time from OMPdesk's ssh; nothing typed is kept. */
export function SshPromptDialog() {
	const t = useT();
	const [prompts, setPrompts] = useState<SshPrompt[]>([]);
	const [value, setValue] = useState("");
	useEffect(() => {
		const unsubscribe = window.omp.sshTools.onPrompt(setPrompts);
		void window.omp.sshTools.prompts().then(setPrompts, () => {});
		return unsubscribe;
	}, []);
	const prompt = prompts[0];
	const now = useNow(Boolean(prompt));
	const promptId = prompt?.id;
	useEffect(() => {
		if (promptId) setValue("");
	}, [promptId]);
	if (!prompt) return null;
	const answer = (answer: string | null) => {
		setValue("");
		void window.omp.sshTools.command({ action: "answer", id: prompt.id, value: answer }).catch(() => {});
	};
	const hostKey = prompt.kind === "hostKey";
	const seconds = Math.max(0, Math.ceil((prompt.expiresAt - now) / 1000));
	return (
		<Modal
			footer={
				<>
					<Button onClick={() => answer(hostKey ? "no" : null)} size="sm" variant="secondary">
						{t(hostKey ? "ssh.prompt.reject" : "common.cancel")}
					</Button>
					<Button
						disabled={!hostKey && value.length === 0}
						onClick={() => answer(hostKey ? "yes" : value)}
						size="sm"
						variant="primary"
					>
						{t(hostKey ? "ssh.prompt.trust" : "ssh.prompt.send")}
					</Button>
				</>
			}
			onClose={() => answer(hostKey ? "no" : null)}
			open
			size="sm"
			title={t(`ssh.prompt.title.${prompt.kind}`, { server: prompt.server })}
		>
			<div className="flex flex-col gap-3" data-ssh-prompt={prompt.kind}>
				{hostKey ? (
					<>
						<p className="text-sc-sm text-(--sc-text)">
							{t("ssh.prompt.hostKeyBody", { host: prompt.host ?? prompt.server })}
						</p>
						{prompt.fingerprint && (
							<code className="block rounded-(--sc-radius-md) border border-(--sc-border-subtle) px-2 py-1.5 font-mono text-sc-xs break-all text-(--sc-text)">
								{prompt.fingerprint}
							</code>
						)}
						<p className="text-sc-xs text-(--sc-text-muted)">{t("ssh.prompt.hostKeyHint")}</p>
					</>
				) : (
					<form
						onSubmit={event => {
							event.preventDefault();
							if (value) answer(value);
						}}
					>
						<Input
							autoComplete="off"
							autoFocus
							hint={t("ssh.prompt.notStored")}
							label={prompt.text.trim()}
							onChange={event => setValue(event.target.value)}
							type={prompt.kind === "code" || prompt.kind === "other" ? "text" : "password"}
							value={value}
						/>
					</form>
				)}
				<p className="text-sc-xs text-(--sc-text-muted)" role="timer">
					{t("ssh.prompt.expires", { seconds })}
					{prompts.length > 1 ? ` · ${t("ssh.prompt.more", { count: prompts.length - 1 })}` : ""}
				</p>
			</div>
		</Modal>
	);
}

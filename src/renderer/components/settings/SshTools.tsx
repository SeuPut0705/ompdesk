/**
 * Settings › SSH tools OMPdesk runs on this computer (main/ssh/*):
 * C149 the ssh-agent and key state with guidance, C151/C152 port forwards for
 * the selected host with reconnect and the server's listening ports, and
 * the questions OMPdesk's ssh asks are SshPromptDialog.tsx (mounted by App, so it stays out of this settings chunk).
 */
import { ArrowRightLeft, Globe, KeyRound, Play, RotateCw, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	SSH_GRACE_DEFAULT_MS,
	type SshAgentStatus,
	type SshForward,
	type SshTarget,
	type SshToolsRequest,
	type SshToolsState,
} from "../../../shared/ssh-tools";
import { useT } from "../../lib/i18n";
import { PLATFORM } from "../../lib/keymap";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Badge, type BadgeVariant, Banner, Button, IconButton, Input, Select, SwitchField } from "../common";
import { useNow } from "./SshPromptDialog";

const GRACE_OPTIONS = [60_000, 10 * 60_000, SSH_GRACE_DEFAULT_MS, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000] as const;
const GRACE_LABELS: Record<number, string> = {
	60000: "ssh.tools.grace.minute",
	600000: "ssh.tools.grace.tenMinutes",
	3600000: "ssh.tools.grace.hour",
	86400000: "ssh.tools.grace.day",
	604800000: "ssh.tools.grace.week",
};
const STATUS_BADGE: Record<SshForward["status"]["kind"], BadgeVariant> = {
	connecting: "muted",
	up: "success",
	retrying: "warning",
	stopped: "muted",
	hostKeyChanged: "error",
};

/** C149: is an ssh-agent there, which keys it holds, and how to get a key. */
export function SshAgentRow() {
	const t = useT();
	const [status, setStatus] = useState<SshAgentStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const load = useCallback(async () => {
		try {
			return await window.omp.sshTools.agent();
		} catch {
			return null;
		}
	}, []);
	useEffect(() => {
		let live = true;
		void load().then(result => {
			if (live && result) setStatus(result);
		});
		return () => {
			live = false;
		};
	}, [load]);
	const act = async (action: "createKey" | "loadKeys") => {
		setBusy(true);
		try {
			await window.omp.sshTools.command({ action });
		} catch (error) {
			toastError({ title: t("ssh.tools.failed"), error });
		} finally {
			setBusy(false);
			const result = await load();
			if (result) setStatus(result);
		}
	};
	if (!status) return null;
	const variant: BadgeVariant = status.agent === "available" ? "success" : "warning";
	const windows = PLATFORM === "windows";
	return (
		<div className="flex flex-col gap-2" data-ssh-agent={status.agent}>
			<div className="flex flex-wrap items-center gap-2">
				<Badge dot variant={variant}>
					{status.agent === "available"
						? t("ssh.tools.agent.keys", { count: status.agentKeys.length })
						: t(status.agent === "none" ? "ssh.tools.agent.none" : "ssh.tools.agent.error")}
				</Badge>
				<Badge>{t("ssh.tools.agent.files", { count: status.keyFiles.length })}</Badge>
			</div>
			{status.keyFiles.length === 0 && status.keygen && (
				<Banner title={t("ssh.tools.agent.noKey")}>
					<Button disabled={busy} onClick={() => void act("createKey")} size="sm">
						{t("ssh.tools.agent.createKey")}
					</Button>
				</Banner>
			)}
			{status.agent !== "available" && status.keyFiles.length > 0 && windows && (
				<p className="text-sc-xs text-(--sc-text-muted)">{t("ssh.tools.agent.startWindows")}</p>
			)}
			{status.agent !== "none" && status.agentKeys.length === 0 && status.keyFiles.length > 0 && (
				<Button disabled={busy} onClick={() => void act("loadKeys")} size="sm" variant="secondary">
					{t("ssh.tools.agent.loadKeys")}
				</Button>
			)}
		</div>
	);
}

function useSshTools(): [SshToolsState | null, (request: SshToolsRequest) => Promise<void>] {
	const t = useT();
	const [state, setState] = useState<SshToolsState | null>(null);
	useEffect(() => {
		const unsubscribe = window.omp.sshTools.onState(setState);
		void window.omp.sshTools.command({ action: "state" }).then(setState, () => {});
		return unsubscribe;
	}, []);
	const send = useCallback(
		async (request: SshToolsRequest) => {
			try {
				setState(await window.omp.sshTools.command(request));
			} catch (error) {
				toastError({ title: t("ssh.tools.failed"), error });
			}
		},
		[t],
	);
	return [state, send];
}

/** C151/C152: port forwards and the server's listening ports for one saved host. */
export function SshForwardsPanel({ target }: { target: SshTarget }) {
	const t = useT();
	const [state, send] = useSshTools();
	const [port, setPort] = useState("");
	const forwards = state?.forwards.filter(forward => forward.server === target.name) ?? [];
	const watch = state?.watches.find(entry => entry.server === target.name);
	const now = useNow(forwards.some(forward => forward.status.kind === "retrying"));
	const remotePort = Number(port);
	const validPort = Number.isInteger(remotePort) && remotePort >= 1 && remotePort <= 65535;
	const forward = (remote: number) => void send({ action: "forward", target, remotePort: remote });
	const statusText = (status: SshForward["status"]) => {
		if (status.kind === "retrying")
			return t("ssh.tools.status.retrying", {
				seconds: Math.max(0, Math.ceil((status.at - now) / 1000)),
				attempt: status.attempt,
			});
		return t(`ssh.tools.status.${status.kind}`);
	};
	return (
		<section
			aria-label={t("ssh.tools.forwards")}
			className="mt-4 border-t border-(--sc-divider) pt-3"
			data-ssh-forwards
		>
			<h4 className="mb-2 flex items-center gap-1.5 text-sc-sm font-semibold text-(--sc-text)">
				<ArrowRightLeft aria-hidden className="size-(--sc-icon-sm)" />
				{t("ssh.tools.forwards")}
			</h4>
			{forwards.length > 0 && (
				<ul className="mb-2 flex flex-col gap-1.5">
					{forwards.map(entry => {
						const status = entry.status;
						const error = status.kind === "retrying" || status.kind === "stopped" ? status.error : null;
						return (
							<li
								key={entry.id}
								className="flex flex-col gap-1 rounded-(--sc-radius-md) border border-(--sc-border-subtle) px-2 py-1.5"
								data-ssh-forward={entry.remotePort}
							>
								<div className="flex min-w-0 items-center gap-2">
									<span className="min-w-0 flex-1 truncate font-mono text-sc-xs text-(--sc-text)">
										{t("ssh.tools.forwardLine", { local: entry.localPort, remote: entry.remotePort })}
									</span>
									<Badge dot variant={STATUS_BADGE[status.kind]}>
										{statusText(status)}
									</Badge>
									{status.kind === "up" && (
										<IconButton
											icon={<Globe />}
											label={t("ssh.tools.openPreview", { port: entry.localPort })}
											onClick={() =>
												useUiStore.getState().openPreview(`http://localhost:${entry.localPort}/`)
											}
											size="sm"
										/>
									)}
									{status.kind === "retrying" || status.kind === "stopped" ? (
										<IconButton
											icon={status.kind === "retrying" ? <RotateCw /> : <Play />}
											label={t(status.kind === "retrying" ? "ssh.tools.reconnectNow" : "ssh.tools.start", {
												port: entry.localPort,
											})}
											onClick={() => void send({ action: "reconnect", id: entry.id })}
											size="sm"
										/>
									) : status.kind !== "hostKeyChanged" ? (
										<IconButton
											icon={<Square />}
											label={t("ssh.tools.stop", { port: entry.localPort })}
											onClick={() => void send({ action: "stop", id: entry.id })}
											size="sm"
										/>
									) : null}
									<IconButton
										icon={<Trash2 />}
										label={t("ssh.tools.remove", { port: entry.localPort })}
										onClick={() => void send({ action: "remove", id: entry.id })}
										size="sm"
									/>
								</div>
								{error && <p className="text-sc-xs break-words text-(--sc-text-muted)">{error}</p>}
								{status.kind === "hostKeyChanged" && (
									<Banner
										actions={
											<Button
												icon={<KeyRound />}
												onClick={() => void send({ action: "forgetHostKey", target })}
												size="sm"
											>
												{t("ssh.tools.forgetKey")}
											</Button>
										}
										title={t("ssh.tools.keyChanged")}
										variant="danger"
									>
										{status.detail}
									</Banner>
								)}
							</li>
						);
					})}
				</ul>
			)}
			<form
				className="flex items-end gap-2"
				onSubmit={event => {
					event.preventDefault();
					if (!validPort) return;
					forward(remotePort);
					setPort("");
				}}
			>
				<Input
					className="w-32"
					controlSize="sm"
					inputMode="numeric"
					label={t("ssh.tools.remotePort")}
					onChange={event => setPort(event.target.value)}
					placeholder="3000"
					value={port}
				/>
				<Button disabled={!validPort} size="sm" type="submit">
					{t("ssh.tools.forward")}
				</Button>
			</form>
			<div className="mt-3 flex items-center justify-between gap-2">
				<SwitchField
					checked={Boolean(watch)}
					className="min-w-0 flex-1"
					label={t("ssh.tools.watch")}
					onCheckedChange={on => void send({ action: "watch", target, on })}
				/>
				<Select
					aria-label={t("ssh.tools.grace")}
					className="w-auto"
					controlSize="sm"
					onChange={event => void send({ action: "setGrace", ms: Number(event.target.value) })}
					options={GRACE_OPTIONS.map(ms => ({ value: String(ms), label: t(GRACE_LABELS[ms] ?? "") }))}
					value={String(state?.graceMs ?? SSH_GRACE_DEFAULT_MS)}
				/>
			</div>
			{watch && (
				<div className="mt-2" data-ssh-ports>
					{watch.error ? (
						<p className="text-sc-xs text-(--sc-danger)">{watch.error}</p>
					) : watch.loading ? (
						<p className="text-sc-xs text-(--sc-text-muted)">{t("ssh.tools.ports.loading")}</p>
					) : watch.ports.length === 0 ? (
						<p className="text-sc-xs text-(--sc-text-muted)">{t("ssh.tools.ports.none")}</p>
					) : (
						<ul aria-label={t("ssh.tools.ports")} className="flex flex-wrap gap-1.5">
							{watch.ports.map(open => {
								const forwarded = forwards.some(entry => entry.remotePort === open);
								const fresh = watch.opened.includes(open);
								return (
									<li key={open}>
										<Button
											aria-label={t("ssh.tools.forwardPort", { port: open })}
											disabled={forwarded}
											onClick={() => forward(open)}
											size="sm"
											variant={fresh ? "primary" : "secondary"}
										>
											<span className="font-mono">{open}</span>
											{fresh && <span className="ms-1">{t("ssh.tools.ports.new")}</span>}
										</Button>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			)}
		</section>
	);
}

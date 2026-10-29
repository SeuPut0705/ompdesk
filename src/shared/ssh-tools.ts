/**
 * Settings › SSH tools OMPdesk runs on this computer for a saved host
 * (main/ssh/*): port forwards with reconnect (C151/C152), the server's
 * listening ports, the ssh-agent / key state (C149), and the prompts its own
 * ssh processes raise — passwords, passphrases, codes, host keys (C147/C148).
 * Host keys go to OMPdesk's own known_hosts, checked on every ProxyJump hop (C150).
 */
export const SSH_TOOLS_COMMAND = "ssh-tools:command";
export const SSH_TOOLS_STATE = "ssh-tools:state";
export const SSH_TOOLS_PROMPT = "ssh-tools:prompt";
export const SSH_TOOLS_AGENT = "ssh-tools:agent";
export const SSH_TOOLS_PROMPTS = "ssh-tools:prompts";

/** A saved host as Settings › SSH lists it. */
export interface SshTarget {
	/** The host's alias (Settings name); also its key for forwards. */
	name: string;
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
}

export type SshForwardStatus =
	| { kind: "connecting" }
	| { kind: "up" }
	/** Dropped; the next attempt starts at `at` (epoch ms). */
	| { kind: "retrying"; at: number; attempt: number; error: string }
	| { kind: "stopped"; error: string | null }
	/** The server's host key no longer matches the one the user accepted. */
	| { kind: "hostKeyChanged"; detail: string };

export interface SshForward {
	id: string;
	server: string;
	target: SshTarget;
	localPort: number;
	remotePort: number;
	status: SshForwardStatus;
}

export interface SshPortWatch {
	server: string;
	/** Listening TCP ports on the server, ascending. */
	ports: number[];
	/** Ports that opened since watching began (the suggestions). */
	opened: number[];
	error: string | null;
	/** The first listing has not arrived yet. */
	loading: boolean;
}

export interface SshToolsState {
	forwards: SshForward[];
	watches: SshPortWatch[];
	/** How long a dropped forward keeps reconnecting before it stops (ms). */
	graceMs: number;
}

export const SSH_GRACE_MIN_MS = 60_000;
export const SSH_GRACE_MAX_MS = 7 * 24 * 60 * 60_000;
export const SSH_GRACE_DEFAULT_MS = 60 * 60_000;
/** Watched ports refresh this often. */
export const SSH_PORT_POLL_SECONDS = 5;
/** An unanswered prompt is cancelled after this long; answers are never stored. */
export const SSH_PROMPT_TIMEOUT_MS = 2 * 60_000;

export interface SshAgentStatus {
	/** `available` = an agent answers; `none` = no agent socket; `error` = it did not answer. */
	agent: "available" | "none" | "error";
	/** Keys the agent holds (`ssh-add -l` lines). */
	agentKeys: string[];
	/** Public key files in ~/.ssh. */
	keyFiles: string[];
	/** `ssh-keygen` exists (key creation is possible). */
	keygen: boolean;
}

export type SshPromptKind = "password" | "passphrase" | "code" | "hostKey" | "other";

export interface SshPrompt {
	id: string;
	server: string;
	kind: SshPromptKind;
	/** ssh's own question. */
	text: string;
	/** The key fingerprint a host-key question names. */
	fingerprint: string | null;
	/** The host (or ProxyJump hop) a host-key question is about. */
	host: string | null;
	expiresAt: number;
}

export type SshToolsRequest =
	| { action: "state" }
	| { action: "watch"; target: SshTarget; on: boolean }
	| { action: "forward"; target: SshTarget; remotePort: number; localPort?: number }
	| { action: "stop" | "remove" | "reconnect"; id: string }
	| { action: "setGrace"; ms: number }
	/** Drop the saved host key of `target` and its hops, so the next connection asks again. */
	| { action: "forgetHostKey"; target: SshTarget }
	/** `value` null = cancel. */
	| { action: "answer"; id: string; value: string | null }
	/** Create ~/.ssh/id_ed25519 (no passphrase) when no key file exists. */
	| { action: "createKey" }
	/** Hand every private key in ~/.ssh to the running ssh-agent. */
	| { action: "loadKeys" };

export interface SshToolsApi {
	command(request: SshToolsRequest): Promise<SshToolsState>;
	agent(): Promise<SshAgentStatus>;
	/** The questions waiting now. */
	prompts(): Promise<SshPrompt[]>;
	onState(callback: (state: SshToolsState) => void): () => void;
	onPrompt(callback: (prompts: SshPrompt[]) => void): () => void;
}

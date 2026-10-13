/**
 * SSH hosts over the live session: stock `ssh` capability discovery, config
 * writer and connection manager. Ported from the fork's rpc-operations.ts.
 * Wire shapes match `src/shared/rpc-types.ts`.
 */
import { type SSHHost, sshCapability } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import { loadCapability, reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/discovery";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	readSSHConfigFile,
	removeSSHHost,
	type SSHHostConfig,
	updateSSHHost,
	validateHostName,
} from "@oh-my-pi/pi-coding-agent/ssh/config-writer";
import {
	ensureConnection,
	ensureHostInfo,
	getHostInfoForHost,
	invalidateHostMetadata,
	type SSHConnectionTarget,
} from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { $which, getSSHConfigPath } from "@oh-my-pi/pi-utils";
import { guard } from "./health";
import { asRecord, requiredString } from "./params";
import type { BridgeMethods } from "./types";

interface SshHostInput {
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
	description?: string;
	compat?: boolean;
}

function sshInput(raw: unknown): SshHostInput {
	const host = asRecord(raw);
	if (typeof host.host !== "string") throw new Error("SSH host payload is required");
	return {
		host: host.host,
		...(typeof host.username === "string" ? { username: host.username } : {}),
		...(typeof host.port === "number" ? { port: host.port } : {}),
		...(typeof host.keyPath === "string" ? { keyPath: host.keyPath } : {}),
		...(typeof host.description === "string" ? { description: host.description } : {}),
		...(host.compat === true ? { compat: true } : {}),
	};
}

function connectionTarget(name: string, host: SshHostInput): SSHConnectionTarget {
	return {
		name,
		host: host.host,
		...(host.username ? { username: host.username } : {}),
		...(host.port ? { port: host.port } : {}),
		...(host.keyPath ? { keyPath: host.keyPath } : {}),
		...(host.compat ? { compat: true } : {}),
	};
}

function validateSshHost(name: string, host: SshHostInput): void {
	const nameError = validateHostName(name);
	if (nameError) throw new Error(nameError);
	if (!host.host.trim()) throw new Error("Host address cannot be empty");
	if (host.port !== undefined && (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)) {
		throw new Error("Port must be an integer between 1 and 65535");
	}
}

async function projectSshHost(host: SSHHost) {
	const cached = await getHostInfoForHost(connectionTarget(host.name, host));
	return {
		name: host.name,
		host: host.host,
		...(host.username ? { username: host.username } : {}),
		...(host.port ? { port: host.port } : {}),
		...(host.keyPath ? { keyPath: host.keyPath } : {}),
		...(host.description ? { description: host.description } : {}),
		...(host.compat ? { compat: true } : {}),
		scope: host._source.level,
		editable: host._source.provider === "ssh-json" && host._source.level !== "native",
		source: host._source.path,
		...(cached
			? {
					os: cached.os,
					shell: cached.shell,
					...(cached.compatShell ? { compatShell: cached.compatShell } : {}),
					...(cached.transferShell ? { transferShell: cached.transferShell } : {}),
				}
			: {}),
	};
}

async function sshHosts(session: AgentSession) {
	const result = await loadCapability<SSHHost>(sshCapability.id, { cwd: session.sessionManager.getCwd() });
	return {
		openSshAvailable: Boolean($which("ssh")),
		hosts: await Promise.all(result.items.map(projectSshHost)),
		warnings: result.warnings,
	};
}

type SshScope = "user" | "project";

function sshScope(value: unknown): SshScope | undefined {
	if (value === undefined) return undefined;
	if (value !== "user" && value !== "project") throw new Error(`Invalid SSH scope: ${String(value)}`);
	return value;
}

/** Write `config` under `name` in `filePath`, then drop the old entry; roll the write back if the removal fails. */
async function moveSshHost(
	filePath: string,
	name: string,
	config: SSHHostConfig,
	sourcePath: string,
	sourceName: string,
) {
	await updateSSHHost(filePath, name, config);
	try {
		await removeSSHHost(sourcePath, sourceName);
	} catch (error) {
		await removeSSHHost(filePath, name).catch(() => undefined);
		throw error;
	}
}

async function manageSshHost(session: AgentSession, params: unknown) {
	const p = asRecord(params);
	const action = p.action;
	const scope = sshScope(p.scope) ?? "user";
	const name = requiredString(params, "name");
	const previousName = typeof p.previousName === "string" ? p.previousName : undefined;
	const previousScope = sshScope(p.previousScope);
	const cwd = session.sessionManager.getCwd();
	const filePath = getSSHConfigPath(scope, cwd);
	if (action === "delete") {
		await removeSSHHost(filePath, name);
		await invalidateHostMetadata([name]);
		resetCapabilities();
		return { deleted: true };
	}
	if (action !== "create" && action !== "update") throw new Error(`Unknown ssh_manage action: ${String(action)}`);
	const host = sshInput(p.host);
	validateSshHost(name, host);
	const config: SSHHostConfig = {
		host: host.host.trim(),
		...(host.username?.trim() ? { username: host.username.trim() } : {}),
		...(host.port ? { port: host.port } : {}),
		...(host.keyPath?.trim() ? { keyPath: host.keyPath.trim() } : {}),
		...(host.description?.trim() ? { description: host.description.trim() } : {}),
		...(host.compat ? { compat: true } : {}),
	};
	if (action === "create") {
		const existing = await readSSHConfigFile(filePath);
		if (existing.hosts?.[name]) throw new Error(`Host "${name}" already exists`);
	}
	const sourceName = previousName ?? name;
	const sourcePath = getSSHConfigPath(previousScope ?? scope, cwd);
	if (action === "update" && sourcePath !== filePath) {
		const [source, destination] = await Promise.all([readSSHConfigFile(sourcePath), readSSHConfigFile(filePath)]);
		if (!source.hosts?.[sourceName]) throw new Error(`Host "${sourceName}" not found`);
		if (destination.hosts?.[name]) throw new Error(`Host "${name}" already exists in ${scope} config`);
		await moveSshHost(filePath, name, config, sourcePath, sourceName);
	} else if (action === "update" && previousName && previousName !== name) {
		const existing = await readSSHConfigFile(filePath);
		if (!existing.hosts?.[previousName]) throw new Error(`Host "${previousName}" not found`);
		if (existing.hosts[name]) throw new Error(`Host "${name}" already exists`);
		await moveSshHost(filePath, name, config, filePath, previousName);
	} else {
		await updateSSHHost(filePath, name, config);
	}
	await invalidateHostMetadata(new Set([sourceName, name]));
	resetCapabilities();
	return { name, ...config, scope, editable: true, source: filePath };
}

/** Below the GUI's 60s transport timeout; stock ssh helpers take no signal, so the deadline races them. */
const SSH_TEST_TIMEOUT_MS = 50_000;

async function testSshHost(params: unknown) {
	const raw = asRecord(asRecord(params).host);
	const name = typeof raw.name === "string" ? raw.name : "";
	const host = sshInput(raw);
	validateSshHost(name, host);
	const target = connectionTarget(name, host);
	const checkedAt = new Date().toISOString();
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => deadline.reject(new Error(`SSH connection test timed out after ${SSH_TEST_TIMEOUT_MS / 1000} seconds`)),
		SSH_TEST_TIMEOUT_MS,
	);
	try {
		const info = await Promise.race([ensureConnection(target).then(() => ensureHostInfo(target)), deadline.promise]);
		return {
			name,
			ok: true,
			checkedAt,
			os: info.os,
			shell: info.shell,
			...(info.compatShell ? { compatShell: info.compatShell } : {}),
			...(info.transferShell ? { transferShell: info.transferShell } : {}),
		};
	} catch (error) {
		return { name, ok: false, checkedAt, error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}

export const methods: BridgeMethods = guard("ssh", {
	ssh_hosts: async (_params, env) => sshHosts(env.session()),
	ssh_manage: async (params, env) => manageSshHost(env.session(), params),
	ssh_test: async params => testSshHost(params),
});

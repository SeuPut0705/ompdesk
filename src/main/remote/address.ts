/**
 * Remote-device ports, their environment overrides, and `host:port` address
 * strings. E2E runs parallel instances, so both ports can be overridden.
 */
import { isIPv6 } from "node:net";

export const DEFAULT_REMOTE_PORT = 47821;
export const DEFAULT_DISCOVERY_PORT = 47822;

function envPort(name: string): number | null {
	const raw = process.env[name]?.trim();
	if (!raw || !/^\d+$/.test(raw)) return null;
	const port = Number(raw);
	return port >= 0 && port <= 65535 ? port : null;
}

/** Host TCP port: `OMP_GUI_REMOTE_PORT`, else 47821. */
export function remotePort(): number {
	return envPort("OMP_GUI_REMOTE_PORT") ?? DEFAULT_REMOTE_PORT;
}

/** Beacon UDP port: `OMP_GUI_REMOTE_DISCOVERY_PORT`, else 47822. */
export function discoveryPort(): number {
	return envPort("OMP_GUI_REMOTE_DISCOVERY_PORT") ?? DEFAULT_DISCOVERY_PORT;
}

export interface HostPort {
	host: string;
	port: number;
}

/**
 * Parse `host`, `host:port`, `[v6]`, `[v6]:port` or a bare IPv6 literal. The
 * port defaults to the host's default TCP port. Null for anything malformed.
 */
export function parseAddress(input: string, defaultPort = DEFAULT_REMOTE_PORT): HostPort | null {
	const text = input.trim();
	if (!text || /\s/.test(text)) return null;
	let host: string;
	let portText: string | undefined;
	const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
	if (bracketed) {
		host = bracketed[1] ?? "";
		portText = bracketed[2];
		if (!isIPv6(host)) return null;
	} else if (isIPv6(text)) {
		host = text;
	} else {
		const parts = text.split(":");
		if (parts.length > 2) return null;
		host = parts[0] ?? "";
		portText = parts[1];
		if (portText !== undefined && !/^\d+$/.test(portText)) return null;
	}
	if (!host || !/^[A-Za-z0-9.:%_-]+$/.test(host)) return null;
	const port = portText === undefined ? defaultPort : Number(portText);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	return { host, port };
}

/** `host:port`, bracketing IPv6 literals. */
export function formatAddress({ host, port }: HostPort): string {
	return isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
}

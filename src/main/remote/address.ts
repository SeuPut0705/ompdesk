/**
 * The remote-device port, its environment override, and `host:port` address
 * strings. E2E runs parallel instances, so the port can be overridden.
 */
import { isIPv6 } from "node:net";

export const DEFAULT_REMOTE_PORT = 47821;
/**
 * A host takes the first free port of `remotePort()` and its successors; a device looking for it probes the same
 * list. A host whose ports are all taken says so instead of listening somewhere nobody looks.
 */
export const REMOTE_PORT_SPAN = 5;
/**
 * Where the default host goes when 47821-47825 are all taken: one port in each of five other thousand-blocks, below
 * every OS's dynamic range. Windows reserves whole 100-port blocks for Hyper-V, WSL and Docker (`netsh int ipv4 show
 * excludedportrange`; binding one answers EACCES), and a Windows PC whose block covered 47821-47825 listened nowhere
 * and no device could reach it (24 Oct 2026). A device probes these after the five, so both ends agree with no setting.
 */
export const FALLBACK_REMOTE_PORTS = [41821, 38821, 35821, 32821, 29821] as const;

/** Host TCP port: `OMP_GUI_REMOTE_PORT`, else 47821. */
export function remotePort(): number {
	const raw = process.env.OMP_GUI_REMOTE_PORT?.trim();
	if (!raw || !/^\d+$/.test(raw)) return DEFAULT_REMOTE_PORT;
	const port = Number(raw);
	return port <= 65535 ? port : DEFAULT_REMOTE_PORT;
}

/**
 * The ports a host tries in order, and a device probes: `remotePort()` and its successors, then (for the default port)
 * the fallbacks; `[0]` for port 0. A port set with `OMP_GUI_REMOTE_PORT` gets no fallbacks: it was chosen.
 */
export function remotePortCandidates(base = remotePort()): number[] {
	if (base === 0) return [0];
	const ports: number[] = [];
	for (let i = 0; i < REMOTE_PORT_SPAN && base + i <= 65535; i++) ports.push(base + i);
	return base === DEFAULT_REMOTE_PORT ? [...ports, ...FALLBACK_REMOTE_PORTS] : ports;
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

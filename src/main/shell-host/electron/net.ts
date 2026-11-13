/**
 * Electron's `net` through the shell's `net.*` (PROTOCOL.md §10): `net.isOnline()` (mirrored) and `net.resolveHost`
 * (Chromium's resolver). Nothing in main fetches through Electron's `net` any more: the updater's requests are the
 * shell's own (PROTOCOL.md §15.8).
 */
import type { Host } from "./host";

export function createNet(host: Host) {
	const { client } = host;
	let online = host.facts.system.online;
	client.on("net.online", (data: { online: boolean }) => {
		online = data.online;
	});

	return {
		isOnline: (): boolean => online,
		async resolveHost(
			hostname: string,
			options?: { cacheUsage?: string },
		): Promise<{ endpoints: Array<{ address: string; family: "ipv4" | "ipv6" }> }> {
			return client.call("net.resolveHost", {
				host: hostname,
				...(options?.cacheUsage ? { cacheUsage: options.cacheUsage } : {}),
			});
		},
	};
}

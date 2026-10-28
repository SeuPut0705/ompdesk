import os from "node:os";
import path from "node:path";

/**
 * Where the downloaded tools live: `OMPDESK_FORMAL_CACHE`, else `%LOCALAPPDATA%\ompdesk\formal` on Windows,
 * else `~/.cache/ompdesk/formal` (macOS and elsewhere). Nothing here is ever written outside this folder.
 */
export function cacheRoot(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = os.homedir(),
): string {
	const override = env.OMPDESK_FORMAL_CACHE;
	if (override) return path.resolve(override);
	if (platform === "win32") {
		const base = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
		return path.win32.join(base, "ompdesk", "formal");
	}
	return path.posix.join(home, ".cache", "ompdesk", "formal");
}

/** `darwin-arm64`, `darwin-x64`, `win32-x64`: the keys of the platform tables in assets/toolchain.json. */
export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
	return `${platform}-${arch}`;
}

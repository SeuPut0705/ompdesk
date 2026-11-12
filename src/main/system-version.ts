/**
 * What main reports about the machine and the shell it runs under, where Electron's `process.getSystemVersion()` and
 * `process.versions.electron` used to answer (Node has neither).
 */
import { release } from "node:os";

/** macOS's Darwin major → the marketing major (Darwin 24 is macOS 15; 25 is macOS 26, the first year-numbered). */
function macosMajor(darwin: number): number {
	if (darwin >= 25) return darwin + 1;
	return darwin - 9;
}

/**
 * The OS marketing version (macOS 15.5.0, Windows 10.0.22631): `os.release()` on Windows, and on macOS the kernel's
 * version mapped back (Darwin 24.5.0 is macOS 15.5.0; the minor and patch carry over).
 */
export function systemVersion(platform: NodeJS.Platform = process.platform, kernel: string = release()): string {
	if (platform !== "darwin") return kernel;
	const [major, minor = "0", patch = "0"] = kernel.split(".");
	const darwin = Number(major);
	return Number.isInteger(darwin) && darwin >= 20 ? `${macosMajor(darwin)}.${minor}.${patch}` : kernel;
}

/** The browser engine's shell, as the diagnostics and the feedback form name it (`ompdesk-shell 0.1.0, CEF 156.0.26`). */
export function shellEngine(versions: Record<string, string | undefined> = process.versions): string {
	return `ompdesk-shell ${versions.shell ?? "?"}, CEF ${versions.cef ?? "?"}`;
}

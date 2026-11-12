/**
 * Finding the Tailscale CLI and telling which Tailscale it belongs to. The lookup is the core process's
 * (`native/ompdesk/crates/core/src/tailscale/locate.rs`); this file is its client. Main names the platform whose
 * rules apply and hands over what only it knows: the override (env `OMP_GUI_TAILSCALE`, which never falls through to
 * another install), the pref `mobileWeb.tailscaleBin`, `%ProgramFiles%` and `%ProgramFiles(x86)%`, and the login
 * shell's PATH.
 *
 * macOS, in order: the override, the pref, the app's own binary (a CLI only with `TAILSCALE_BE_CLI=1`), the
 * Standalone app's "CLI integration" in `/usr/local/bin`, Homebrew's `/opt/homebrew/bin/tailscale` (on a Mac with the
 * app it is a wrapper that execs the app), then the PATH. Windows: the override, the pref, the two Program Files
 * folders, then the PATH.
 */
import type { TailscaleVariant } from "../../shared/mobile-web";
import { core } from "../core/process";
import { CLI_TIMEOUT_MS, runRules } from "./cli";

export interface LocatedTailscale {
	/** The executable used for every call. */
	path: string;
	variant: TailscaleVariant;
	/** The app bundle on macOS (the binary itself, or the one a wrapper script execs); null for a CLI-only daemon. */
	app: string | null;
	/** Added to every call's environment (`TAILSCALE_BE_CLI=1` for a macOS app binary). */
	env: Record<string, string>;
}

export interface LocateInputs {
	platform: "darwin" | "win32";
	/** Pref `mobileWeb.tailscaleBin`. */
	pref: string | null;
	/** The login shell's PATH. */
	pathEnv: string;
	/**
	 * Whether a Mac app's bundle is asked which Tailscale it is (`CFBundleIdentifier`, read with `plutil`); without
	 * it an app's variant reads `other`. Machine setup only needs the path.
	 */
	bundle: boolean;
	/** Where the override and the Program Files folders are read from; main's own environment unless a test names one. */
	env?: NodeJS.ProcessEnv;
}

/** The Tailscale CLI of this machine, or null when there is none. Throws when the core process cannot answer. */
export async function locateTailscale(inputs: LocateInputs): Promise<LocatedTailscale | null> {
	const env = inputs.env ?? process.env;
	const params = {
		platform: inputs.platform,
		forced: env.OMP_GUI_TAILSCALE ?? null,
		pref: inputs.pref,
		programFiles: [env.ProgramFiles ?? null, env["ProgramFiles(x86)"] ?? null],
		pathEnv: inputs.pathEnv,
		bundle: inputs.bundle,
		rules: runRules(),
	};
	const answer = await core().call<LocatedTailscale | null>("tailscale.locate", params, {
		timeoutMs: CLI_TIMEOUT_MS + 7_000,
	});
	return answer.result;
}

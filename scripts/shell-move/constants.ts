/**
 * The identities the dry run uses in place of the real ones. Every one is derived the way electron-builder derives
 * the real ones, and none can equal them: `assertTestIdentity()` refuses to start otherwise.
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UUID } from "builder-util-runtime";
import { REAL_DIR, REAL_GUID, REAL_UPDATER_CACHE } from "./guard";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** electron-builder's own namespace (app-builder-lib NsisTarget): the uninstall GUID is the appId's UUID v5 under it. */
const BUILDER_NAMESPACE = "50e065bc-3134-11e6-9bab-38c9862bdaf3";
export const REAL_APP_ID = "com.seuput.ompdesk";
/** A test app id → a GUID shaped exactly like electron-builder's (UUID v5), for `nsis.guid` and the registry keys. */
export const TEST_GUID = UUID.v5(`${REAL_APP_ID}.shell-move-test`, UUID.parse(BUILDER_NAMESPACE));
/** The Start-menu and desktop shortcut names of both test setups (the real ones are `OMPdesk.lnk`). */
export const TEST_SHORTCUT = "OMPdesk-movetest";
export const LOCAL = process.env.LOCALAPPDATA ?? "";
export const TEST_DIR = join(LOCAL, "Programs", "OMPdesk-movetest");
export const TEST_UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${TEST_GUID}`;
export const TEST_INSTALL_KEY = `HKCU\\Software\\${TEST_GUID}`;
/** Select either released Electron app, without changing the test identity or accepting an arbitrary build. */
export const RELEASED_TAG = process.env.OMP_MOVE_RELEASED_TAG ?? "v0.127.0";
if (!["v0.127.0", "v0.128.0"].includes(RELEASED_TAG))
	throw new Error("OMP_MOVE_RELEASED_TAG must be v0.127.0 or v0.128.0");
export const RELEASED_VERSION = RELEASED_TAG.slice(1);
export const OFFERED_VERSION = "0.200.0";
export const REPO = "SeuPut0705/ompdesk";

/** Throws unless the test identity is nothing the person's install can be mistaken for. */
export function assertTestIdentity(): void {
	const lower = (text: string) => text.toLowerCase();
	const problems: string[] = [];
	if (lower(TEST_GUID) === lower(REAL_GUID)) problems.push("the test GUID is the real one");
	if (
		lower(`${TEST_DIR}\\`).startsWith(lower(`${REAL_DIR}\\`)) ||
		lower(`${REAL_DIR}\\`).startsWith(lower(`${TEST_DIR}\\`))
	) {
		problems.push("the test folder and the real install folder contain one another");
	}
	if ((TEST_SHORTCUT as string) === "OMPdesk") problems.push("the test shortcut name is the real one");
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(TEST_GUID)) {
		problems.push(`the test GUID ${TEST_GUID} is not shaped like electron-builder's (UUID v5)`);
	}
	if (!LOCAL) problems.push("LOCALAPPDATA is not set");
	if (problems.length) throw new Error(`refusing to run: ${problems.join("; ")}`);
}

/**
 * Throws unless `env` keeps a test app's own folders off the person's: its LOCALAPPDATA (the updater's cache
 * `ompdesk-updater` and its `pending\` setup), APPDATA (userData) and the profile all lie elsewhere.
 */
export function assertTestEnv(env: Record<string, string | undefined>): void {
	const same = (a: string | undefined, b: string | undefined) =>
		!!a && !!b && resolve(a).toLowerCase() === resolve(b).toLowerCase();
	const problems: string[] = [];
	if (!env.LOCALAPPDATA || same(env.LOCALAPPDATA, LOCAL)) problems.push("LOCALAPPDATA is the person's");
	if (env.LOCALAPPDATA && same(join(env.LOCALAPPDATA, "ompdesk-updater"), REAL_UPDATER_CACHE))
		problems.push("the updater cache is the person's");
	if (!env.APPDATA || same(env.APPDATA, process.env.APPDATA)) problems.push("APPDATA is the person's");
	if (!env.OMP_GUI_TEST_USER_DATA_DIR) problems.push("no test profile (OMP_GUI_TEST_USER_DATA_DIR)");
	if (problems.length) throw new Error(`refusing to start a test app: ${problems.join("; ")}`);
}

const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { certificateSha1 } = require("./mac-signing.json");

const run = promisify(execFile);
const SECURITY = "/usr/bin/security";
/** Local copy of the signing identity on the maintainer's Mac (mode 0700). */
const LOCAL_DIR = path.join(os.homedir(), ".ompdesk-signing");

/**
 * The signing identity: `OMPDESK_MAC_SIGNING_P12_BASE64` and
 * `OMPDESK_MAC_SIGNING_PASSWORD` (release.yml, from repository secrets), else
 * the maintainer's local copy in ~/.ompdesk-signing.
 */
async function credentials() {
	const encoded = process.env.OMPDESK_MAC_SIGNING_P12_BASE64;
	const password = process.env.OMPDESK_MAC_SIGNING_PASSWORD;
	if (encoded && password) return { p12: Buffer.from(encoded, "base64"), password };
	try {
		return {
			p12: await fs.readFile(path.join(LOCAL_DIR, "ompdesk-signing.p12")),
			password: (await fs.readFile(path.join(LOCAL_DIR, "password"), "utf8")).trim(),
		};
	} catch {
		return null;
	}
}

/**
 * electron-builder `mac.sign`. Signs the bundle with OMPdesk's own
 * self-signed certificate (`mac-signing.json`), so every build has the same
 * designated requirement (`identifier "com.seuput.ompdesk" and certificate
 * root = H"…"`). macOS keys privacy grants (folders, local network,
 * microphone) to that requirement; an ad-hoc signature's requirement is the
 * build's cdhash, so each update looked like a new app and asked again.
 *
 * The identity goes into a throwaway keychain that codesign reads through
 * `--keychain`; the user's keychain search list is never touched. Without a
 * certificate the build falls back to ad-hoc, unless
 * `OMPDESK_MAC_SIGNING_REQUIRED=1` (release builds) makes that an error.
 */
async function sign(opts) {
	const { signAsync } = await import("@electron/osx-sign");
	const identity = await credentials();
	if (!identity) {
		if (process.env.OMPDESK_MAC_SIGNING_REQUIRED === "1") {
			throw new Error("OMPdesk signing certificate missing (OMPDESK_MAC_SIGNING_P12_BASE64 / _PASSWORD)");
		}
		console.warn("[mac-sign] no OMPdesk signing certificate; signing ad-hoc");
		return signAsync(opts);
	}

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-sign-"));
	const keychain = path.join(dir, "signing.keychain-db");
	const p12 = path.join(dir, "identity.p12");
	const keychainPassword = crypto.randomBytes(24).toString("hex");
	try {
		await fs.writeFile(p12, identity.p12, { mode: 0o600 });
		await run(SECURITY, ["create-keychain", "-p", keychainPassword, keychain]);
		// No auto-lock while a long build signs.
		await run(SECURITY, ["set-keychain-settings", keychain]);
		await run(SECURITY, ["unlock-keychain", "-p", keychainPassword, keychain]);
		await run(SECURITY, ["import", p12, "-k", keychain, "-P", identity.password, "-T", "/usr/bin/codesign"]);
		await run(SECURITY, [
			"set-key-partition-list",
			"-S",
			"apple-tool:,apple:,codesign:",
			"-s",
			"-k",
			keychainPassword,
			keychain,
		]);
		// Self-signed, so not "valid" (-v): list every code-signing identity.
		const { stdout } = await run(SECURITY, ["find-identity", "-p", "codesigning", keychain]);
		const sha1 = certificateSha1.toUpperCase();
		if (!stdout.toUpperCase().includes(sha1)) {
			throw new Error(`signing certificate is not the pinned OMPdesk certificate ${certificateSha1}`);
		}
		const optionsForFile = opts.optionsForFile;
		await signAsync({
			...opts,
			identity: sha1,
			identityValidation: false,
			keychain,
			// No secure timestamp: nothing notarizes, and Apple's TSA would be a network dependency.
			optionsForFile: filePath => ({ ...(optionsForFile ? optionsForFile(filePath) : {}), timestamp: "none" }),
		});
	} finally {
		await run(SECURITY, ["delete-keychain", keychain]).catch(() => undefined);
		await fs.rm(dir, { recursive: true, force: true });
	}
}

module.exports = { sign };

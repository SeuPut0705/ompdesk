/**
 * A stand-in for api.github.com that answers the released Electron app's update check with one release whose Windows
 * asset is the setup the dry run built. The app reaches it through Chromium's own switches
 * (`--host-resolver-rules=MAP api.github.com 127.0.0.1:<port>` + `--ignore-certificate-errors`), so the updater that
 * runs is exactly the released one (src/main/update-release.ts validates the metadata comment, update-provider.ts
 * downloads the asset, electron-updater checks its SHA-512).
 *
 *   bun feed.ts --setup <ompdesk-windows-setup.exe> --version 0.200.0 --cert-dir <dir> [--port 8443]
 *   bun feed.ts --setup <ompdesk-mac-arm64.dmg> --platform mac --version 0.200.0 --cert-dir <dir>   (the Mac's run)
 *
 * `--rollback-dmg <dmg> --rollback-tag v0.127.0 --http-port <n>` also serves the "last Electron release" the shell's launcher
 * downloads when the new shell does not come up (OMPDESK_LAUNCHER_RELEASE_URL=http://127.0.0.1:<n>): the tag route
 * `/repos/SeuPut0705/ompdesk/releases/tags/<tag>` (the release JSON with its ompdesk-update comment) and the asset, over
 * plain HTTP, the same routes and comment format as above.
 *
 * The self-signed certificate for api.github.com is made in `--cert-dir` (never the repository). One JSON line per
 * request on stdout; the first line says it is listening.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		setup: { type: "string" },
		version: { type: "string" },
		"cert-dir": { type: "string" },
		platform: { type: "string", default: "windows" },
		port: { type: "string", default: "8443" },
		"rollback-dmg": { type: "string" },
		"rollback-tag": { type: "string" },
		"http-port": { type: "string" },
	},
});
const setup = values.setup ?? "";
const version = values.version ?? "0.200.0";
const certDir = values["cert-dir"] ?? "";
if (!setup || !certDir) throw new Error("usage: bun feed.ts --setup <file> --version <v> --cert-dir <dir> [--port n]");
const bytes = new Uint8Array(await Bun.file(setup).arrayBuffer());
const sha512 = createHash("sha512").update(bytes).digest("base64");
const platform = values.platform === "mac" ? "mac" : "windows";
const name = platform === "mac" ? "ompdesk-mac-arm64.dmg" : "ompdesk-windows-setup.exe";
mkdirSync(certDir, { recursive: true });
const key = join(certDir, "feed-key.pem");
const cert = join(certDir, "feed-cert.pem");
if (!existsSync(cert)) {
	const made = Bun.spawnSync([
		"openssl",
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		key,
		"-out",
		cert,
		"-days",
		"2",
		"-subj",
		"/CN=api.github.com",
	]);
	if (made.exitCode !== 0) throw new Error(`openssl could not make the feed's certificate: ${made.stderr.toString()}`);
}
const metadata = {
	version,
	releaseDate: new Date().toISOString(),
	files: { [platform]: { name, size: bytes.length, sha512 } },
};
const release = {
	tag_name: `v${version}`,
	name: `v${version}`,
	body: `Dry-run release of the shell move.\n\n<!-- ompdesk-update ${JSON.stringify(metadata)} -->`,
	draft: false,
	prerelease: false,
	assets: [
		{ id: 1, name, size: bytes.length, url: "https://api.github.com/repos/SeuPut0705/ompdesk/releases/assets/1" },
	],
};
const server = Bun.serve({
	port: Number(values.port),
	hostname: "127.0.0.1",
	tls: { key: Bun.file(key), cert: Bun.file(cert) },
	fetch(request) {
		const url = new URL(request.url);
		console.log(JSON.stringify({ at: Date.now(), method: request.method, path: url.pathname }));
		// The token probe (update-auth.ts checkRepoAccess): a public repository answers 200.
		if (url.pathname === "/repos/SeuPut0705/ompdesk")
			return Response.json({ full_name: "SeuPut0705/ompdesk", private: false });
		if (url.pathname === "/repos/SeuPut0705/ompdesk/releases/latest") return Response.json(release);
		if (url.pathname === "/repos/SeuPut0705/ompdesk/releases") return Response.json([release]);
		// macOS reads the asset as GitHub serves it: a 302 from the API to the storage host (updater.ts signedAssetUrl).
		if (platform === "mac" && url.pathname === "/repos/SeuPut0705/ompdesk/releases/assets/1")
			return new Response(null, { status: 302, headers: { location: `https://api.github.com/download/${name}` } });
		if (url.pathname === "/repos/SeuPut0705/ompdesk/releases/assets/1" || url.pathname === `/download/${name}`)
			return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
		return new Response("not here", { status: 404 });
	},
});
if (values["rollback-dmg"]) {
	const tag = values["rollback-tag"] ?? "";
	const httpPort = Number(values["http-port"]);
	if (!tag || !httpPort) throw new Error("--rollback-dmg needs --rollback-tag and --http-port");
	const previous = new Uint8Array(await Bun.file(values["rollback-dmg"]).arrayBuffer());
	const previousName = "ompdesk-mac-arm64.dmg";
	const previousMetadata = {
		version: tag.replace(/^v/, ""),
		releaseDate: new Date().toISOString(),
		files: {
			mac: {
				name: previousName,
				size: previous.length,
				sha512: createHash("sha512").update(previous).digest("base64"),
			},
		},
	};
	const previousRelease = {
		tag_name: tag,
		name: tag,
		body: `The last Electron release (a stand-in).\n\n<!-- ompdesk-update ${JSON.stringify(previousMetadata)} -->`,
		draft: false,
		prerelease: false,
		assets: [
			{
				id: 2,
				name: previousName,
				size: previous.length,
				url: `http://127.0.0.1:${httpPort}/repos/SeuPut0705/ompdesk/releases/assets/2`,
			},
		],
	};
	const http = Bun.serve({
		port: httpPort,
		hostname: "127.0.0.1",
		fetch(request) {
			const url = new URL(request.url);
			console.log(JSON.stringify({ at: Date.now(), http: true, method: request.method, path: url.pathname }));
			if (url.pathname === `/repos/SeuPut0705/ompdesk/releases/tags/${tag}`) return Response.json(previousRelease);
			if (url.pathname === "/repos/SeuPut0705/ompdesk/releases/assets/2")
				return new Response(previous, { headers: { "content-type": "application/octet-stream" } });
			return new Response("not here", { status: 404 });
		},
	});
	console.log(JSON.stringify({ rollbackListening: http.port, tag, size: previous.length }));
}
console.log(JSON.stringify({ listening: server.port, version, size: bytes.length, sha512: sha512.slice(0, 12) }));

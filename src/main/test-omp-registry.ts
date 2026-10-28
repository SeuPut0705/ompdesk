/**
 * Test-only npm registry for `@oh-my-pi/pi-coding-agent`: real tarballs (ustar,
 * gzip) a real `bun install -g` accepts, served from 127.0.0.1 with the
 * packument (`/<pkg>`, `dist-tags.latest` read on every request) and the
 * tarballs (`/tarballs/<version>.tgz`). The registry lives in the calling
 * process, so callers spawn installers asynchronously, never with a blocking
 * spawn that would starve it.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { OMP_PACKAGE } from "./setup/plans";

export interface OmpRelease {
	version: string;
	/** `engines` of the release's manifest, in the tarball and the packument alike. */
	engines?: Record<string, string>;
	tarball: Buffer;
	integrity: string;
	shasum: string;
}

/** One file of a ustar archive: header, data, padding to the 512-byte block. */
export function tarEntry(name: string, data: Buffer, mode: number): Buffer[] {
	const header = Buffer.alloc(512);
	header.write(name, 0, "utf8");
	header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
	header.write("0000000\0", 108);
	header.write("0000000\0", 116);
	header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
	header.write("00000000000\0", 136);
	header.write("        ", 148);
	header.write("0", 156);
	header.write("ustar\0", 257);
	header.write("00", 263);
	const sum = header.reduce((total, byte) => total + byte, 0);
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return [header, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}

/**
 * A release of the package with stock's bin layout (`bin: {omp: "dist/cli.js"}`): `cli` is the launcher's
 * source (a `#!/usr/bin/env bun` script), `files` any further package files (path → text), `engines` its
 * manifest's engines (stock names the oldest Bun it runs on there).
 */
export function ompRelease(
	version: string,
	cli: string,
	files: Record<string, string> = {},
	engines?: Record<string, string>,
): OmpRelease {
	const manifest = JSON.stringify({
		name: OMP_PACKAGE,
		version,
		bin: { omp: "dist/cli.js" },
		files: ["dist", "src"],
		...(engines ? { engines } : {}),
	});
	const entries: [string, string, number][] = [
		["package.json", manifest, 0o644],
		["dist/cli.js", cli, 0o755],
		...Object.entries(files).map(([name, text]): [string, string, number] => [name, text, 0o644]),
	];
	const blocks = entries.flatMap(([name, text, mode]) => tarEntry(`package/${name}`, Buffer.from(text), mode));
	const tarball = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
	return {
		version,
		...(engines ? { engines } : {}),
		tarball,
		integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
		shasum: createHash("sha1").update(tarball).digest("hex"),
	};
}

export interface OmpRegistry {
	/** Base URL with a trailing slash (`BUN_CONFIG_REGISTRY`). */
	url: string;
	close: () => Promise<void>;
}

/** Serve `releases`; `latest()` is the `latest` dist-tag at each request. */
export async function ompRegistry(releases: OmpRelease[], latest: () => string): Promise<OmpRegistry> {
	const server = createServer((request, response) => {
		const url = decodeURIComponent(request.url ?? "");
		const origin = `http://${request.headers.host}`;
		if (url === `/${OMP_PACKAGE}`) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					name: OMP_PACKAGE,
					"dist-tags": { latest: latest() },
					versions: Object.fromEntries(
						releases.map(entry => [
							entry.version,
							{
								name: OMP_PACKAGE,
								version: entry.version,
								bin: { omp: "dist/cli.js" },
								...(entry.engines ? { engines: entry.engines } : {}),
								dist: {
									tarball: `${origin}/tarballs/${entry.version}.tgz`,
									integrity: entry.integrity,
									shasum: entry.shasum,
								},
							},
						]),
					),
				}),
			);
			return;
		}
		const found = releases.find(entry => url === `/tarballs/${entry.version}.tgz`);
		if (found) {
			response.writeHead(200, {
				"content-type": "application/octet-stream",
				"content-length": found.tarball.length,
			});
			response.end(found.tarball);
			return;
		}
		response.writeHead(404).end();
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}/`,
		close: () => {
			const closed = Promise.withResolvers<void>();
			server.closeAllConnections();
			server.close(() => closed.resolve());
			return closed.promise;
		},
	};
}

/**
 * Test-only npm registry for arbitrary packages: real tarballs (ustar, gzip) a real `bun install` accepts,
 * served from 127.0.0.1 with the packument (`/<pkg>`, scoped names as `@scope%2fname`) and the tarballs
 * (`/tarballs/<pkg>/<version>.tgz`). Packages and dist-tags change while it runs (`publish`, `setTag`), so a
 * test can release a new version between a check and an upgrade. Lives in the calling process: spawn
 * installers asynchronously, never with a blocking spawn that would starve it.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { tarEntry } from "./test-omp-registry";

interface PublishedVersion {
	manifest: Record<string, unknown>;
	tarball: Buffer;
	integrity: string;
	shasum: string;
}

interface PublishedPackage {
	versions: Map<string, PublishedVersion>;
	distTags: Map<string, string>;
}

export interface PublishOptions {
	/** Extra `package.json` fields (`omp: {…}` for a plugin manifest, `description`, …). */
	manifest?: Record<string, unknown>;
	/** Further package files (path → text). */
	files?: Record<string, string>;
	/** Dist-tag to point at this version; `latest` by default, `null` for none. */
	tag?: string | null;
}

export interface NpmRegistry {
	/** Base URL with a trailing slash (`BUN_CONFIG_REGISTRY`, `npm_config_registry`). */
	url: string;
	/** Publish `name@version`; by default `latest` moves to it. */
	publish: (name: string, version: string, options?: PublishOptions) => void;
	setTag: (name: string, tag: string, version: string) => void;
	/** Request paths served so far, for tests that assert what was (not) fetched. */
	requests: string[];
	close: () => Promise<void>;
}

function buildVersion(name: string, version: string, options: PublishOptions): PublishedVersion {
	const manifest = { ...options.manifest, name, version };
	const entries: [string, string][] = [
		["package.json", JSON.stringify(manifest)],
		...Object.entries(options.files ?? {}),
	];
	const blocks = entries.flatMap(([file, text]) => tarEntry(`package/${file}`, Buffer.from(text), 0o644));
	const tarball = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
	return {
		manifest,
		tarball,
		integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
		shasum: createHash("sha1").update(tarball).digest("hex"),
	};
}

export async function npmRegistry(): Promise<NpmRegistry> {
	const packages = new Map<string, PublishedPackage>();
	const requests: string[] = [];
	const server = createServer((request, response) => {
		const url = decodeURIComponent(request.url ?? "");
		requests.push(url);
		const origin = `http://${request.headers.host}`;
		const tarball = /^\/tarballs\/(.+)\/([^/]+)\.tgz$/.exec(url);
		if (tarball) {
			const found = packages.get(tarball[1] ?? "")?.versions.get(tarball[2] ?? "");
			if (!found) {
				response.writeHead(404).end();
				return;
			}
			response.writeHead(200, {
				"content-type": "application/octet-stream",
				"content-length": found.tarball.length,
			});
			response.end(found.tarball);
			return;
		}
		const name = url.slice(1);
		const published = packages.get(name);
		if (!published) {
			response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				name,
				"dist-tags": Object.fromEntries(published.distTags),
				versions: Object.fromEntries(
					[...published.versions].map(([version, entry]) => [
						version,
						{
							...entry.manifest,
							dist: {
								tarball: `${origin}/tarballs/${name}/${version}.tgz`,
								integrity: entry.integrity,
								shasum: entry.shasum,
							},
						},
					]),
				),
			}),
		);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}/`,
		requests,
		publish: (name, version, options = {}) => {
			const published = packages.get(name) ?? { versions: new Map(), distTags: new Map() };
			packages.set(name, published);
			published.versions.set(version, buildVersion(name, version, options));
			const tag = options.tag === undefined ? "latest" : options.tag;
			if (tag !== null) published.distTags.set(tag, version);
		},
		setTag: (name, tag, version) => {
			packages.get(name)?.distTags.set(tag, version);
		},
		close: () => {
			const closed = Promise.withResolvers<void>();
			server.closeAllConnections();
			server.close(() => closed.resolve());
			return closed.promise;
		},
	};
}

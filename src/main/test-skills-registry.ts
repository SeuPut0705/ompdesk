/**
 * Test-only Skillshare registry (the wire contract of `@oh-my-pi/pi-wire/skillshare`): packument, version
 * manifest and tarball routes for `@scope/name` packages, with real gzip tarballs and SRI integrity so the
 * stock installer (`skillshare/installer.ts`) installs from it. Versions publish while it runs; a version
 * with `scripts` carries an executable file, which stock asks a person to approve before installing it.
 * Lives in the calling process: spawn the stock side asynchronously.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { tarEntry } from "./test-omp-registry";

interface PublishedSkill {
	version: string;
	tarball: Buffer;
	integrity: string;
	files: Array<{ path: string; size: number; sha256: string; executable: boolean }>;
	hasScripts: boolean;
	yanked: boolean;
}

export interface SkillPublishOptions {
	/** Ship `scripts/run.sh` (executable): installing it needs approval. */
	scripts?: boolean;
	/** Dist-tag to move to this version; `latest` by default, `null` for none. */
	tag?: string | null;
}

export interface SkillsRegistry {
	/** Base URL without a trailing slash (`skills.registryUrl`). */
	url: string;
	publish: (scope: string, name: string, version: string, options?: SkillPublishOptions) => void;
	close: () => Promise<void>;
}

const USER = { username: "tester", avatar: "00" };

function buildSkill(name: string, version: string, scripts: boolean): PublishedSkill {
	const entries: Array<[string, string, number]> = [
		["SKILL.md", `---\nname: ${name}\ndescription: ${name} ${version}\n---\n${name} ${version}\n`, 0o644],
	];
	if (scripts) entries.push(["scripts/run.sh", "#!/bin/sh\necho hi\n", 0o755]);
	const blocks = entries.flatMap(([file, text, mode]) => tarEntry(file, Buffer.from(text), mode));
	const tarball = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
	return {
		version,
		tarball,
		integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
		files: entries.map(([file, text, mode]) => ({
			path: file,
			size: Buffer.byteLength(text),
			sha256: createHash("sha256").update(text).digest("hex"),
			executable: mode === 0o755,
		})),
		hasScripts: scripts,
		yanked: false,
	};
}

function summary(skill: PublishedSkill) {
	return {
		version: skill.version,
		publishedAt: 0,
		publisher: USER,
		integrity: skill.integrity,
		size: skill.tarball.length,
		unpackedSize: skill.files.reduce((total, file) => total + file.size, 0),
		fileCount: skill.files.length,
		hasScripts: skill.hasScripts,
		yanked: skill.yanked,
	};
}

export async function skillsRegistry(): Promise<SkillsRegistry> {
	const packages = new Map<string, { versions: Map<string, PublishedSkill>; distTags: Map<string, string> }>();
	const server = createServer((request, response) => {
		const url = decodeURIComponent((request.url ?? "").split("?")[0] ?? "");
		const route = /^\/api\/v1\/skills\/(@[^/]+\/[^/]+)(?:\/versions\/([^/]+)(\/tarball)?)?$/.exec(url);
		const published = route ? packages.get(route[1] ?? "") : undefined;
		const json = (status: number, body: unknown) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		};
		if (!route || !published) return json(404, { error: "not found" });
		const [, id, version, tarball] = route;
		const [scope, name] = (id ?? "").slice(1).split("/");
		if (!version) {
			return json(200, {
				scope,
				name,
				description: name,
				keywords: [],
				owners: [USER],
				distTags: Object.fromEntries(published.distTags),
				versions: Object.fromEntries([...published.versions].map(([v, skill]) => [v, summary(skill)])),
				createdAt: 0,
				updatedAt: 0,
				downloads: { weekly: 0, total: 0, daily: [] },
				canManage: false,
			});
		}
		const skill = published.versions.get(published.distTags.get(version) ?? version);
		if (!skill) return json(404, { error: "no such version" });
		if (tarball) {
			response.writeHead(200, { "content-type": "application/gzip", "content-length": skill.tarball.length });
			response.end(skill.tarball);
			return;
		}
		return json(200, {
			...summary(skill),
			scope,
			name,
			description: name,
			metadata: {},
			keywords: [],
			files: skill.files,
			readmePath: "SKILL.md",
			provenance: { publisher: USER, viaToken: false },
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		publish: (scope, name, version, options = {}) => {
			const id = `@${scope}/${name}`;
			const entry = packages.get(id) ?? { versions: new Map(), distTags: new Map() };
			packages.set(id, entry);
			entry.versions.set(version, buildSkill(name, version, options.scripts === true));
			const tag = options.tag === undefined ? "latest" : options.tag;
			if (tag !== null) entry.distTags.set(tag, version);
		},
		close: () => {
			const closed = Promise.withResolvers<void>();
			server.closeAllConnections();
			server.close(() => closed.resolve());
			return closed.promise;
		},
	};
}

/**
 * The previous builds' hashed `/assets/` files, served for a while after this computer updated OMPdesk, so a
 * paired page loaded before the update still finds the chunks it asks for.
 *
 * Why: a phone keeps its page open for hours, and its service worker boots the cached shell of the build it was
 * installed with; the new build's renderer folder no longer has that build's lazy chunks (the side panel's views, a
 * language, Settings, a dialog), so a lazy import failed ("Importing a module script failed.", v0.38.1) and the page
 * crashed. Every `/assets/` name carries its content hash, so serving an older build's file by name can only ever
 * serve exactly that file.
 *
 * How: at each start the server's build (`buildIdOf`, the hash of its `web.html`) is copied once into
 * `<userData>/web-assets/<build>/assets/` (an atomic rename of a `.partial` folder; about 15 MB). The builds that
 * stopped being current are kept for `ARCHIVE_RETAIN_MS` after they were replaced, `ARCHIVE_MAX_PREVIOUS` at most,
 * newest first, and `roots()` lists them for the server (server.ts serves a missing `/assets/` file from them).
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readJson, writeSecureJson } from "../remote/secure-file";

/** How long a replaced build's assets stay served. */
export const ARCHIVE_RETAIN_MS = 7 * 24 * 60 * 60_000;
/** How many replaced builds are kept at most. */
export const ARCHIVE_MAX_PREVIOUS = 2;

const BUILD = /^[0-9a-f]{12}$/;
const INDEX_FILE = "builds.json";
const Index = z.object({
	v: z.literal(1),
	builds: z.array(z.object({ build: z.string().regex(BUILD), replacedAt: z.number().nullable() })),
});
type ArchivedBuild = z.infer<typeof Index>["builds"][number];
type ReplacedBuild = { build: string; replacedAt: number };

/** The build a renderer folder holds: the hash of its `web.html` (it names that build's entry chunks); null without one. */
export async function buildIdOf(staticRoot: string): Promise<string | null> {
	try {
		const page = await fsp.readFile(join(staticRoot, "web.html"));
		return createHash("sha256").update(page).digest("hex").slice(0, 12);
	} catch {
		return null;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await fsp.access(path);
		return true;
	} catch {
		return false;
	}
}

export class AssetArchive {
	readonly #dir: string;
	readonly #now: () => number;
	#roots: readonly string[] = [];
	#queue: Promise<void> = Promise.resolve();

	constructor(dir: string, now: () => number = Date.now) {
		this.#dir = dir;
		this.#now = now;
	}

	/** Folders holding a replaced build's `assets/`, newest first: where a missing `/assets/` file is looked for. */
	roots(): readonly string[] {
		return this.#roots;
	}

	/**
	 * Keep the build in `staticRoot` for later (copied once), mark the others replaced, drop what is past the window or
	 * the count, and serve the rest. Never throws for a missing renderer folder (a dev run has none). Calls run one
	 * after another: a second call's copy is never swept away by the first call's cleanup.
	 */
	retain(staticRoot: string): Promise<void> {
		const run = this.#queue.then(() => this.#retain(staticRoot));
		this.#queue = run.catch(() => {});
		return run;
	}

	async #retain(staticRoot: string): Promise<void> {
		const current = await buildIdOf(staticRoot);
		if (!current) return;
		const now = this.#now();
		const stored = Index.safeParse(readJson(join(this.#dir, INDEX_FILE)));
		const previous: ReplacedBuild[] = (stored.success ? stored.data.builds : [])
			.filter(entry => entry.build !== current)
			.map(entry => ({ build: entry.build, replacedAt: entry.replacedAt ?? now }))
			.filter(entry => now - entry.replacedAt < ARCHIVE_RETAIN_MS)
			.sort((a, b) => b.replacedAt - a.replacedAt)
			.slice(0, ARCHIVE_MAX_PREVIOUS);
		const kept: ReplacedBuild[] = [];
		for (const entry of previous) {
			if (await exists(join(this.#dir, entry.build, "assets"))) kept.push(entry);
		}
		const copied = await this.#copy(staticRoot, current);
		const builds: ArchivedBuild[] = [...kept, ...(copied ? [{ build: current, replacedAt: null }] : [])];
		writeSecureJson(join(this.#dir, INDEX_FILE), { v: 1, builds });
		const keep = new Set([INDEX_FILE, current, ...kept.map(entry => entry.build)]);
		for (const name of await fsp.readdir(this.#dir).catch(() => [] as string[])) {
			if (!keep.has(name)) await fsp.rm(join(this.#dir, name), { recursive: true, force: true });
		}
		this.#roots = kept.map(entry => join(this.#dir, entry.build));
	}

	/** This build's assets, copied once; false when they could not be (the build is then not kept). */
	async #copy(staticRoot: string, build: string): Promise<boolean> {
		const target = join(this.#dir, build);
		if (await exists(join(target, "assets"))) return true;
		const partial = `${target}.partial`;
		try {
			await fsp.rm(partial, { recursive: true, force: true });
			await fsp.mkdir(join(partial, "assets"), { recursive: true });
			const source = join(staticRoot, "assets");
			for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
				if (entry.isFile()) await fsp.copyFile(join(source, entry.name), join(partial, "assets", entry.name));
			}
			await fsp.rename(partial, target);
			return true;
		} catch {
			await fsp.rm(partial, { recursive: true, force: true }).catch(() => {});
			return false;
		}
	}
}

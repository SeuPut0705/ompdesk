import path from "node:path";
import { parseCover } from "./covers";
import { isRecord } from "./json";

export interface ModelEntry {
	id: string;
	title?: string;
	kind: "tla" | "lean";
	/** Folder of the model, relative to the manifest's folder. */
	dir: string;
	/** TLA+: the spec file in `dir`. */
	spec?: string;
	/** Lean: the file mutations start from, in `dir` (default: none, so no mutation run). */
	model?: string;
	/** TLA+ without a matrix: configs that must pass. */
	configs?: string[];
	matrix?: string;
	mutations?: string;
	/** Lean: the lake project folder inside `dir`. */
	project?: string;
	/**
	 * Code the model describes, relative to the code root: a file or folder (`src/a.ts`), one function, method or class
	 * (`src/a.ts#sync`, `src/a.ts#Pool.sync`) or a line range (`src/a.ts:120-180`; working-tree lines).
	 */
	covers: string[];
	/** The commit at which the model was last confirmed to describe `covers`. */
	syncCommit: string | null;
	/** Set by `--stamp --allow-dirty`: digest of the covered code stamped on top of `syncCommit` with uncommitted changes. */
	syncDiff?: string;
	/** `fast` (every PR and the inner loop) or `deep` (scheduled runs). Default: `deep` for an id ending in `-deep`, else `fast`. */
	tier?: "fast" | "deep";
	verifySkill?: string;
}

/** A model's tier: its `tier`, else `deep` for an id ending in `-deep` (the old convention), else `fast`. */
export function tierOf(model: Pick<ModelEntry, "id" | "tier">): "fast" | "deep" {
	return model.tier ?? (model.id.endsWith("-deep") ? "deep" : "fast");
}

export interface Manifest {
	version: 1;
	/** Relative to the manifest's folder; default `..`. */
	codeRoot: string;
	models: ModelEntry[];
}

function text(value: unknown, where: string): string {
	if (typeof value !== "string" || value === "") throw new Error(`manifest: ${where} must be a non-empty string`);
	return value;
}

function optional(value: unknown, where: string): string | undefined {
	return value === undefined ? undefined : text(value, where);
}

/** A path in the manifest stays inside its base folder: no absolute paths, no `..` segments. */
function inside(value: string, where: string): string {
	if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
		throw new Error(`manifest: ${where} (${value}) must be a relative path without ..`);
	}
	return value;
}

export function parseManifest(input: unknown): Manifest {
	if (!isRecord(input) || input.version !== 1) throw new Error('manifest: "version" must be 1');
	if (!Array.isArray(input.models) || input.models.length === 0)
		throw new Error('manifest: "models" must be a non-empty array');
	const ids: string[] = [];
	const models = input.models.map((entry: unknown, index: number): ModelEntry => {
		const where = `models[${index}]`;
		if (!isRecord(entry)) throw new Error(`manifest: ${where} must be an object`);
		const id = text(entry.id, `${where}.id`);
		if (ids.includes(id)) throw new Error(`manifest: duplicate model id ${id}`);
		ids.push(id);
		if (entry.kind !== "tla" && entry.kind !== "lean")
			throw new Error(`manifest: ${where}.kind must be "tla" or "lean"`);
		const kind = entry.kind;
		const spec = optional(entry.spec, `${where}.spec`);
		if (kind === "tla" && !spec) throw new Error(`manifest: ${where}.spec is required for a tla model`);
		const configs =
			entry.configs === undefined
				? undefined
				: Array.isArray(entry.configs)
					? entry.configs.map((config, i) => text(config, `${where}.configs[${i}]`))
					: (() => {
							throw new Error(`manifest: ${where}.configs must be an array`);
						})();
		const covers =
			entry.covers === undefined
				? []
				: Array.isArray(entry.covers)
					? entry.covers.map((item, i) => {
							const raw = text(item, `${where}.covers[${i}]`);
							let cover: ReturnType<typeof parseCover>;
							try {
								cover = parseCover(raw);
							} catch (error) {
								throw new Error(`manifest: ${where}.covers[${i}]: ${error instanceof Error ? error.message : String(error)}`);
							}
							inside(cover.path, `${where}.covers[${i}]`);
							return raw;
						})
					: (() => {
							throw new Error(`manifest: ${where}.covers must be an array`);
						})();
		const sync = entry.syncCommit;
		if (sync !== undefined && sync !== null && (typeof sync !== "string" || !/^[0-9a-f]{7,64}$/i.test(sync))) {
			throw new Error(`manifest: ${where}.syncCommit must be a git commit hash or null`);
		}
		if (entry.tier !== undefined && entry.tier !== "fast" && entry.tier !== "deep")
			throw new Error(`manifest: ${where}.tier must be "fast" or "deep"`);
		if (entry.syncDiff !== undefined && (typeof entry.syncDiff !== "string" || !/^[0-9a-f]{64}$/.test(entry.syncDiff)))
			throw new Error(`manifest: ${where}.syncDiff must be the 64-hex digest --stamp --allow-dirty wrote`);
		const optionalPaths = ["dir", "spec", "model", "matrix", "mutations", "project", "verifySkill"] as const;
		const model: ModelEntry = {
			id,
			kind,
			dir: inside(text(entry.dir, `${where}.dir`), `${where}.dir`),
			covers,
			syncCommit: typeof sync === "string" ? sync : null,
		};
		for (const key of optionalPaths) {
			const value = optional(entry[key], `${where}.${key}`);
			if (value !== undefined && key !== "dir")
				(model as unknown as Record<string, unknown>)[key] =
					key === "verifySkill" ? value : inside(value, `${where}.${key}`);
		}
		if (typeof entry.title === "string") model.title = entry.title;
		if (typeof entry.syncDiff === "string") model.syncDiff = entry.syncDiff;
		if (entry.tier !== undefined) model.tier = entry.tier;
		if (configs) model.configs = configs.map(config => inside(config, `${where}.configs`));
		return model;
	});
	return {
		version: 1,
		codeRoot: typeof input.codeRoot === "string" ? input.codeRoot : "..",
		models,
	};
}

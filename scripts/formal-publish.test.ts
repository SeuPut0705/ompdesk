import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RawManifest, publish } from "./formal-publish";

describe("publishing a formal stamp onto a branch head", () => {
	let repo: string;
	const git = (...args: string[]) => {
		const out = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
		if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
		return out.stdout.trim();
	};
	const file = (name: string, text: string) => {
		fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
		fs.writeFileSync(path.join(repo, name), text);
	};
	const manifest = (): RawManifest => JSON.parse(fs.readFileSync(path.join(repo, "formal/manifest.json"), "utf8"));
	const writeManifest = (value: RawManifest) => file("formal/manifest.json", `${JSON.stringify(value, null, "\t")}\n`);
	const commit = (message: string) => {
		git("add", "-A");
		git("commit", "-q", "-m", message);
		return git("rev-parse", "HEAD");
	};
	let verifiedSha: string;
	let verifiedFile: string;

	beforeEach(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "formal-publish-"));
		git("init", "-q");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");
		file("src/a.ts", "export const a = 1;\n");
		file("formal/m/tla/M.cfg", "INVARIANT Inv\n");
		writeManifest({
			codeRoot: "..",
			models: [{ id: "m", dir: "m/tla", covers: ["src/a.ts"], matrix: "matrix.json", syncCommit: null }],
		});
		verifiedSha = commit("verified");
		verifiedFile = path.join(repo, "verified.json");
		const stamped = manifest();
		(stamped.models[0] as { syncCommit: string }).syncCommit = verifiedSha;
		fs.writeFileSync(verifiedFile, JSON.stringify(stamped));
	});
	afterEach(() => fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

	it("stamps a model nothing changed under, whatever else landed on the branch", async () => {
		file("src/other.ts", "export const other = 1;\n");
		commit("unrelated");
		const out = await publish(repo, verifiedFile, verifiedSha);
		expect(out).toEqual({ stamped: ["m"], refused: [] });
		expect(manifest().models[0]?.syncCommit).toBe(verifiedSha);
	});

	it("refuses when the covered code changed meanwhile", async () => {
		file("src/a.ts", "export const a = 2;\n");
		commit("code");
		expect(await publish(repo, verifiedFile, verifiedSha)).toEqual({ stamped: [], refused: ["m"] });
		expect(manifest().models[0]?.syncCommit).toBeNull();
	});

	it("refuses when the model's config changed and the covered code did not", async () => {
		file("formal/m/tla/M.cfg", "INVARIANT Inv2\n");
		commit("cfg");
		expect(await publish(repo, verifiedFile, verifiedSha)).toEqual({ stamped: [], refused: ["m"] });
	});

	it("refuses when the model's manifest definition changed and the covered code did not", async () => {
		const changed = manifest();
		(changed.models[0] as { matrix: string }).matrix = "deep.json";
		writeManifest(changed);
		commit("matrix");
		expect(await publish(repo, verifiedFile, verifiedSha)).toEqual({ stamped: [], refused: ["m"] });
	});

	it("keeps another model's stamp from the head", async () => {
		const head = manifest();
		head.models.push({ id: "n", dir: "n/tla", covers: [], syncCommit: "abc" });
		writeManifest(head);
		file("formal/n/tla/N.cfg", "x\n");
		commit("second model");
		await publish(repo, verifiedFile, verifiedSha);
		expect(manifest().models.map(model => [model.id, model.syncCommit])).toEqual([
			["m", verifiedSha],
			["n", "abc"],
		]);
	});
});

// Publishes the stamps a formal.yml verification made onto the branch's current head.
//   bun scripts/formal-publish.ts <verified manifest.json> <verified sha> [--ids-out <file>]
// Run inside a checkout of the branch head. A model's stamp (the entries the verified manifest changed against its
// own commit) is written into the head's formal/manifest.json only when what the verification saw is unchanged at
// the head: the model's covered code (`checkDrift`, verify-all's own comparison) and the model itself (its folder's
// files and its manifest entry, the stamp fields aside). Otherwise the stamp would say "checked" for something the
// verification never ran. Exit 0: every stamp written or nothing to stamp; 1: a model was refused.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkDrift, git } from "../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/drift";

export interface Entry {
	id: string;
	dir?: string;
	covers?: string[];
	syncCommit?: string | null;
	syncDiff?: string;
	[key: string]: unknown;
}
export interface RawManifest {
	codeRoot?: string;
	models: Entry[];
}

export const MANIFEST = "formal/manifest.json";
const STAMP_FIELDS = new Set(["syncCommit", "syncDiff"]);

const stampKey = (entry: Entry | undefined) => JSON.stringify([entry?.syncCommit ?? null, entry?.syncDiff ?? null]);

/** One digest of everything a verification of `entry` reads: its folder's blobs at `commit` and its entry minus the stamp. */
export async function modelDigest(repo: string, commit: string, entry: Entry): Promise<string | null> {
	const tree = await git(repo, ["ls-tree", "-r", commit, "--", `formal/${entry.dir ?? entry.id}`]);
	if (!tree.ok) return null;
	const definition = Object.entries(entry).filter(([name]) => !STAMP_FIELDS.has(name));
	return createHash("sha256")
		.update(`${tree.out}\n${JSON.stringify(definition)}`)
		.digest("hex");
}

export interface Published {
	stamped: string[];
	refused: string[];
}

/** Writes the verified stamps into `<repo>/formal/manifest.json` (the head) where the verification still holds. */
export async function publish(repo: string, verifiedFile: string, verifiedSha: string): Promise<Published> {
	const manifestFile = path.join(repo, MANIFEST);
	const read = (file: string): RawManifest => JSON.parse(fs.readFileSync(file, "utf8")) as RawManifest;
	const verified = read(verifiedFile);
	const head = read(manifestFile);
	const codeRoot = path.resolve(path.dirname(manifestFile), head.codeRoot ?? ".");
	const base = await git(repo, ["show", `${verifiedSha}:${MANIFEST}`]);
	if (!base.ok) throw new Error(`cannot read ${MANIFEST} at ${verifiedSha}: ${base.err}`);
	const atVerified = JSON.parse(base.raw) as RawManifest;

	const result: Published = { stamped: [], refused: [] };
	const refuse = (id: string, why: string) => {
		console.log(`refused ${id}: ${why}`);
		result.refused.push(id);
	};
	for (const entry of verified.models) {
		if (stampKey(entry) === stampKey(atVerified.models.find(candidate => candidate.id === entry.id))) continue;
		const target = head.models.find(candidate => candidate.id === entry.id);
		if (!target) {
			refuse(entry.id, "no longer in the branch's manifest");
			continue;
		}
		const [then, now] = await Promise.all([modelDigest(repo, verifiedSha, entry), modelDigest(repo, "HEAD", target)]);
		if (!then || then !== now) {
			refuse(entry.id, "model changed since verification, rerun");
			continue;
		}
		const drift = await checkDrift(codeRoot, entry.covers ?? [], verifiedSha, entry.syncDiff);
		if (drift.status !== "ok") {
			refuse(entry.id, `covered code changed since verification, rerun (${drift.message})`);
			continue;
		}
		target.syncCommit = entry.syncCommit;
		if (entry.syncDiff) target.syncDiff = entry.syncDiff;
		else delete target.syncDiff;
		result.stamped.push(entry.id);
		console.log(`stamped ${entry.id}: ${entry.syncCommit}`);
	}
	if (result.stamped.length) fs.writeFileSync(manifestFile, `${JSON.stringify(head, null, "\t")}\n`);
	return result;
}

if (import.meta.main) {
	const [verifiedFile, verifiedSha, ...rest] = process.argv.slice(2);
	if (!verifiedFile || !verifiedSha) {
		console.error("usage: bun scripts/formal-publish.ts <verified manifest.json> <verified sha> [--ids-out <file>]");
		process.exit(2);
	}
	const { stamped, refused } = await publish(process.cwd(), verifiedFile, verifiedSha);
	if (rest[0] === "--ids-out" && rest[1]) fs.writeFileSync(rest[1], stamped.join(","));
	process.exit(refused.length ? 1 : 0);
}

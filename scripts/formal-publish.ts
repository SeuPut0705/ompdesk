// Publishes the stamps a formal.yml verification made onto the branch's current head.
//   bun scripts/formal-publish.ts <verified manifest.json> <verified sha> [--ids-out <file>]
// Run inside a checkout of the branch head. A model's stamp (the entries the verified manifest changed against its
// own commit) is written into the head's formal/manifest.json only when the model's covered code is the same at the
// head as at the verified sha (`checkDrift`, verify-all's own comparison), so a stamp never says "checked against
// code" the verification did not see. Exit 0: every stamp written or nothing to stamp; 1: a model was refused.
import fs from "node:fs";
import path from "node:path";
import { checkDrift, git } from "../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/drift";

interface Entry {
	id: string;
	covers?: string[];
	syncCommit?: string | null;
	syncDiff?: string;
}
interface RawManifest {
	codeRoot?: string;
	models: Entry[];
}

const MANIFEST = "formal/manifest.json";

const [verifiedFile, verifiedSha, ...rest] = process.argv.slice(2);
if (!verifiedFile || !verifiedSha) {
	console.error("usage: bun scripts/formal-publish.ts <verified manifest.json> <verified sha> [--ids-out <file>]");
	process.exit(2);
}
const idsOut = rest[0] === "--ids-out" ? rest[1] : undefined;

const read = (file: string): RawManifest => JSON.parse(fs.readFileSync(file, "utf8")) as RawManifest;
const verified = read(verifiedFile);
const head = read(MANIFEST);
const codeRoot = path.resolve(path.dirname(MANIFEST), head.codeRoot ?? ".");

const base = await git(codeRoot, ["show", `${verifiedSha}:${MANIFEST}`]);
if (!base.ok) {
	console.error(`cannot read ${MANIFEST} at ${verifiedSha}: ${base.err}`);
	process.exit(1);
}
const atVerified = JSON.parse(base.raw) as RawManifest;
const key = (entry: Entry | undefined) => JSON.stringify([entry?.syncCommit ?? null, entry?.syncDiff ?? null]);

const stamped: string[] = [];
let refused = 0;
for (const entry of verified.models) {
	if (key(entry) === key(atVerified.models.find(candidate => candidate.id === entry.id))) continue;
	const target = head.models.find(candidate => candidate.id === entry.id);
	if (!target) {
		console.log(`refused ${entry.id}: no longer in the branch's manifest`);
		refused++;
		continue;
	}
	const drift = await checkDrift(codeRoot, entry.covers ?? [], verifiedSha, entry.syncDiff);
	if (drift.status !== "ok") {
		console.log(`refused ${entry.id}: covered code changed since verification, rerun (${drift.message})`);
		refused++;
		continue;
	}
	target.syncCommit = entry.syncCommit;
	if (entry.syncDiff) target.syncDiff = entry.syncDiff;
	else delete target.syncDiff;
	stamped.push(entry.id);
	console.log(`stamped ${entry.id}: ${entry.syncCommit}`);
}
if (stamped.length) fs.writeFileSync(MANIFEST, `${JSON.stringify(head, null, "\t")}\n`);
if (idsOut) fs.writeFileSync(idsOut, stamped.join(","));
process.exit(refused ? 1 : 0);

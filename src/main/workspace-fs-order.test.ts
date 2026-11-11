/**
 * The core sorts listings with ICU4X's collation; the TypeScript it replaced sorted with the JavaScript engine's ICU
 * (`Intl.Collator(locale, { numeric: true })`), and the file cap cuts by that order. Both must agree on awkward names.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { core } from "./core/process";
import { listWorkspace } from "./workspace-fs";

/** Distinct on a case- and normalization-insensitive disk, none hidden. */
const NAMES = [
	"file-2",
	"file-10",
	"file-010",
	"file-1",
	"File-3",
	"1",
	"01",
	"001",
	"9",
	"10",
	"1.2.10",
	"1.2.9",
	"v1.10",
	"v1.9",
	"apple",
	"Banana",
	"bananas",
	"zebra",
	"Zürich",
	"zz",
	"_under",
	"-dash",
	"~tilde",
	"(paren)",
	"[bracket]",
	"#hash",
	"a b",
	"a_b",
	"a-b",
	"a.b",
	"file (copy)",
	"file copy",
	"가",
	"가나",
	"나다",
	"한글10",
	"한글9",
	"café",
	"cafe",
	"résumé",
	"resume",
	"naïve",
	"Ångström",
	"Ωmega",
	"αβγ",
	"日本",
	"x²",
	"😀",
	"😀1",
	"🚀",
];

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "workspace-fs-order-"));
	mkdirSync(join(root, "files"));
	for (const name of NAMES) {
		mkdirSync(join(root, "dirs", name), { recursive: true });
		writeFileSync(join(root, "files", name), "", { flag: "a" });
	}
}, 30_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * Names ICU ranks equal (`1`, `01`, `001` with numeric runs on) keep the order they had, which for both the old
 * TypeScript and the core is the folder's own: the expectation sorts what node's readdir gives.
 */
const sortedAsJavaScript = (folder: string, locale: string | undefined): string[] =>
	readdirSync(join(root, folder)).sort(new Intl.Collator(locale, { numeric: true }).compare);

describe("the core's name order", () => {
	it("is the default Intl.Collator's, through listWorkspace", async () => {
		const listed = await listWorkspace(join(root, "files"), { maxEntries: 1000 });
		expect(listed.entries.map(entry => entry.name)).toEqual(sortedAsJavaScript("files", undefined));
		expect(listed.entries).toHaveLength(NAMES.length);
	});

	it.each(["en-US", "ko", "de", "sv", "tr", "ja"])("is Intl.Collator(%s)'s", async locale => {
		const { result } = await core().call<{ names: string[] }>("fs.listDirs", { dir: join(root, "dirs"), locale });
		expect(result.names).toEqual(sortedAsJavaScript("dirs", locale));
	});
});

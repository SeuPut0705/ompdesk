/** Static runtime-import inventory for the native app cutover; never imports or executes application modules.
 * Run from the checkout root; write stdout to the session scratch folder. This is an inventory, not proof that
 * a domain is native: filesystem-loaded resources, computed imports and embedded worker programs need review.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";

interface SourceFile {
	lines: number;
	imports: string[];
}
interface StaticImport {
	path: string;
}
interface Unresolved {
	file: string;
	target: string;
	error?: string;
}

const root = resolve(import.meta.dir, "../..");
const scanners = {
	ts: new Bun.Transpiler({ loader: "ts" }),
	tsx: new Bun.Transpiler({ loader: "tsx" }),
	js: new Bun.Transpiler({ loader: "js" }),
};
const files = new Map<string, SourceFile>();
const unresolved: Unresolved[] = [];
const externals = new Set<string>();

function locate(base: string): string | null {
	for (const file of [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		`${base}.json`,
		resolve(base, "index.ts"),
		resolve(base, "index.tsx"),
	]) {
		if (existsSync(file) && statSync(file).isFile()) return file;
	}
	return null;
}

const pending = [resolve(root, "src/main/index.ts")];
while (pending.length) {
	const file = pending.pop();
	if (!file) break;
	const name = relative(root, file);
	if (files.has(name)) continue;
	const source = readFileSync(file, "utf8");
	const record: SourceFile = {
		lines: source.split("\n").length - Number(source.endsWith("\n")),
		imports: [],
	};
	files.set(name, record);
	if (extname(file) === ".json") continue;
	let imports: StaticImport[];
	try {
		const scanner = extname(file) === ".tsx" ? scanners.tsx : extname(file) === ".js" ? scanners.js : scanners.ts;
		imports = scanner.scanImports(source);
	} catch (error) {
		unresolved.push({ file: name, target: "<parse>", error: String(error) });
		continue;
	}
	for (const item of imports) {
		const target = item.path;
		let base: string;
		if (target === "electron") base = resolve(root, "src/main/shell-host/electron/index.ts");
		else if (target.startsWith(".")) base = resolve(dirname(file), target.split("?")[0]);
		else {
			externals.add(target);
			continue;
		}
		const imported = locate(base);
		if (!imported) {
			unresolved.push({ file: name, target });
			continue;
		}
		record.imports.push(relative(root, imported));
		if (/\.(ts|tsx|js|json)$/.test(imported)) pending.push(imported);
	}
}

const groups = new Map<string, { files: number; lines: number }>();
for (const [file, info] of files) {
	const parts = file.split("/");
	const group = file.startsWith("src/main/")
		? parts.length > 3
			? parts.slice(0, 3).join("/")
			: "src/main (root)"
		: parts.slice(0, 2).join("/");
	const counts = groups.get(group) ?? { files: 0, lines: 0 };
	counts.files++;
	counts.lines += info.lines;
	groups.set(group, counts);
}
console.log(
	JSON.stringify(
		{
			root: "src/main/index.ts",
			coverage:
				"Static value imports, literal dynamic imports and require; electron aliases the shell shim. Type-only imports excluded. Computed imports, filesystem-loaded resources and embedded worker programs require separate review. Physical lines are not implementation size or a completion metric.",
			groups: Object.fromEntries([...groups].sort()),
			unresolved,
			externals: [...externals].sort(),
			files: Object.fromEntries([...files].sort()),
		},
		null,
		2,
	),
);
if (unresolved.length) process.exitCode = 1;

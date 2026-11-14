import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isOpenableExternalUrl } from "../../src/main/external-url";
import { PRIVACY_PANES, privacyPaneUrl } from "../../src/shared/agent-control";

// The option expressions are copied from ipc.ts SYSTEM_OPEN_DIALOG / SYSTEM_SAVE_DIALOG before Node cutover.
const urls: unknown[] = [
	"https://example.com/a?b=1",
	"http://localhost:3000",
	"mailto:dev@example.com",
	"MAILTO:dev@example.com?subject=Hi%20there",
	"mailto:?subject=Draft",
	"mailto:a\u0085b",
	"mailto:a\uFEFFb",
	"mailto:a\u200Bb",
	"mailto:a\u001Fb",
	"mailto:a b",
	"mailto:",
	"file:///etc/passwd",
	"javascript:alert(1)",
	"vscode://open",
	"HTTPS://example.com",
	" https://example.com",
	42,
	null,
];
const openInputs = [
	{},
	{ filters: [] },
	{ directory: true, title: "Project", buttonLabel: "Choose" },
	{ directory: false, title: "Attach", filters: [{ name: "Text", extensions: ["txt", "md"] }] },
];
const saveInputs = [
	{},
	{ defaultPath: "", filters: [] },
	{ defaultPath: "reply.md", filters: [{ name: "Markdown", extensions: ["md"] }] },
];

function functionSource(file: string, name: string): string {
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const declaration = source.statements.find(
		statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
	);
	if (!declaration) throw new Error(`${name} missing from ${file}`);
	return declaration.getText(source).replace(/^export /, "");
}

const originalPathFunctions = [
	functionSource("src/main/workspace-fs.ts", "resolveWithin"),
	functionSource("src/main/ipc.ts", "existingLocalPath"),
].join("\n");
const originalPathJs = ts.transpileModule(originalPathFunctions, {
	compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText;
const localPath: Array<Record<string, unknown>> = [];
for (const platform of ["posix", "win32"] as const) {
	const paths = path[platform];
	const cwd = platform === "win32" ? "C:\\workspace" : "/workspace";
	const home = platform === "win32" ? "C:\\home" : "/home";
	const existing = [paths.join(cwd, "file.txt"), cwd, home, paths.join(home, "notes.txt")];
	const inputs = [
		{ target: null },
		{ target: 42 },
		{ target: "" },
		{ target: " \n" },
		{ target: "file.txt" },
		{ target: "./dir/../file.txt" },
		{ target: "../sibling/file.txt" },
		{ target: "../workspace/file.txt" },
		{ target: "." },
		{ target: "missing.txt" },
		{ target: "nul\0.txt" },
		{ target: "~/notes.txt" },
		{ target: "~/" },
		{ target: "~//notes.txt" },
		{ target: "~/../workspace/file.txt" },
		{ target: "\uFEFF" },
		{ target: "\u0085" },
		{ target: paths.join(home, "notes.txt") },
		{ target: "file.txt", noWorkspace: true },
		{ target: paths.join(home, "notes.txt"), noWorkspace: true },
		{ target: "", remote: true },
		{ target: paths.join(home, "notes.txt"), remote: true },
		...(platform === "win32"
			? [
					{ target: "C:file.txt" },
					{ target: "\\home\\notes.txt" },
					{ target: "D:file.txt" },
					{ target: "\\\\server\\share\\file.txt" },
				]
			: []),
	];
	for (const input of inputs) {
		const context = { remote: "remote" in input, cwd: "noWorkspace" in input ? null : cwd, home };
		const implementation = runInNewContext(`${originalPathJs}\nexistingLocalPath`, {
			path: paths,
			os: { homedir: () => home },
			targetFor: () => (context.remote ? { device: "paired-host" } : {}),
			cwdFor: () => context.cwd,
			fsp: {
				access: async (target: string) => {
					if (!existing.includes(paths.normalize(target))) throw new Error("ENOENT");
				},
			},
		}) as (deps: object, caller: object, target: unknown) => Promise<unknown>;
		localPath.push({
			platform,
			target: input.target,
			context,
			existing,
			result: await implementation({}, {}, input.target),
		});
	}
}
export const captured = {
	capturedFrom: "16bacf61c",
	localPath,
	externalUrl: urls.map(url => ({ url, allowed: isOpenableExternalUrl(url) })),
	privacyPane: (Object.keys(PRIVACY_PANES) as Array<keyof typeof PRIVACY_PANES>).map(pane => ({
		pane,
		url: privacyPaneUrl(pane),
	})),
	openDialog: openInputs.map(input => {
		const { filters, ...options } = input;
		return {
			input,
			options: {
				properties: options.directory ? ["openDirectory", "createDirectory"] : ["openFile", "multiSelections"],
				filters: filters ?? [],
				title: options.title,
				buttonLabel: options.buttonLabel,
				message: options.title,
			},
		};
	}),
	saveDialog: saveInputs.map(input => ({
		input,
		options: {
			defaultPath: input.defaultPath ?? "session.html",
			filters: input.filters ?? [{ name: "HTML", extensions: ["html"] }],
		},
	})),
};
if (import.meta.main) console.log(JSON.stringify(captured, null, "\t"));

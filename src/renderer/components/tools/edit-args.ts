const PATCH_FILE_HEADER = /^(?:\[([^#\r\n]+)#[0-9A-F]{4}\][^\r\n]*|\*{3} (?:Add|Update|Delete) File: (.+))\r?$/gm;

/** Renderer-only lexical counterpart of node:path.resolve/normalize: stock write
 * exposes details.resolvedPath and edit exposes resolved details.path, while
 * activity arguments may stay relative. No filesystem access or basename guesses. */
export function workFilePathKey(path: string, cwd = ""): string {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
	const windows =
		/^[a-z]:[\\/]/i.test(path) || /^[a-z]:[\\/]/i.test(cwd) || path.startsWith("\\\\") || cwd.startsWith("\\\\");
	const target = windows ? path.replace(/\\/g, "/") : path;
	const base = windows ? cwd.replace(/\\/g, "/") : cwd;
	const absolute = target.startsWith("/") || /^[a-z]:\//i.test(target);
	const rootedDrive =
		windows && target.startsWith("/") && !target.startsWith("//") ? base.match(/^[a-z]:/i)?.[0] : undefined;
	const joined = rootedDrive ? `${rootedDrive}${target}` : absolute || !base ? target : `${base}/${target}`;
	const drive = joined.match(/^[a-z]:/i)?.[0];
	const unc = windows ? joined.match(/^\/\/[^/]+\/[^/]+/)?.[0] : undefined;
	const root = drive ? `${drive.toUpperCase()}/` : unc ? `${unc}/` : joined.startsWith("/") ? "/" : "";
	const body = drive ? joined.slice(2) : unc ? joined.slice(unc.length) : joined;
	const parts: string[] = [];
	for (const part of body.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length && parts.at(-1) !== "..") parts.pop();
			else if (!root) parts.push(part);
		} else parts.push(part);
	}
	return root + parts.join("/");
}

/** Resolve every file named by structured or freeform edit arguments. */
export function editArgumentPaths(args: Record<string, unknown>): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const add = (value: unknown): void => {
		if (typeof value !== "string" || value.length === 0 || seen.has(value)) return;
		seen.add(value);
		paths.push(value);
	};

	add(args.path);
	add(args.file);
	add(args.file_path);
	add(args.filePath);

	if (Array.isArray(args.edits)) {
		for (const edit of args.edits) {
			if (edit == null || typeof edit !== "object") continue;
			const record = edit as Record<string, unknown>;
			add(record.path);
			add(record.file);
			add(record.file_path);
			add(record.filePath);
		}
	}

	const input =
		typeof args.input === "string" ? args.input : typeof args._input === "string" ? args._input : undefined;
	if (input) {
		PATCH_FILE_HEADER.lastIndex = 0;
		for (const match of input.matchAll(PATCH_FILE_HEADER)) add(match[1] ?? match[2]);
	}

	return paths;
}

/** Compact one-line file summary for a collapsed edit card. */
export function editArgumentSummary(args: Record<string, unknown>): string {
	const paths = editArgumentPaths(args);
	if (paths.length === 0) return "";
	return paths.length === 1 ? paths[0] : `${paths[0]} +${paths.length - 1}`;
}

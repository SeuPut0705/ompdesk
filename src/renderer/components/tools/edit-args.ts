const PATCH_FILE_HEADER = /^(?:\[([^#\r\n]+)#[0-9A-F]{4}\][^\r\n]*|\*{3} (?:Add|Update|Delete) File: (.+))\r?$/gm;

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

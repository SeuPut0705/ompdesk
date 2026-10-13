import { asNonEmptyString } from "../../lib/wire-value";

/** A complete `[path#TAG]` header followed by an inline op on the same line (older payloads). */
const HASHLINE_INLINE_HEADER = /^\[([^\r\n#]+)#[0-9A-Fa-f]{4}\]\s/;

const APPLY_PATCH_FILE = /^\*{3} (Add|Update|Delete) File: (.+?)\r?$/;
const APPLY_PATCH_MOVE = /^\*{3} Move to: (.+?)\r?$/;

/** One file a freeform edit `input` targets, with its file-level operation. */
export interface EditInputSection {
	path: string;
	op?: "create" | "delete" | "update";
	rename?: string;
}

/**
 * Renderer counterpart of stock pi-tui `tools/edit.ts` `getHashlineInputSections`
 * (and the header walk behind `getEditInputPaths`), which the renderer cannot import.
 * Tolerant of a payload still streaming: a `[path` header counts before its `#TAG]`
 * arrives, so the call names its file and REM/MV operation without ever showing the
 * edit DSL itself. apply_patch payloads (`*** Add/Update/Delete File:`) keep their
 * envelope headers. Pinned to stock by edit-input-stock.test.ts.
 */
export function editInputSections(input: string): EditInputSection[] {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const sections: EditInputSection[] = [];
	let current: EditInputSection | undefined;
	if (/^\*{3} (?:Add|Update|Delete) File:/m.test(stripped)) {
		for (const line of stripped.split("\n")) {
			const file = APPLY_PATCH_FILE.exec(line);
			if (file?.[1] && file[2]) {
				current = {
					path: file[2].trim(),
					op: file[1] === "Add" ? "create" : file[1] === "Delete" ? "delete" : "update",
				};
				sections.push(current);
				continue;
			}
			const move = APPLY_PATCH_MOVE.exec(line);
			if (current && move?.[1]) current.rename = move[1].trim();
		}
		return sections;
	}
	for (const rawLine of stripped.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const headerPath = hashlineHeaderPath(line);
		if (headerPath) {
			current = { path: headerPath };
			sections.push(current);
			continue;
		}
		if (!current) continue;
		const trimmed = line.trim();
		if (trimmed === "REM") current.op = "delete";
		else if (trimmed.startsWith("MV ")) current.rename = hashlinePreviewPath(trimmed.slice(3));
	}
	return sections;
}

/** Stock `normalizeHashlineInputPreviewPath`: drop the `#TAG` and matching quotes. */
function hashlinePreviewPath(rawPath: string): string {
	const trimmed = rawPath.trim();
	const hashStart = /#[0-9a-fA-F]{4}$/u.exec(trimmed)?.index;
	const withoutHash = hashStart === undefined ? trimmed : trimmed.slice(0, hashStart);
	if (withoutHash.length < 2) return withoutHash;
	const first = withoutHash[0];
	if ((first === '"' || first === "'") && first === withoutHash.at(-1)) return withoutHash.slice(1, -1);
	return withoutHash;
}

/**
 * Stock `parseHashlineInputPreviewHeader`: `[path#TAG]`, tolerant while the bracket streams.
 * Unlike stock it also reads a complete header that carries its op inline (`[a.ts#A1B2] PUT …`),
 * which stock would take as part of the path.
 */
function hashlineHeaderPath(line: string): string | null {
	const trimmed = line.trimEnd();
	if (!trimmed.startsWith("[")) return null;
	const inline = HASHLINE_INLINE_HEADER.exec(trimmed)?.[1];
	if (inline) return hashlinePreviewPath(inline);
	const bodyEnd = trimmed.endsWith("]") ? trimmed.length - 1 : trimmed.length;
	const path = hashlinePreviewPath(trimmed.slice(1, bodyEnd).trim());
	return path.length > 0 ? path : null;
}

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
		// Stock `getEditInputPaths`: every section's file, then its move destination.
		for (const section of editInputSections(input)) {
			add(section.path);
			add(section.rename);
		}
	}

	return paths;
}

/** Compact one-line file summary for a collapsed edit card. */
export function editArgumentSummary(args: Record<string, unknown>): string {
	const paths = editArgumentPaths(args);
	if (paths.length === 0) return "";
	return paths.length === 1 ? paths[0] : `${paths[0]} +${paths.length - 1}`;
}

/** Replace-mode text pair of one edit record (`old_text`/`new_text` and their
 * `old_string`/`oldText` aliases); undefined when the record states neither side. */
export function editTextPair(record: Record<string, unknown>): { oldText?: string; newText?: string } | undefined {
	const oldText =
		asNonEmptyString(record.old_text) ?? asNonEmptyString(record.old_string) ?? asNonEmptyString(record.oldText);
	const newText =
		asNonEmptyString(record.new_text) ?? asNonEmptyString(record.new_string) ?? asNonEmptyString(record.newText);
	return oldText == null && newText == null ? undefined : { oldText, newText };
}

/** The diff one edit record states: its own patch, else its replace pair as removed then added lines. */
export function editRecordDiff(record: Record<string, unknown>): string | undefined {
	const diff = asNonEmptyString(record.diff);
	if (diff) return diff;
	const pair = editTextPair(record);
	if (!pair) return undefined;
	const lines: string[] = [];
	if (pair.oldText != null) for (const line of pair.oldText.split("\n")) lines.push(`-${line}`);
	if (pair.newText != null) for (const line of pair.newText.split("\n")) lines.push(`+${line}`);
	return lines.join("\n");
}

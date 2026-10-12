import { parseDiff } from "../../lib/diff";

/** Live editors show the newest changed region; transcript diffs stay complete. */
export function liveDiffPreview(diff: string): string {
	const rows = parseDiff(diff);
	let end = rows.length;
	for (let index = rows.length - 1; index >= 0; index--) {
		if (rows[index]?.type !== "context") {
			end = Math.min(rows.length, index + 4);
			break;
		}
	}
	if (end === rows.length && rows.length <= 80) return diff;
	const lines: string[] = [];
	let oldCursor: number | undefined;
	let newCursor: number | undefined;
	for (const row of rows.slice(Math.max(0, end - 80), end)) {
		if (
			(row.oldLine !== undefined && row.oldLine !== oldCursor) ||
			(row.newLine !== undefined && row.newLine !== newCursor)
		) {
			oldCursor = row.oldLine ?? oldCursor ?? row.newLine ?? 1;
			newCursor = row.newLine ?? newCursor ?? row.oldLine ?? 1;
			lines.push(`@@ -${oldCursor} +${newCursor} @@`);
		}
		const marker = row.type === "add" ? "+" : row.type === "remove" ? "-" : " ";
		const number = row.type === "add" ? row.newLine : row.oldLine;
		lines.push(`${marker}${number === undefined ? "" : `${number}|`}${row.content}`);
		if (row.type !== "add" && row.oldLine !== undefined) oldCursor = row.oldLine + 1;
		if (row.type !== "remove" && row.newLine !== undefined) newCursor = row.newLine + 1;
	}
	return lines.join("\n");
}

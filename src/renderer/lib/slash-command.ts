// Stock slash-commands/helpers/parse.parseSlashCommand grammar; synchronous GUI dispatch cannot import omp in the renderer.
export function parseSlashCommand(text: string): { name: string; args: string; text: string } | null {
	if (!text.startsWith("/")) return null;
	const body = text.slice(1);
	if (!body) return null;
	const whitespace = body.search(/\s/);
	const colon = body.indexOf(":");
	const separator = whitespace === -1 ? colon : colon === -1 ? whitespace : Math.min(whitespace, colon);
	return separator === -1
		? { name: body, args: "", text }
		: { name: body.slice(0, separator), args: body.slice(separator + 1).trim(), text };
}

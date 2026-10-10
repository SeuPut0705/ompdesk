import { describe, expect, it } from "vitest";
import { parseComposerMode } from "./input-modes";
import { parseSlashCommand } from "./slash-command";

describe("stock parseSlashCommand grammar", () => {
	// Stock slash-commands/helpers/parse documents these whitespace/colon cases.
	it.each([
		["/foo bar", "foo", "bar"],
		["/foo:bar", "foo", "bar"],
		["/Foo_Bar:  baz:qux ", "Foo_Bar", "baz:qux"],
		["/foo bar:baz", "foo", "bar:baz"],
		["/foo:bar baz", "foo", "bar baz"],
		["/한글", "한글", ""],
		["/foo\nbar", "foo", "bar"],
	])("parses %s without narrowing or lowercasing names", (text, name, args) => {
		expect(parseSlashCommand(text)).toEqual({ name, args, text });
	});
	it.each(["", "/", "hello", " /foo"])("ignores %j", text => expect(parseSlashCommand(text)).toBeNull());
});

describe("stock pythonCommandPrefixLength whitespace contract", () => {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell/template syntax must not enter Python mode.
	it.each(["$", "$$", "$HOME", "${value}"])("keeps %s in normal text mode", text =>
		expect(parseComposerMode(text)).toBeNull(),
	);
	it.each(["$ ", "$$ ", "$\t", "$$\n"])("recognizes %j after whitespace", text =>
		expect(parseComposerMode(text)?.mode).toBe("python"),
	);
});

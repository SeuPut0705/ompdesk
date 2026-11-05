/**
 * The computer-use section's safety text is a copy of the installed omp's own (src/prompts/system/computer-use.md,
 * the rules of its built-in `computer` prelude): the agent-desktop engine drives the same desktop, so it must carry
 * every rule stock does. When a newer omp adds or rewords a rule, this fails until the section follows. Skipped
 * without an installed omp.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { COMPUTER_USE_SECTION } from "../../resources/gui-bridge/modes/computer-use-core";

const stockFile = path.join(
	os.homedir(),
	".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/prompts/system/computer-use.md",
);

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

describe.skipIf(!fs.existsSync(stockFile))("the computer-use section against stock's computer-use.md", () => {
	const stock = fs.readFileSync(stockFile, "utf8");
	const critical = /<critical>([\s\S]*?)<\/critical>/.exec(stock);

	it("carries every bullet of stock's <critical> block", () => {
		expect(critical, "stock's computer-use.md has no <critical> block").not.toBeNull();
		const bullets = (critical?.[1] ?? "")
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("- "));
		expect(bullets.length).toBeGreaterThan(0);
		const section = normalize(COMPUTER_USE_SECTION);
		for (const bullet of bullets) expect(section, bullet).toContain(normalize(bullet));
	});

	it("carries the paragraphs stock puts after the block", () => {
		const after = stock
			.slice((critical?.index ?? 0) + (critical?.[0].length ?? 0))
			.split(/\n\s*\n/)
			.map(normalize)
			.filter(Boolean);
		expect(after.length).toBeGreaterThan(0);
		const section = normalize(COMPUTER_USE_SECTION);
		for (const paragraph of after) expect(section, paragraph).toContain(paragraph);
	});
});

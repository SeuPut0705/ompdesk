/**
 * gui-bridge mojibake check (resources/gui-bridge/mojibake.ts): UTF-8 a model wrote as Windows-1252 is caught, as the
 * reported suggestions came out, and real text in any script is not.
 */
import { describe, expect, it } from "vitest";
import { isUtf8Mojibake } from "../../resources/gui-bridge/mojibake";

import { garbled } from "./test-mojibake";

describe("isUtf8Mojibake", () => {
	it("catches the reported suggestions and other scripts read as Windows-1252", () => {
		// The placeholder and the chip as the screen showed them.
		expect(isUtf8Mojibake("ì•Œê² ì–´ ê·¸ëŸ¼ ê³„ì† ì§„í–‰í•´")).toBe(true);
		expect(isUtf8Mojibake("ì§€ê¸ˆ ì—ì´ì „íŠ¸ë“¤ ìƒíƒœ ë‹¤ì‹œ í•œë²ˆ ì •ë¦¬í•´ì¤˜")).toBe(true);
		for (const text of [
			"지금 열린 탭들 상태 다시 한번 정리해줘",
			"テストを実行して",
			"修复登录错误",
			"ship it 🎉🚀",
			"été",
		]) {
			expect(isUtf8Mojibake(garbled(text)), text).toBe(true);
		}
	});

	it("still catches it once whitespace is folded and C1 controls are dropped (a candidate's one-line form)", () => {
		const folded = garbled("지금 에이전트들 상태 다시 한번 정리해줘")
			.replace(/[\u0080-\u009f]/g, "")
			.replace(/\s+/g, " ");
		expect(isUtf8Mojibake(folded)).toBe(true);
	});

	it("leaves real text alone: Korean, CJK, emoji and Latin scripts with their punctuation", () => {
		for (const text of [
			"지금 열린 탭들 상태 다시 한번 정리해줘",
			"テストを実行して",
			"ship it 🎉🚀 — “done” … ½ © 2026",
			"café… olé… déjà vu",
			"„Straße“ und „Grüße“",
			"São Paulo, ação, coração",
			"Ça marche très bien, naïve façade",
			"Ä Ö Ü ß ä ö ü",
			"‘quoted’ – en dash • bullet ™",
			"",
		]) {
			expect(isUtf8Mojibake(text), text).toBe(false);
		}
	});

	it("needs two whole sequences: one stray pair or a cut sequence is not enough", () => {
		expect(isUtf8Mojibake("Ã©")).toBe(false);
		expect(isUtf8Mojibake("ì§")).toBe(false);
		expect(isUtf8Mojibake(`${garbled("지")} and ì`)).toBe(false);
	});
});

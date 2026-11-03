import { describe, expect, it } from "vitest";
import {
	LANGUAGE_FALLBACK_STT_MODEL,
	type SttModelStore,
	SttModels,
	speechLanguageOfName,
	sttLanguageCode,
	sttModelForLanguage,
	sttModelSupports,
} from "../../resources/gui-bridge/stt-language-core";

// Stock's catalog entries (stt/models.ts), as the rule reads them.
const PARAKEET = { key: "parakeet-tdt-0.6b-v3", englishOnly: false, engine: "sherpa" } as const;
const NEMOTRON = { key: "nemotron-streaming-en-0.6b", englishOnly: true, engine: "sherpa" } as const;
const WHISPER_SMALL = { key: "whisper-small", englishOnly: false, engine: "transformers" } as const;

describe("which dictation model hears a language", () => {
	it("keeps Parakeet v3 for its languages and sends Korean, Japanese and Chinese to Whisper large-v3-turbo", () => {
		for (const language of ["en", "de", "fr", "uk", "pl"]) {
			expect(sttModelForLanguage(PARAKEET, language), language).toBe("parakeet-tdt-0.6b-v3");
		}
		for (const language of ["ko", "ja", "zh", "vi", "ar"]) {
			expect(sttModelForLanguage(PARAKEET, language), language).toBe(LANGUAGE_FALLBACK_STT_MODEL);
		}
		expect(LANGUAGE_FALLBACK_STT_MODEL).toBe("whisper-large-v3-turbo");
	});

	it("keeps an English-only model for English only", () => {
		expect(sttModelForLanguage(NEMOTRON, "en")).toBe(NEMOTRON.key);
		expect(sttModelForLanguage(NEMOTRON, "de")).toBe(LANGUAGE_FALLBACK_STT_MODEL);
		expect(sttModelForLanguage(NEMOTRON, "ko")).toBe(LANGUAGE_FALLBACK_STT_MODEL);
	});

	it("keeps a multilingual Whisper tier for every language, and any model when no language is named", () => {
		expect(sttModelSupports(WHISPER_SMALL, "ko")).toBe(true);
		expect(sttModelSupports(WHISPER_SMALL, "sw")).toBe(true);
		expect(sttModelSupports(PARAKEET, undefined)).toBe(true);
		expect(sttModelSupports(NEMOTRON, undefined)).toBe(true);
	});
});

describe("the speech's language", () => {
	it("is a tag's language subtag", () => {
		expect(sttLanguageCode("ko-KR")).toBe("ko");
		expect(sttLanguageCode("zh-Hant")).toBe("zh");
		expect(sttLanguageCode("pt_BR")).toBe("pt");
		expect(sttLanguageCode("EN")).toBe("en");
		expect(sttLanguageCode("")).toBeUndefined();
		expect(sttLanguageCode("not a tag")).toBeUndefined();
		expect(sttLanguageCode(undefined)).toBeUndefined();
	});

	it("comes from the conversation language's English name, a Settings choice or a device language", () => {
		expect(speechLanguageOfName("Korean")).toBe("ko");
		expect(speechLanguageOfName("English")).toBe("en");
		expect(speechLanguageOfName("Chinese (Simplified)")).toBe("zh");
		expect(speechLanguageOfName("Chinese (Traditional)")).toBe("zh");
		expect(speechLanguageOfName("Traditional Chinese")).toBe("zh");
		expect(speechLanguageOfName(" japanese ")).toBe("ja");
		// Deprecated codes share a name with the current one; the current code wins.
		expect(speechLanguageOfName("Romanian")).toBe("ro");
		expect(speechLanguageOfName("Hebrew")).toBe("he");
		expect(speechLanguageOfName("Indonesian")).toBe("id");
		expect(speechLanguageOfName("Klingonese")).toBeUndefined();
		expect(speechLanguageOfName(undefined)).toBeUndefined();
	});
});

/** Stock's downloader, played by the test: each `download` waits for `finish`/`fail`. */
class FakeStore implements SttModelStore {
	cached = new Set<string>();
	downloads: string[] = [];
	#pending = new Map<
		string,
		{ progress: (loaded: number, total: number) => void; resolve: () => void; reject: (e: Error) => void }
	>();

	async isCached(key: string): Promise<boolean> {
		return this.cached.has(key);
	}

	download(key: string, onProgress: (loaded: number, total: number) => void): Promise<void> {
		this.downloads.push(key);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#pending.set(key, { progress: onProgress, resolve, reject });
		return promise;
	}

	progress(key: string, loaded: number, total: number): void {
		this.#pending.get(key)?.progress(loaded, total);
	}

	finish(key: string): void {
		this.cached.add(key);
		this.#pending.get(key)?.resolve();
		this.#pending.delete(key);
	}

	fail(key: string, message: string): void {
		this.#pending.get(key)?.reject(new Error(message));
		this.#pending.delete(key);
	}
}

/** Whether `promise` is still pending once everything already settled has run. */
const pending = async (promise: Promise<unknown>) =>
	(await Promise.race([promise.then(() => "settled"), Promise.resolve("pending")])) === "pending";

describe("getting a model's weights", () => {
	it("starts one download, reports its progress without waiting, and is ready once it lands", async () => {
		const store = new FakeStore();
		const models = new SttModels(store);
		expect(await models.prepare("whisper-large-v3-turbo")).toEqual({ state: "downloading", percent: 0 });
		store.progress("whisper-large-v3-turbo", 416_000_000, 1_000_000_000);
		expect(await models.prepare("whisper-large-v3-turbo")).toEqual({ state: "downloading", percent: 42 });
		expect(await models.isReady("whisper-large-v3-turbo")).toBe(false);
		store.finish("whisper-large-v3-turbo");
		await models.ensure("whisper-large-v3-turbo");
		expect(await models.prepare("whisper-large-v3-turbo")).toEqual({ state: "ready" });
		expect(await models.isReady("whisper-large-v3-turbo")).toBe(true);
		expect(store.downloads).toEqual(["whisper-large-v3-turbo"]);
	});

	it("reads 0 % while only the first small files are counted, not their own 100 %", async () => {
		const store = new FakeStore();
		const models = new SttModels(store);
		await models.prepare("whisper-large-v3-turbo");
		store.progress("whisper-large-v3-turbo", 2_000, 2_000);
		expect(await models.prepare("whisper-large-v3-turbo")).toEqual({ state: "downloading", percent: 0 });
		store.progress("whisper-large-v3-turbo", 40_000_000, 640_000_000);
		expect(await models.prepare("whisper-large-v3-turbo")).toEqual({ state: "downloading", percent: 6 });
	});

	it("says a failed download once, then tries again", async () => {
		const store = new FakeStore();
		const models = new SttModels(store);
		await models.prepare("whisper-large-v3-turbo");
		store.fail("whisper-large-v3-turbo", "Failed to download speech model: offline");
		await expect(models.ensure("whisper-large-v3-turbo")).rejects.toThrow("offline");
		expect(await models.prepare("whisper-large-v3-turbo")).toEqual({
			state: "failed",
			error: "Failed to download speech model: offline",
		});
		expect(await models.prepare("whisper-large-v3-turbo")).toEqual({ state: "downloading", percent: 0 });
		expect(store.downloads).toEqual(["whisper-large-v3-turbo", "whisper-large-v3-turbo"]);
	});

	it("lets a dictation wait for the download a call started, and never starts a second one", async () => {
		const store = new FakeStore();
		const models = new SttModels(store);
		await models.prepare("whisper-large-v3-turbo");
		const waiting = models.ensure("whisper-large-v3-turbo");
		expect(await pending(waiting)).toBe(true);
		store.finish("whisper-large-v3-turbo");
		await waiting;
		await models.ensure("whisper-large-v3-turbo");
		expect(store.downloads).toEqual(["whisper-large-v3-turbo"]);
	});
});

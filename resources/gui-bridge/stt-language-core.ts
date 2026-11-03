/**
 * Which dictation model hears which language, and getting that model's weights onto this computer. Pure: no omp
 * imports; `voice.ts` hands in stock's catalog entry (`resolveSttModelSpec`) and downloader, and
 * `src/main/bridge-stt-language.test.ts` runs it over fakes.
 *
 * The owner's rule (3 Nov 2026): speech in a language the selected dictation model cannot transcribe goes to
 * {@link LANGUAGE_FALLBACK_STT_MODEL} instead; a language the model has keeps the model (English stays on Parakeet).
 */
import type { SttModelState } from "./stt-language-contracts";

/** The part of stock's `SttModelSpec` (stt/models.ts) the rules read. */
export interface SttModelFacts {
	key: string;
	/** Stock's own flag: an English-only checkpoint. */
	englishOnly: boolean;
	/** Stock's runtime for the model: transformers.js (the Whisper tiers) or sherpa-onnx (Parakeet, Nemotron). */
	engine: "transformers" | "sherpa";
}

/** Stock's catalog entry that covers the most languages: Whisper large-v3-turbo, 99 languages (~600 MB). */
export const LANGUAGE_FALLBACK_STT_MODEL = "whisper-large-v3-turbo";

/**
 * Languages of a multilingual catalog model that does not cover all of Whisper's, by stock key. Stock's catalog says
 * only "25 languages" for Parakeet v3; the list is NVIDIA's model card
 * (https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3, "Supported languages"). Not listed: Whisper tiers (stock's
 * descriptions: multilingual, 99 languages), which take every language.
 */
export const MODEL_LANGUAGES: Readonly<Record<string, readonly string[]>> = {
	"parakeet-tdt-0.6b-v3": [
		"bg",
		"cs",
		"da",
		"de",
		"el",
		"en",
		"es",
		"et",
		"fi",
		"fr",
		"hr",
		"hu",
		"it",
		"lt",
		"lv",
		"mt",
		"nl",
		"pl",
		"pt",
		"ro",
		"ru",
		"sk",
		"sl",
		"sv",
		"uk",
	],
};

/** A BCP 47 tag's language as the speech models name it: `ko-KR` → `ko`, `zh-Hant` → `zh`. */
export function sttLanguageCode(tag: string | undefined): string | undefined {
	const code = tag?.trim().split(/[-_]/)[0]?.toLowerCase();
	return code && /^[a-z]{2,3}$/.test(code) ? code : undefined;
}

/** Whether `model` transcribes `language` (a code); no language means the model's own default, which it has. */
export function sttModelSupports(model: SttModelFacts, language: string | undefined): boolean {
	if (!language) return true;
	if (model.englishOnly) return language === "en";
	return MODEL_LANGUAGES[model.key]?.includes(language) ?? true;
}

/** The model `language` is transcribed on when `selected` is the dictation model. */
export function sttModelForLanguage(selected: SttModelFacts, language: string | undefined): string {
	return sttModelSupports(selected, language) ? selected.key : LANGUAGE_FALLBACK_STT_MODEL;
}

/**
 * Whether a live stream on `model` previews the words while they are spoken. Stock's stream previews the segment under
 * way by decoding all of it again (`pumpSession`, stt/asr-worker.ts). Whisper on transformers.js is an offline model:
 * each preview is a whole pass, about 6 s for large-v3-turbo on an M-series Mac's CPU, stock drops previews only after
 * two slow ones, and the final pass queued behind them (a Korean call's text came 15.4 s after the speech, 3 Nov 2026).
 * The owner's decision: such a model transcribes the utterance once, after the speech ended. sherpa-onnx decodes a
 * Parakeet preview in milliseconds, and Nemotron streams natively.
 */
export function sttPreviewsSpeech(model: SttModelFacts): boolean {
	return model.engine !== "transformers";
}

const ENGLISH_NAMES = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
let codesByName: Map<string, string> | undefined;

/** Every two-letter language code by its English name (canonical codes only: `mo` is Romanian too, but `ro` names it). */
function languageCodesByName(): Map<string, string> {
	if (codesByName) return codesByName;
	codesByName = new Map();
	const letters = "abcdefghijklmnopqrstuvwxyz";
	for (const first of letters) {
		for (const second of letters) {
			const code = first + second;
			const name = ENGLISH_NAMES.of(code);
			if (name && Intl.getCanonicalLocales(code)[0] === code) codesByName.set(name.toLowerCase(), code);
		}
	}
	return codesByName;
}

/**
 * The language code of the conversation language's English name, as OMPdesk hands it to omp (`OMP_GUI_REPLY_LANGUAGE`,
 * src/shared/reply-language.ts): a Settings choice (`Korean`, `Chinese (Simplified)`) or a device language's
 * `Intl.DisplayNames` name (`Japanese`, `Traditional Chinese`). Unknown → undefined.
 */
export function speechLanguageOfName(name: string | undefined): string | undefined {
	const wanted = name?.trim().toLowerCase();
	if (!wanted) return undefined;
	const codes = languageCodesByName();
	const bare = wanted.replace(/\s*\(.*\)$/, "");
	return codes.get(wanted) ?? codes.get(bare) ?? codes.get(bare.split(/\s+/).at(-1) ?? "");
}

// ---------------------------------------------------------------------------
// The model's weights: present, downloading, or a download that failed
// ---------------------------------------------------------------------------

/** Stock's downloader (stt/downloader.ts), the part used here. */
export interface SttModelStore {
	isCached(key: string): Promise<boolean>;
	/** Resolves once the weights are in omp's model cache; `onProgress` gets the bytes so far of the files seen so far. */
	download(key: string, onProgress: (loaded: number, total: number) => void): Promise<void>;
}

/**
 * Below this many bytes seen, a download reads 0 %: stock sums the files it has seen so far, and a download starts with
 * KB-sized config files, so its own percent read 0, 55, 100, then 0 again as the weights appeared (Whisper
 * large-v3-turbo on this Mac, 3 Nov 2026).
 */
export const MIN_PROGRESS_BYTES = 8 * 1024 * 1024;

interface Download {
	percent: number;
	done: Promise<void>;
}

/** One download per model at a time, whoever asks: a call preparing it, a stream or a dictation waiting for it. */
export class SttModels {
	readonly #store: SttModelStore;
	readonly #downloads = new Map<string, Download>();
	readonly #failures = new Map<string, string>();

	constructor(store: SttModelStore) {
		this.#store = store;
	}

	/** Start getting `key` if it is not here yet, and say where it stands; never waits for the download. */
	async prepare(key: string): Promise<SttModelState> {
		const running = this.#downloads.get(key);
		if (running) return { state: "downloading", percent: running.percent };
		const error = this.#failures.get(key);
		if (error !== undefined) {
			this.#failures.delete(key);
			return { state: "failed", error };
		}
		if (await this.#store.isCached(key)) return { state: "ready" };
		const download = this.#downloads.get(key) ?? this.#start(key, true);
		return { state: "downloading", percent: download.percent };
	}

	/** Whether `key`'s weights are here and no download of them runs. */
	async isReady(key: string): Promise<boolean> {
		return !this.#downloads.has(key) && (await this.#store.isCached(key));
	}

	/** Resolves once `key` is here, downloading it (or joining the download under way) if needed. */
	async ensure(key: string): Promise<void> {
		const running = this.#downloads.get(key);
		if (running) return running.done;
		if (await this.#store.isCached(key)) return;
		return (this.#downloads.get(key) ?? this.#start(key, false)).done;
	}

	/** `remember`: a failure is kept for the next {@link prepare} (nobody awaits a download `prepare` started). */
	#start(key: string, remember: boolean): Download {
		const download: Download = { percent: 0, done: Promise.resolve() };
		download.done = this.#store
			.download(key, (loaded, total) => {
				download.percent =
					total < MIN_PROGRESS_BYTES ? 0 : Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
			})
			.then(
				() => {
					this.#downloads.delete(key);
				},
				(cause: unknown) => {
					this.#downloads.delete(key);
					const message = cause instanceof Error ? cause.message : String(cause);
					if (remember) this.#failures.set(key, message);
					throw cause instanceof Error ? cause : new Error(message);
				},
			);
		if (remember) download.done.catch(() => {});
		this.#downloads.set(key, download);
		return download;
	}
}

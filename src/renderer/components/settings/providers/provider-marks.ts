/**
 * Brand marks for provider rows: which vendored symbol (src/renderer/assets/provider-marks,
 * monochrome `currentColor` SVGs from @lobehub/icons, MIT; see THIRD_PARTY_NOTICES.txt) belongs to which stock
 * provider id, and which company a provider sorts under. Pure: no React, no IPC.
 *
 * The ids are the ones stock omp reports (its `/login` provider list plus the model catalog's
 * provider ids). A provider with no mark is one of `FALLBACK_PROVIDER_IDS` (no permissively
 * licensed symbol exists for it) or an id this build has never heard of (a custom endpoint, a
 * newer omp); both draw the neutral first-letter glyph. `provider-marks.test.tsx` pins every
 * stock id to a mark or to the fallback list, so a provider added by a stock update fails there
 * instead of silently drawing a letter.
 */

import alibabacloud from "../../../assets/provider-marks/alibabacloud.svg?raw";
import anthropic from "../../../assets/provider-marks/anthropic.svg?raw";
import antigravity from "../../../assets/provider-marks/antigravity.svg?raw";
import apple from "../../../assets/provider-marks/apple.svg?raw";
import azure from "../../../assets/provider-marks/azure.svg?raw";
import baiducloud from "../../../assets/provider-marks/baiducloud.svg?raw";
import baseten from "../../../assets/provider-marks/baseten.svg?raw";
import bedrock from "../../../assets/provider-marks/bedrock.svg?raw";
import cerebras from "../../../assets/provider-marks/cerebras.svg?raw";
import cline from "../../../assets/provider-marks/cline.svg?raw";
import cloudflare from "../../../assets/provider-marks/cloudflare.svg?raw";
import commandcode from "../../../assets/provider-marks/commandcode.svg?raw";
import cursor from "../../../assets/provider-marks/cursor.svg?raw";
import deepinfra from "../../../assets/provider-marks/deepinfra.svg?raw";
import deepseek from "../../../assets/provider-marks/deepseek.svg?raw";
import devin from "../../../assets/provider-marks/devin.svg?raw";
import exa from "../../../assets/provider-marks/exa.svg?raw";
import fireworks from "../../../assets/provider-marks/fireworks.svg?raw";
import gemini from "../../../assets/provider-marks/gemini.svg?raw";
import githubcopilot from "../../../assets/provider-marks/githubcopilot.svg?raw";
import gmicloud from "../../../assets/provider-marks/gmicloud.svg?raw";
import groq from "../../../assets/provider-marks/groq.svg?raw";
import huggingface from "../../../assets/provider-marks/huggingface.svg?raw";
import inception from "../../../assets/provider-marks/inception.svg?raw";
import kagi from "../../../assets/provider-marks/kagi.svg?raw";
import kilocode from "../../../assets/provider-marks/kilocode.svg?raw";
import kimi from "../../../assets/provider-marks/kimi.svg?raw";
import lmstudio from "../../../assets/provider-marks/lmstudio.svg?raw";
import meta from "../../../assets/provider-marks/meta.svg?raw";
import minimax from "../../../assets/provider-marks/minimax.svg?raw";
import mistral from "../../../assets/provider-marks/mistral.svg?raw";
import moonshot from "../../../assets/provider-marks/moonshot.svg?raw";
import novita from "../../../assets/provider-marks/novita.svg?raw";
import nvidia from "../../../assets/provider-marks/nvidia.svg?raw";
import ollama from "../../../assets/provider-marks/ollama.svg?raw";
import openai from "../../../assets/provider-marks/openai.svg?raw";
import opencode from "../../../assets/provider-marks/opencode.svg?raw";
import openrouter from "../../../assets/provider-marks/openrouter.svg?raw";
import perplexity from "../../../assets/provider-marks/perplexity.svg?raw";
import qwen from "../../../assets/provider-marks/qwen.svg?raw";
import sakana from "../../../assets/provider-marks/sakana.svg?raw";
import sambanova from "../../../assets/provider-marks/sambanova.svg?raw";
import siliconcloud from "../../../assets/provider-marks/siliconcloud.svg?raw";
import snowflake from "../../../assets/provider-marks/snowflake.svg?raw";
import stepfun from "../../../assets/provider-marks/stepfun.svg?raw";
import tavily from "../../../assets/provider-marks/tavily.svg?raw";
import together from "../../../assets/provider-marks/together.svg?raw";
import venice from "../../../assets/provider-marks/venice.svg?raw";
import vercel from "../../../assets/provider-marks/vercel.svg?raw";
import vertexai from "../../../assets/provider-marks/vertexai.svg?raw";
import vllm from "../../../assets/provider-marks/vllm.svg?raw";
import xai from "../../../assets/provider-marks/xai.svg?raw";
import xiaomimimo from "../../../assets/provider-marks/xiaomimimo.svg?raw";
import zai from "../../../assets/provider-marks/zai.svg?raw";
import zhipu from "../../../assets/provider-marks/zhipu.svg?raw";

/** Every vendored symbol, by its file name in src/renderer/assets/provider-marks. */
export const MARK_SOURCES = {
	alibabacloud,
	anthropic,
	antigravity,
	apple,
	azure,
	baiducloud,
	baseten,
	bedrock,
	cerebras,
	cline,
	cloudflare,
	commandcode,
	cursor,
	deepinfra,
	deepseek,
	devin,
	exa,
	fireworks,
	gemini,
	githubcopilot,
	gmicloud,
	groq,
	huggingface,
	inception,
	kagi,
	kilocode,
	kimi,
	lmstudio,
	meta,
	minimax,
	mistral,
	moonshot,
	novita,
	nvidia,
	ollama,
	openai,
	opencode,
	openrouter,
	perplexity,
	qwen,
	sakana,
	sambanova,
	siliconcloud,
	snowflake,
	stepfun,
	tavily,
	together,
	venice,
	vercel,
	vertexai,
	vllm,
	xai,
	xiaomimimo,
	zai,
	zhipu,
} as const;

export type MarkId = keyof typeof MARK_SOURCES;

interface Brand {
	mark: MarkId;
	/** The company the row sorts under; a company's providers sit next to each other. */
	company: string;
}

const brand = (mark: MarkId, company: string): Brand => ({ mark, company });

/** Stock provider id → symbol and company. Providers of one company share the company string. */
export const PROVIDER_BRANDS: Readonly<Record<string, Brand>> = {
	"alibaba-coding-plan": brand("alibabacloud", "Alibaba"),
	"alibaba-token-plan": brand("alibabacloud", "Alibaba"),
	"amazon-bedrock": brand("bedrock", "Amazon"),
	"bedrock-mantle": brand("bedrock", "Amazon"),
	"cline-pass": brand("cline", "Cline"),
	"cloudflare-ai-gateway": brand("cloudflare", "Cloudflare"),
	"cloudflare-workers-ai": brand("cloudflare", "Cloudflare"),
	"github-copilot": brand("githubcopilot", "GitHub"),
	"google-antigravity": brand("antigravity", "Google"),
	"google-gemini-cli": brand("gemini", "Google"),
	"google-vertex": brand("vertexai", "Google"),
	"gmi-cloud": brand("gmicloud", "GMI Cloud"),
	"kimi-code": brand("kimi", "Moonshot AI"),
	"lm-studio": brand("lmstudio", "LM Studio"),
	"minimax-cn": brand("minimax", "MiniMax"),
	"minimax-code": brand("minimax", "MiniMax"),
	"minimax-code-cn": brand("minimax", "MiniMax"),
	"ollama-cloud": brand("ollama", "Ollama"),
	"openai-codex": brand("openai", "OpenAI"),
	"openai-codex-device": brand("openai", "OpenAI"),
	"opencode-go": brand("opencode", "OpenCode"),
	"opencode-zen": brand("opencode", "OpenCode"),
	"qwen-portal": brand("qwen", "Alibaba"),
	"siliconflow-cn": brand("siliconcloud", "SiliconFlow"),
	"vercel-ai-gateway": brand("vercel", "Vercel"),
	"xai-oauth": brand("xai", "xAI"),
	"xiaomi-token-plan-ams": brand("xiaomimimo", "Xiaomi"),
	"xiaomi-token-plan-cn": brand("xiaomimimo", "Xiaomi"),
	"xiaomi-token-plan-sgp": brand("xiaomimimo", "Xiaomi"),
	"zai-coding-plan": brand("zai", "Z.AI"),
	"zhipu-coding-plan": brand("zhipu", "Zhipu AI"),
	anthropic: brand("anthropic", "Anthropic"),
	apple: brand("apple", "Apple"),
	azure: brand("azure", "Microsoft"),
	baseten: brand("baseten", "Baseten"),
	cerebras: brand("cerebras", "Cerebras"),
	commandcode: brand("commandcode", "Command Code"),
	cursor: brand("cursor", "Cursor"),
	deepinfra: brand("deepinfra", "DeepInfra"),
	deepseek: brand("deepseek", "DeepSeek"),
	devin: brand("devin", "Devin"),
	exa: brand("exa", "Exa"),
	firepass: brand("fireworks", "Fireworks AI"),
	fireworks: brand("fireworks", "Fireworks AI"),
	google: brand("gemini", "Google"),
	groq: brand("groq", "Groq"),
	huggingface: brand("huggingface", "Hugging Face"),
	inception: brand("inception", "Inception"),
	kagi: brand("kagi", "Kagi"),
	kilo: brand("kilocode", "Kilo Code"),
	meta: brand("meta", "Meta"),
	minimax: brand("minimax", "MiniMax"),
	mistral: brand("mistral", "Mistral AI"),
	moonshot: brand("moonshot", "Moonshot AI"),
	novita: brand("novita", "Novita AI"),
	nvidia: brand("nvidia", "NVIDIA"),
	ollama: brand("ollama", "Ollama"),
	openai: brand("openai", "OpenAI"),
	openrouter: brand("openrouter", "OpenRouter"),
	perplexity: brand("perplexity", "Perplexity"),
	qianfan: brand("baiducloud", "Baidu"),
	sakana: brand("sakana", "Sakana AI"),
	sambanova: brand("sambanova", "SambaNova"),
	siliconflow: brand("siliconcloud", "SiliconFlow"),
	snowflake: brand("snowflake", "Snowflake"),
	stepfun: brand("stepfun", "StepFun"),
	tavily: brand("tavily", "Tavily"),
	together: brand("together", "Together AI"),
	venice: brand("venice", "Venice"),
	vllm: brand("vllm", "vLLM"),
	xai: brand("xai", "xAI"),
	xiaomi: brand("xiaomimimo", "Xiaomi"),
	zai: brand("zai", "Z.AI"),
};

/**
 * Stock providers drawn with the neutral glyph on purpose: no symbol for them ships in a
 * permissively licensed icon set (or they are local and generic: `local`, `web`). Everything
 * else stock lists has an entry in PROVIDER_BRANDS.
 */
export const FALLBACK_PROVIDER_IDS: readonly string[] = [
	"abliteration",
	"aiand",
	"aimlapi",
	"charm-hyper",
	"coralbricks",
	"coreweave",
	"factory-droid",
	"gitlab-duo",
	"gitlab-duo-agent",
	"helmcode",
	"litellm",
	"llama.cpp",
	"local",
	"muse-code",
	"nanogpt",
	"parallel",
	"singularityapi-dev",
	"singularityapi-tech",
	"stencil",
	"synthetic",
	"typesafe",
	"umans",
	"wafer-serverless",
	"web",
	"yolo-auto",
	"zenmux",
];

export interface ProviderBrand {
	/** Sort key: the company, or the provider's own name when it has no brand entry. */
	company: string;
	/** The vendored symbol, or null for the fallback glyph. */
	mark: MarkId | null;
}

export function providerBrand(provider: { id: string; name: string }): ProviderBrand {
	const known = PROVIDER_BRANDS[provider.id];
	return known ? { company: known.company, mark: known.mark } : { company: provider.name, mark: null };
}

/**
 * The model family a symbol stands for, where it is not the company's own name: the mark says it already, so a chip
 * beside the mark can leave it out. Only names the vendors print on their own models (Anthropic's Claude, Google's
 * Gemini, xAI's Grok); OpenAI's GPT is a model line, not a brand the mark draws, so it stays.
 */
const MARK_FAMILY: Partial<Record<MarkId, string>> = { anthropic: "Claude", gemini: "Gemini", xai: "Grok" };

/**
 * A model's name for a chip that already shows its provider's mark: a leading word equal to the brand the mark draws
 * (the company's first word, or its model family) is dropped when what follows still starts with a word ("Claude Opus
 * 5.5" → "Opus 5.5"), never when only a number would be left ("Gemini 3 Pro", "Grok 5" stay whole). No mark, or no
 * such word: the name as stock gives it. Pickers and tooltips keep the full name.
 */
export function chipModelName(provider: { id: string; name: string }, name: string): string {
	const { company, mark } = providerBrand(provider);
	if (mark === null) return name;
	const brands = [company.split(" ")[0], MARK_FAMILY[mark]].filter((word): word is string => !!word);
	const match = /^(\S+?):?\s+(\p{L}.*)$/u.exec(name.trim());
	if (!match) return name;
	const [, lead = "", rest = ""] = match;
	return brands.some(word => word.localeCompare(lead, undefined, { sensitivity: "base" }) === 0) ? rest : name;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * By company, then by the provider's own name: a company's providers are adjacent, and the
 * order never depends on which account answered first.
 */
export function sortProvidersByCompany<T extends { id: string; name: string }>(providers: readonly T[]): T[] {
	return providers
		.map(provider => ({ provider, company: providerBrand(provider).company }))
		.sort(
			(a, b) =>
				collator.compare(a.company, b.company) ||
				collator.compare(a.provider.name, b.provider.name) ||
				collator.compare(a.provider.id, b.provider.id),
		)
		.map(entry => entry.provider);
}

export interface MarkArt {
	viewBox: string;
	/** `evenodd` when the source sets it on the root; every path inherits it. */
	evenOdd: boolean;
	paths: readonly string[];
}

/** The `<path>` data of one vendored SVG (these files hold nothing but paths on a 24-unit grid). */
export function parseMark(svg: string): MarkArt {
	const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
	return {
		viewBox: /viewBox="([^"]+)"/.exec(root)?.[1] ?? "0 0 24 24",
		evenOdd: /fill-rule="evenodd"/.test(root),
		paths: Array.from(svg.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g), match => match[1] ?? ""),
	};
}

const parsed = new Map<MarkId, MarkArt>();

export function markArt(mark: MarkId): MarkArt {
	let art = parsed.get(mark);
	if (!art) {
		art = parseMark(MARK_SOURCES[mark]);
		parsed.set(mark, art);
	}
	return art;
}

import { cx, extractImageDataUrl, resultDetails, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { ZoomableImage } from "../common/ZoomableImage";
import { JsonTree, parseJsonOutput } from "./JsonTree";
import { metaTruncation, stripGeneratedOutputNotice, TruncationNote } from "./output-meta";
import type { ToolRendererProps } from "./ToolCard";
import { ToolTextPreview } from "./ToolTextPreview";

/** Argument keys stock never shows (pi-tui `tools/json-tree.ts` HIDDEN_ARG_KEYS): the intent and the streaming buffer. */
const HIDDEN_ARG_KEYS: Record<string, true> = { i: true, __partialJson: true };

/** String past this length (or multiline) folds behind a disclosure row. */
const INLINE_VALUE_MAX_CHARS = 120;

/** Arguments as the card shows them: without stock's hidden keys. */
export function visibleToolArgs(args: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(args).filter(([key]) => !HIDDEN_ARG_KEYS[key]));
}

/**
 * One value in a key/value row. Primitives render inline (short) or behind a
 * disclosure (long/multiline); objects and arrays fold into a JSON tree.
 */
function ValueView({ name, value }: { name: string; value: unknown }) {
	const t = useT();
	if (value == null || typeof value === "number" || typeof value === "boolean") {
		return <span className="whitespace-pre-wrap break-words text-[var(--omp-muted)]">{String(value ?? "—")}</span>;
	}
	if (typeof value === "string" && value.length <= INLINE_VALUE_MAX_CHARS && !value.includes("\n")) {
		return <span className="whitespace-pre-wrap break-words text-[var(--omp-muted)]">{value}</span>;
	}
	return (
		<details className="group/kv">
			<summary className="cursor-pointer list-none text-[var(--omp-dim)] transition-colors hover:text-[var(--omp-text)]">
				<span className="select-none">{t("tools.generic.expand")}</span>
				<span className="ml-1.5 tabular-nums opacity-70">
					{Array.isArray(value)
						? `[…] ${value.length}`
						: typeof value === "object"
							? `{…} ${Object.keys(value).length}`
							: ""}
				</span>
			</summary>
			<div className="mt-1">
				{typeof value === "string" ? (
					<ToolTextPreview text={value} />
				) : (
					<JsonTree hideRootKeys={false} label={name} value={value} />
				)}
			</div>
		</details>
	);
}

/** Object payload as key/value rows. */
export function KeyValueView({ value }: { value: Record<string, unknown> }) {
	const entries = Object.entries(value);
	if (entries.length === 0) return <span className="text-[var(--omp-dim)]">—</span>;
	return (
		<div className="flex flex-col gap-0.5 font-mono text-omp-sm leading-[1.45]">
			{entries.map(([key, val]) => (
				<div key={key} className="flex items-start gap-2">
					<span className="shrink-0 select-none text-[var(--omp-dim)]">{key}</span>
					<span className="shrink-0 select-none text-[var(--omp-border-strong)]">·</span>
					<span className="min-w-0 flex-1">
						<ValueView name={key} value={val} />
					</span>
				</div>
			))}
		</div>
	);
}

/**
 * A tool's text output as stock's default renderer shows it: `(no output)`
 * when empty, the error text on failure, a JSON tree when the text parses as
 * an object or array, markdown when the caller opts in, else plain/ANSI text.
 */
export function ToolResultBody({ text, isError, markdown }: { text: string; isError?: boolean; markdown?: boolean }) {
	const t = useT();
	const output = text.trimEnd();
	if (!output) return <div className="text-sc-xs text-(--sc-text-subtle)">{t("tools.generic.noOutput")}</div>;
	if (isError) return <ToolTextPreview isError text={output} />;
	const json = parseJsonOutput(output);
	if (json.ok) return <JsonTree label={t("tools.generic.result")} value={json.value} />;
	if (markdown) {
		return (
			<div className="text-sc-sm">
				<MarkdownRenderer content={output} />
			</div>
		);
	}
	return <ToolTextPreview text={output} />;
}

function SectionLabel({ children, error }: { children: string; error?: boolean }) {
	return (
		<div
			className={cx(
				"mb-0.5 text-omp-xxs font-semibold uppercase tracking-wider",
				error ? "text-[var(--omp-error)]" : "text-[var(--omp-dim)]",
			)}
		>
			{children}
		</div>
	);
}

/**
 * Fallback renderer for tools without their own card (checkpoint, rewind,
 * context notes, skills, extensions), after stock pi-tui
 * `tools/default-renderer.ts`: arguments without the intent, the result body
 * (JSON tree / text / `(no output)`), the truncation notice from
 * `details.meta`. Stock hides `details`; here they fold one click down.
 */
export function GenericRenderer({ args, result, isError, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const effective = isPartial && partialResult != null ? partialResult : result;
	// Image-only results render as images instead of dumping base64 as text.
	const image = extractImageDataUrl(effective);
	const details = resultDetails(effective);
	const truncation = metaTruncation(details);
	const body = truncation ? stripGeneratedOutputNotice(resultText(effective)) : resultText(effective);
	const shownArgs = visibleToolArgs(args);
	const shownDetails = details ? Object.fromEntries(Object.entries(details).filter(([key]) => key !== "meta")) : {};
	return (
		<div className="flex flex-col gap-1.5">
			{Object.keys(shownArgs).length > 0 && (
				<div>
					<SectionLabel>{t("tools.generic.args")}</SectionLabel>
					<KeyValueView value={shownArgs} />
				</div>
			)}
			{effective != null && (
				<div>
					<SectionLabel error={isError}>
						{isPartial ? t("tools.generic.partialResult") : t("tools.generic.result")}
					</SectionLabel>
					{image ? (
						<ZoomableImage
							src={image}
							alt={t("tools.image.alt")}
							className="max-h-72 rounded-md border border-[var(--omp-border-muted)] object-contain"
						/>
					) : (
						<ToolResultBody isError={isError} text={body} />
					)}
					{truncation && <TruncationNote notice={truncation} />}
				</div>
			)}
			{Object.keys(shownDetails).length > 0 && (
				<details className="group/details">
					<summary className="cursor-pointer list-none text-omp-xxs font-semibold uppercase tracking-wider text-[var(--omp-dim)] transition-colors hover:text-[var(--omp-text)]">
						{t("tools.generic.details")}
					</summary>
					<div className="mt-1">
						<KeyValueView value={shownDetails} />
					</div>
				</details>
			)}
		</div>
	);
}

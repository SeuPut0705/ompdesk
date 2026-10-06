import { Check, MessageCircleQuestion } from "lucide-react";
import { resultDetails, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ToolRendererProps } from "./ToolCard";
import { asArray, asRecord, asString } from "./task-render-utils";

interface AskOption {
	label: string;
	description?: string;
}

function optionsFrom(value: unknown): AskOption[] {
	return asArray(value).flatMap(item => {
		if (typeof item === "string") return [{ label: item }];
		const option = asRecord(item);
		return typeof option?.label === "string"
			? [{ label: option.label, description: asString(option.description) }]
			: [];
	});
}

/** Original questions and authoritative selections, for live and restored results. */
export function AskRenderer({ args, result, isPartial, isError }: ToolRendererProps) {
	const t = useT();
	const details = resultDetails(result) ?? asRecord(result);
	const answers = asArray(details?.results)
		.map(asRecord)
		.filter(item => item !== undefined);
	const original = asArray(args.questions)
		.map(asRecord)
		.filter(item => item !== undefined);
	const questions = original.length > 0 ? original : answers.length > 0 ? answers : [args];
	const hasStructuredAnswer =
		answers.length > 0 || Array.isArray(details?.selectedOptions) || typeof details?.customInput === "string";
	const fallback = !hasStructuredAnswer || isError ? resultText(result).trim() : "";

	return (
		<div className="flex flex-col gap-3">
			{questions.map((question, index) => {
				const answer =
					(typeof question.id === "string" ? answers.find(item => item.id === question.id) : answers[index]) ??
					(questions.length === 1 ? details : undefined);
				const text = asString(question.question) ?? asString(question.message) ?? asString(answer?.question);
				const originalOptions = optionsFrom(question.options);
				const options = originalOptions.length > 0 ? originalOptions : optionsFrom(answer?.options);
				const selected = new Set(
					asArray(answer?.selectedOptions).filter((item): item is string => typeof item === "string"),
				);
				return (
					<section className="flex flex-col gap-1.5" key={asString(question.id) ?? index}>
						<div className="flex items-start gap-1.5 text-omp-sm">
							<MessageCircleQuestion size={13} className="mt-0.5 shrink-0 text-(--omp-md-link)" />
							<span className="min-w-0 flex-1 leading-relaxed text-(--omp-text)">
								{text || t("tools.ask.questionFallback")}
							</span>
						</div>
						{options.length > 0 && (
							<div className="flex flex-col gap-1 pl-5">
								{options.map((option, optionIndex) => {
									const chosen = selected.has(option.label);
									return (
										<div
											key={optionIndex}
											className={
												"flex items-start gap-2 rounded-md px-2 py-1 text-omp-sm " +
												(chosen ? "bg-(--omp-selected-bg) text-(--omp-text)" : "text-(--omp-muted)")
											}
										>
											{chosen ? (
												<Check
													aria-label={t("tools.ask.selected")}
													size={13}
													className="mt-1 shrink-0 text-(--omp-success)"
												/>
											) : (
												<span className="mt-1 h-3 w-3 shrink-0 rounded-full border border-(--omp-border-muted)" />
											)}
											<div className="min-w-0">
												<div>{option.label}</div>
												{option.description && (
													<div className="text-omp-xs text-(--omp-dim)">{option.description}</div>
												)}
											</div>
										</div>
									);
								})}
							</div>
						)}
						{selected.size > 0 && (
							<div className="pl-5 text-omp-sm text-(--omp-text)">
								{t("tools.ask.answered", { answer: [...selected].join(", ") })}
							</div>
						)}
						{typeof answer?.customInput === "string" && (
							<div className="pl-5 whitespace-pre-wrap text-omp-sm text-(--omp-text)">{answer.customInput}</div>
						)}
						{typeof answer?.note === "string" && (
							<div className="pl-5 whitespace-pre-wrap text-omp-xs text-(--omp-muted)">{answer.note}</div>
						)}
						{answer?.timedOut === true && (
							<div className="pl-5 text-omp-xs text-(--omp-warning)">{t("tools.ask.timedOut")}</div>
						)}
					</section>
				);
			})}
			{details?.chatRedirect === true && (
				<div className="text-omp-sm text-(--omp-muted)">{t("tools.ask.chatRedirect")}</div>
			)}
			{fallback && (
				<div className={`whitespace-pre-wrap text-omp-sm ${isError ? "text-(--omp-error)" : "text-(--omp-muted)"}`}>
					{fallback}
				</div>
			)}
			{isPartial && (
				<div role="status" className="text-omp-xs text-(--omp-dim)">
					{t("tools.ask.waiting")}
				</div>
			)}
		</div>
	);
}

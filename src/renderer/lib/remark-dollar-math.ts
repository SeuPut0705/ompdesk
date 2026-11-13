import { asciiDigit, markdownLineEndingOrSpace } from "micromark-util-character";
import type { Construct, Effects, State, TokenizeContext, Tokenizer } from "micromark-util-types";
import type {} from "remark-parse";
import type { Processor } from "unified";

const DOLLAR = 36;

/**
 * Hold remark-math's single-dollar text math to Pandoc's rule so prices are text: after the opening `$` comes a
 * non-space, and the `$` that would close it follows a non-space and is not followed by a digit. `월 $149 … $26/월`
 * has neither a closer after a non-space nor one before a non-digit, so it stays as typed; `$x^2$` and `$$…$$` are
 * untouched. Must run after `remarkMath`: it wraps the construct that plugin registered.
 */
export function remarkDollarMath(this: Processor): void {
	for (const extension of this.data().micromarkExtensions ?? []) {
		const text = extension.text;
		const construct = text?.[DOLLAR];
		if (text && construct && !Array.isArray(construct) && construct.name === "mathText") {
			text[DOLLAR] = guard(construct);
		}
	}
}

function guard(math: Construct): Construct {
	const tokenize: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
		const inner = math.tokenize.call(this, effects, ok, nok);
		return effects.check({ tokenize: tokenizeShape, partial: true }, inner, nok);
	};
	return { ...math, tokenize };
}

/** Looks ahead from a `$`: passes a run of two or more, or a lone `$` whose first lone closing `$` is a valid one. */
function tokenizeShape(effects: Effects, ok: State, nok: State): State {
	let afterSpace = false;
	let run = 0;
	return start;

	function start(code: number | null): State | undefined {
		effects.enter("data");
		effects.consume(code);
		return open;
	}

	function open(code: number | null): State | undefined {
		if (code === DOLLAR) return multiple(code);
		if (code === null || markdownLineEndingOrSpace(code)) return nok(code);
		return content(code);
	}

	function multiple(code: number | null): State | undefined {
		if (code === DOLLAR) {
			effects.consume(code);
			return multiple;
		}
		effects.exit("data");
		return ok(code);
	}

	function content(code: number | null): State | undefined {
		if (code === null) return nok(code);
		if (code === DOLLAR) {
			run = 0;
			return sequence(code);
		}
		afterSpace = markdownLineEndingOrSpace(code);
		effects.consume(code);
		return content;
	}

	function sequence(code: number | null): State | undefined {
		if (code === DOLLAR) {
			effects.consume(code);
			run++;
			return sequence;
		}
		if (run > 1) {
			afterSpace = false;
			return content(code);
		}
		if (afterSpace || asciiDigit(code)) return nok(code);
		effects.exit("data");
		return ok(code);
	}
}

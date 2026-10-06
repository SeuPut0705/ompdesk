import type {} from "micromark-extension-math";
import { factorySpace } from "micromark-factory-space";
import { markdownLineEnding } from "micromark-util-character";
import type { Construct, Effects, State, Tokenizer } from "micromark-util-types";
import type {} from "remark-parse";
import type { Processor } from "unified";

/** Recognize TeX delimiters before Markdown escapes and setext headings. */
export function remarkLatexMath(this: Processor): void {
	const data = this.data();
	data.micromarkExtensions ??= [];
	data.micromarkExtensions.push({
		flow: { 92: { tokenize: tokenizeLatexMath(true), concrete: true } },
		text: { 92: { tokenize: tokenizeLatexMath(false) } },
	});
}

// Emit remark-math's existing tokens so both notations share its AST and the
// sanitized KaTeX pipeline. Micromark keeps code, HTML and escapes out of here.
function tokenizeLatexMath(display: boolean): Tokenizer {
	return (effects, ok, nok) => {
		const math = display ? "mathFlow" : "mathText";
		const fence = display ? "mathFlowFence" : "mathTextSequence";
		const value = display ? "mathFlowValue" : "mathTextData";
		const close: Construct = { tokenize: tokenizeClose, partial: true };
		return start;

		function start(code: number | null): State | undefined {
			effects.enter(math);
			effects.enter(fence);
			effects.consume(code);
			return open;
		}

		function open(code: number | null): State | undefined {
			if (code !== (display ? 91 : 40)) return nok(code);
			effects.consume(code);
			effects.exit(fence);
			return beforeData;
		}

		function beforeData(code: number | null): State | undefined {
			if (code === null) return nok(code);
			if (markdownLineEnding(code)) {
				effects.enter("lineEnding");
				effects.consume(code);
				effects.exit("lineEnding");
				return beforeData;
			}
			if (code === 92) return effects.attempt(close, after, escapedData)(code);
			effects.enter(value);
			return data(code);
		}

		function data(code: number | null): State | undefined {
			if (code === null || code === 92 || markdownLineEnding(code)) {
				effects.exit(value);
				return beforeData(code);
			}
			effects.consume(code);
			return data;
		}

		function escapedData(code: number | null): State | undefined {
			effects.enter(value);
			effects.consume(code);
			return escapedCharacter;
		}

		function escapedCharacter(code: number | null): State | undefined {
			if (code === null || markdownLineEnding(code)) return data(code);
			effects.consume(code);
			return data;
		}

		function after(code: number | null): State | undefined {
			if (display) return factorySpace(effects, end, "whitespace")(code);
			return end(code);
		}

		function end(code: number | null): State | undefined {
			if (display && code !== null && !markdownLineEnding(code)) return nok(code);
			effects.exit(math);
			return ok(code);
		}

		function tokenizeClose(closeEffects: Effects, closeOk: State, closeNok: State): State {
			return slash;

			function slash(code: number | null): State | undefined {
				closeEffects.enter(fence);
				closeEffects.consume(code);
				return bracket;
			}

			function bracket(code: number | null): State | undefined {
				if (code !== (display ? 93 : 41)) return closeNok(code);
				closeEffects.consume(code);
				closeEffects.exit(fence);
				return closeOk;
			}
		}
	};
}

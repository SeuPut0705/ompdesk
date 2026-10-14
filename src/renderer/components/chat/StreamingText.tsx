import { useMemo } from "react";
import { STREAM_FORMAT_FLUSH_MS, useThrottledText } from "../../hooks/use-throttled-text";
import { MarkdownRenderer } from "../../lib/markdown";
import { renderableTail, segmentStreamingMarkdown } from "../../lib/streaming-markdown";
import { useMessagesStore } from "../../stores/messages";

/**
 * Live tail of the assistant's in-flight reply. The store accumulates
 * text_delta events into `streamingText`. Presentation is aligned to browser
 * frames, then split into immutable Markdown blocks that parse once, plus the
 * unfinished tail, which re-renders as Markdown every frame through the same
 * sanitized pipeline in its streaming form: fences stay plain code until they
 * close, and a last line holding only a marker waits for its content. Only an
 * open display-math block shows as source, since TeX typesets once closed.
 */
export function StreamingText() {
	const streamingText = useMessagesStore(s => s.streamingText);
	const text = useThrottledText(streamingText, STREAM_FORMAT_FLUSH_MS);
	const segments = useMemo(() => segmentStreamingMarkdown(text), [text]);
	const tail = segments.mathOpen ? segments.tail : renderableTail(segments.tail);
	if (!streamingText) return null;

	return (
		<div className="omp-streaming">
			{segments.blocks.map(block => (
				<div className="omp-streaming-block" key={block.end}>
					<MarkdownRenderer content={block.content} />
				</div>
			))}
			{segments.mathOpen ? (
				<div className="omp-streaming-tail">
					{tail}
					<span aria-hidden className="omp-caret" />
				</div>
			) : (
				<div className="omp-streaming-tail omp-streaming-tail--markdown">
					{tail.trim() ? <MarkdownRenderer content={tail} streaming /> : null}
					<span aria-hidden className="omp-caret" />
				</div>
			)}
		</div>
	);
}

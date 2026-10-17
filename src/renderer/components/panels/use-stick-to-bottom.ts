/**
 * The main transcript's scroll behaviour for a list that is not virtualized: it
 * follows the live edge while the reader stays there, a reader's gesture away
 * from the edge (wheel up, a key, the scrollbar, a touch) takes the viewport
 * and nothing moves it again until they come back or ask for the latest.
 * Content growth is followed in the same frame it is laid out (ResizeObserver),
 * so streamed output is never painted below the fold. Same edge rule
 * (`isTranscriptAtLiveEdge`) as ChatStream.
 */

import {
	type KeyboardEvent,
	type PointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
	type WheelEvent,
} from "react";
import { isTranscriptAtLiveEdge } from "../chat/chat-stream-utils";

export interface StickToBottom {
	scrollerRef: RefObject<HTMLDivElement | null>;
	contentRef: RefObject<HTMLDivElement | null>;
	/** The view follows the live edge; false shows "jump to latest". */
	pinned: boolean;
	jumpToLatest: () => void;
	scrollerProps: {
		onScroll: () => void;
		onWheel: (event: WheelEvent<HTMLDivElement>) => void;
		onTouchMove: () => void;
		onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
		onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
	};
}

export function useStickToBottom(): StickToBottom {
	const scrollerRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const [pinned, setPinned] = useState(true);
	const pinnedRef = useRef(true);
	// The offset the follower last wrote: the scroll event that write raises is not the reader moving.
	const writtenTop = useRef<number | null>(null);

	const pin = useCallback((next: boolean) => {
		pinnedRef.current = next;
		setPinned(current => (current === next ? current : next));
	}, []);

	const follow = useCallback(() => {
		const el = scrollerRef.current;
		if (!el) return;
		const top = Math.max(0, el.scrollHeight - el.clientHeight);
		if (Math.abs(el.scrollTop - top) < 1) return;
		writtenTop.current = top;
		el.scrollTop = top;
	}, []);

	useEffect(() => {
		const el = scrollerRef.current;
		const content = contentRef.current;
		if (!el || !content || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (pinnedRef.current) follow();
		});
		observer.observe(content);
		observer.observe(el);
		return () => observer.disconnect();
	}, [follow]);

	const onScroll = useCallback(() => {
		const el = scrollerRef.current;
		if (!el) return;
		if (writtenTop.current !== null && Math.abs(el.scrollTop - writtenTop.current) < 1) {
			writtenTop.current = null;
			return;
		}
		writtenTop.current = null;
		pin(isTranscriptAtLiveEdge(el));
	}, [pin]);

	const jumpToLatest = useCallback(() => {
		pin(true);
		follow();
	}, [pin, follow]);

	return {
		scrollerRef,
		contentRef,
		pinned,
		jumpToLatest,
		scrollerProps: {
			onScroll,
			// Up is a gesture away from the edge: take the viewport before the next frame's growth can pull it back.
			onWheel: event => {
				if (event.deltaY < 0) pin(false);
			},
			onTouchMove: () => {
				const el = scrollerRef.current;
				if (el && !isTranscriptAtLiveEdge(el)) pin(false);
			},
			onPointerDown: event => {
				// The scrollbar's gutter: a press there is the reader taking the viewport.
				if (event.clientX >= event.currentTarget.getBoundingClientRect().right - 20) pin(false);
			},
			onKeyDown: event => {
				if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pin(false);
			},
		},
	};
}

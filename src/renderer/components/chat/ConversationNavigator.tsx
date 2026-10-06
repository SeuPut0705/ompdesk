import { useRef, useState } from "react";
import { cx, formatShortClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ConversationAnchor } from "./chat-stream-utils";

interface ConversationNavigatorProps {
	activeIndex: number;
	anchors: readonly ConversationAnchor[];
	onNavigate: (rowIndex: number) => void;
}

export function ConversationNavigator({ activeIndex, anchors, onNavigate }: ConversationNavigatorProps) {
	const t = useT();
	const [previewIndex, setPreviewIndex] = useState<number | null>(null);
	const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);
	if (anchors.length < 2) return null;

	const density = anchors.length > 64 ? "is-compact" : anchors.length > 32 ? "is-dense" : undefined;
	const focusMarker = (index: number) => {
		const bounded = Math.max(0, Math.min(index, anchors.length - 1));
		buttonsRef.current[bounded]?.focus();
		setPreviewIndex(bounded);
	};

	return (
		<nav className="omp-conversation-nav" aria-label={t("chat.navigator.label")}>
			<div className={cx("omp-conversation-nav-stack", density)}>
				{anchors.map((anchor, index) => {
					const preview = anchor.preview || t("chat.navigator.imagePrompt");
					const clock = previewIndex === index ? formatShortClock(anchor.timestamp) : "";
					return (
						<div key={anchor.key} className="omp-conversation-nav-slot">
							<button
								ref={element => {
									buttonsRef.current[index] = element;
								}}
								type="button"
								aria-current={index === activeIndex ? "location" : undefined}
								aria-label={t("chat.navigator.jumpTo", {
									current: index + 1,
									total: anchors.length,
									preview,
								})}
								tabIndex={index === activeIndex ? 0 : -1}
								className={cx("omp-conversation-nav-marker", index === activeIndex && "is-active")}
								onBlur={() => setPreviewIndex(current => (current === index ? null : current))}
								onClick={() => onNavigate(anchor.rowIndex)}
								onFocus={() => setPreviewIndex(index)}
								onMouseEnter={() => setPreviewIndex(index)}
								onMouseLeave={() => setPreviewIndex(current => (current === index ? null : current))}
								onKeyDown={event => {
									if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
										event.preventDefault();
										focusMarker(index - 1);
									} else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
										event.preventDefault();
										focusMarker(index + 1);
									} else if (event.key === "Home") {
										event.preventDefault();
										focusMarker(0);
									} else if (event.key === "End") {
										event.preventDefault();
										focusMarker(anchors.length - 1);
									}
								}}
							/>
							{previewIndex === index ? (
								<div role="tooltip" className="omp-conversation-nav-preview">
									<div className="omp-conversation-nav-preview-kicker">
										<span>{t("chat.navigator.turn", { current: index + 1, total: anchors.length })}</span>
										{clock ? <time>{clock}</time> : null}
									</div>
									<p>{preview}</p>
									<span className="omp-conversation-nav-preview-hint">{t("chat.navigator.hint")}</span>
								</div>
							) : null}
						</div>
					);
				})}
			</div>
		</nav>
	);
}

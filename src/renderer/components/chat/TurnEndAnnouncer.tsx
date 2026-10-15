import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { describeTurnError } from "../../lib/messages";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";

/**
 * A polite screen-reader line when a turn ends, saying how it ended: complete,
 * stopped by the user, or failed (with the humanized reason). The region is
 * emptied when the next turn starts, so the same outcome is announced again.
 */
export function TurnEndAnnouncer() {
	const t = useT();
	const isStreaming = useSessionStore(state => state.isStreaming);
	const wasStreaming = useRef(isStreaming);
	const [announcement, setAnnouncement] = useState("");

	useEffect(() => {
		if (isStreaming === wasStreaming.current) return;
		wasStreaming.current = isStreaming;
		if (isStreaming) {
			setAnnouncement("");
			return;
		}
		const last = useMessagesStore.getState().messages.findLast(message => message.role === "assistant");
		const stopReason = last && "stopReason" in last ? last.stopReason : undefined;
		if (stopReason === "aborted") setAnnouncement(t("chat.turnEnd.stopped"));
		else if (stopReason === "error") {
			const errorMessage = last && "errorMessage" in last ? last.errorMessage : undefined;
			setAnnouncement(
				t("chat.turnEnd.failed", {
					reason: t(describeTurnError(typeof errorMessage === "string" ? errorMessage : undefined).titleKey),
				}),
			);
		} else setAnnouncement(t("chat.turnEnd.complete"));
	}, [isStreaming, t]);

	return (
		<span aria-atomic="true" aria-live="polite" className="sr-only" data-turn-end-announcer role="status">
			{announcement}
		</span>
	);
}

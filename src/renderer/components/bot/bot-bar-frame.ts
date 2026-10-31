/**
 * The bot's bar's frame, shared by the bar (`BotBar`, lazy) and the static frame `BotPane` draws until it loads, so the
 * conversation below never moves when it arrives. The outer box keeps the transcript's column beside a docked work
 * board (`.omp-bot-column`, components.css); `-order-2` keeps it above the status strip, which a phone or tablet shell
 * moves to the top of the pane (mobile.css).
 */
export const BOT_BAR_FRAME = {
	outer: "omp-bot-column -order-2 shrink-0 pt-2",
	inner: "omp-composer-shell flex h-9 min-w-0 items-center gap-2.5",
} as const;

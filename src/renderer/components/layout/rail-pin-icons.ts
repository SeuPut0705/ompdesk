/** The lucide glyph of each pinned sidebar shortcut: the sidebar's footer rows and Settings › General's switches share it. */
import {
	BarChart3,
	Bot,
	CalendarClock,
	Files,
	Gauge,
	GitCompareArrows,
	Globe,
	Hourglass,
	type LucideIcon,
	Terminal,
} from "lucide-react";
import type { RailPin } from "../../stores/sidebar-prefs";

export const RAIL_PIN_ICONS: Record<RailPin, LucideIcon> = {
	usage: Gauge,
	agents: Bot,
	stats: BarChart3,
	terminal: Terminal,
	diff: GitCompareArrows,
	preview: Globe,
	files: Files,
	jobs: Hourglass,
	schedules: CalendarClock,
};

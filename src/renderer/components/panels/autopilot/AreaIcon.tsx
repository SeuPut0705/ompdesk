import {
	BookOpen,
	Bug,
	CircleHelp,
	FlaskConical,
	Palette,
	Rocket,
	Sparkles,
	UserRound,
	Wrench,
	Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import type { AutopilotCycleArea } from "../../../../../resources/gui-bridge/modes/autopilot-contracts";

const ICONS: Record<AutopilotCycleArea | "unreported", ReactNode> = {
	design: <Palette />,
	performance: <Zap />,
	features: <Sparkles />,
	refactoring: <Wrench />,
	tests: <FlaskConical />,
	bugs: <Bug />,
	docs: <BookOpen />,
	user: <UserRound />,
	release: <Rocket />,
	unreported: <CircleHelp />,
};

/** The glyph of one cycle's area (timeline rows, the area mix, the work board card). */
export function AreaIcon({ area }: { area: AutopilotCycleArea | "unreported" }) {
	return (
		<span
			aria-hidden
			className="inline-flex shrink-0 items-center justify-center text-(--sc-text-muted) [&>svg]:size-(--sc-icon-sm)"
		>
			{ICONS[area]}
		</span>
	);
}

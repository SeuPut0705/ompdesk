/**
 * The auto button inside a title editor: asks the session's omp for a fresh title (hooks/use-auto-title.ts).
 *
 * It sits inside the field, so pressing it must not blur the field: the title bar's and the sidebar's inputs save
 * on blur, which would commit the half-typed name as a manual one before the click lands. A session with no open tab
 * has no omp to ask: `unavailableReason` marks the button aria-disabled (not `disabled`, which would take the
 * mouse-down away from this handler and blur the field, and would silence the tooltip) and becomes its tooltip.
 */
import { Sparkles } from "lucide-react";
import { useT } from "../../lib/i18n";
import { IconButton } from "./IconButton";

interface AutoTitleButtonProps {
	pending: boolean;
	onClick: () => void;
	/** Why there is nothing to ask (no open tab); the button is inert and says so. */
	unavailableReason?: string;
}

export function AutoTitleButton({ pending, onClick, unavailableReason }: AutoTitleButtonProps) {
	const t = useT();
	const unavailable = unavailableReason !== undefined;
	return (
		<IconButton
			aria-disabled={unavailable || undefined}
			className={unavailable ? "cursor-not-allowed opacity-50" : undefined}
			data-auto-title=""
			icon={<Sparkles />}
			label={unavailableReason ?? t("titleAuto.label")}
			loading={pending}
			onClick={unavailable ? undefined : onClick}
			onMouseDown={event => event.preventDefault()}
			size="sm"
			tabIndex={-1}
		/>
	);
}

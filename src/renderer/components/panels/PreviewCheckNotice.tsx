import { useT } from "../../lib/i18n";
import { Banner } from "../common";

/**
 * What the judge model saw on an agent visual's page once it loaded (main/preview/preview-check.ts): a quiet line
 * above the page that never blocks it. Only while a native judge answers; with none, the Preview shows nothing here.
 */
export function PreviewCheckNotice({ problem, onDismiss }: { problem: "error" | "blank"; onDismiss: () => void }) {
	const t = useT();
	return (
		<Banner live onDismiss={onDismiss}>
			<span data-preview-check={problem}>
				{t(problem === "error" ? "panel.preview.check.error" : "panel.preview.check.blank")}
			</span>
		</Banner>
	);
}

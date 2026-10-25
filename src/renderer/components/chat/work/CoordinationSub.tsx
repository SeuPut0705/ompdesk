import { useOpenedChildren } from "../../../hooks/use-opened-children";
import { useT } from "../../../lib/i18n";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import type { ToolEntry } from "../../../stores/tools";
import { coordinationWords } from "./coordination";

/**
 * The head's live line for a session-control call, with the ids it names resolved to the children's titles from the
 * rows the work board already reads. Mounted only while such a call runs, so the other cards never subscribe to the
 * tab list for it.
 */
export function CoordinationSub({ entry }: { entry: ToolEntry }) {
	const t = useT();
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const { rows } = useOpenedChildren(runtimeTabId ?? activeTabId);
	const text = coordinationWords(entry, t, id => rows.find(row => row.tabId === id || row.key === id)?.title);
	return (
		<div className="omp-work-sub" title={text}>
			{text}
		</div>
	);
}

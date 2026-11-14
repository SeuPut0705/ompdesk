import { type ComponentProps, Suspense, useState } from "react";
import { useMediaQuery } from "../../hooks/use-media-query";
import { lazyChunk } from "../../lib/chunk-load";
import type { ConversationNavigator as Navigator } from "./ConversationNavigatorView";

const Rail = lazyChunk(() =>
	import("./ConversationNavigatorView").then(module => ({ default: module.ConversationNavigator })),
);

/** The rail is hidden below 960px by components.css; a phone need not load it. Keep a loaded rail across resizes. */
export function ConversationNavigator(props: ComponentProps<typeof Navigator>) {
	const narrow = useMediaQuery("(max-width: 959px)");
	const [activated, setActivated] = useState(!narrow);
	if (!narrow && !activated) setActivated(true);
	if (!activated) return null;
	return (
		<Suspense fallback={null}>
			<Rail {...props} />
		</Suspense>
	);
}

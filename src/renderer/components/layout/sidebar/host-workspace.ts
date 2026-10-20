import { useEffect, useState } from "react";
import { snapshotNs, snapshots } from "../../../lib/snapshot-cache";

/**
 * A paired host's no-project workspace (`~/.omp/work` there), which puts its sessions in the Chat lane
 * (`inChatLane`) as the host's own sidebar does. Its last answer (snapshot cache, `panel` kind, the host's namespace)
 * paints first; `read` asks the host again (only while it is linked). Null for this computer or before any answer:
 * the kind alone decides the lane. An answer is kept with its device, so a late one for another host is never used.
 */
export function useHostWorkspace(device: string | undefined, read: boolean): string | null {
	const [answer, setAnswer] = useState<[string, string]>();
	useEffect(() => {
		if (device && read)
			window.omp.sidecar.defaultWorkspace(device).then(
				workspace => {
					snapshots().write("panel", snapshotNs(device), "workspace", workspace);
					setAnswer([device, workspace]);
				},
				() => undefined,
			);
	}, [device, read]);
	if (answer && answer[0] === device) return answer[1];
	return device ? (snapshots().read<string>("panel", snapshotNs(device), "workspace")?.value ?? null) : null;
}

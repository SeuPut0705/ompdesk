import { writeFileSync } from "node:fs";
import {
	lastSwapEntry,
	parsePendingInstall,
	parseStartFailure,
	previousInstallDetails,
	relaunchPresence,
	startFailureOf,
	startMarkJson,
	windowPresenceOf,
} from "../../update-log-core";

const pendingRaw = [
	'{"from":"1","to":"2","mode":"relaunch","trigger":"auto","at":0,"presence":"hidden"}',
	'{"from":"1","to":"2","mode":"nsis","trigger":"quit","at":-1,"presence":"bad"}',
	'{"from":"1","to":"2","mode":"other","trigger":"auto","at":0}',
	"null",
	"bad",
];
const failureRaw = ['{"version":"2","at":5,"count":2.9}', '{"version":"2","at":5}', '{"version":"2"}', "bad"];
const logs = [
	"swap t: /a -> /b\ninstalled\nstart failed; previous app restored\n",
	"swap t: /a -> /b\nnoise\n",
	"nothing",
];
const pending = parsePendingInstall(pendingRaw[0]!)!;
const swap = lastSwapEntry(logs[0]!);
const rows = {
	pending: pendingRaw.map(raw => ({ raw, result: parsePendingInstall(raw) ?? null })),
	failures: failureRaw.map(raw => ({ raw, result: parseStartFailure(raw) ?? null })),
	swaps: logs.map(raw => ({ raw, result: lastSwapEntry(raw) ?? null })),
	presence: [
		[],
		[{ visible: false, minimized: false, focused: false }],
		[{ visible: true, minimized: true, focused: false }],
		[{ visible: true, minimized: false, focused: false }],
		[{ visible: true, minimized: false, focused: true }],
	].map(windows => ({ windows, result: windowPresenceOf(windows) ?? null })),
	relaunch: [-1, 0, 900000, 900001].map(now => ({ now, result: relaunchPresence(pending, now) ?? null })),
	details: ["1", "2", "3"].map(current => ({ current, result: previousInstallDetails(pending, current, swap) })),
	failure: startFailureOf(pending, "1", swap, 5) ?? null,
	mark: startMarkJson("2", 42, 5),
};
writeFileSync(
	new URL("../../../../native/ompdesk/crates/shell/src/updater_core/records_captured.json", import.meta.url),
	`${JSON.stringify(rows, null, 2)}\n`,
);

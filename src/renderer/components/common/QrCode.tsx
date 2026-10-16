/**
 * QrCode — `value` as a QR code (error correction M), drawn locally as one SVG path from
 * `qrcode-generator`'s module matrix; no image service ever sees the value (a pairing code rides it).
 * Always black on white with the standard four-module quiet zone, in light and dark themes alike:
 * phone cameras read dark modules on a light ground. `title` is its accessible name.
 */
import qrcode from "qrcode-generator";
import { useMemo } from "react";

const QUIET_ZONE = 4;

/** The SVG path (module units, quiet zone included) and the side length of `value`'s QR code. */
export function qrPath(value: string): { path: string; size: number } {
	const code = qrcode(0, "M");
	code.addData(value);
	code.make();
	const count = code.getModuleCount();
	let path = "";
	for (let row = 0; row < count; row += 1) {
		let col = 0;
		while (col < count) {
			if (!code.isDark(row, col)) {
				col += 1;
				continue;
			}
			const start = col;
			while (col < count && code.isDark(row, col)) col += 1;
			path += `M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${col - start}v1h-${col - start}z`;
		}
	}
	return { path, size: count + QUIET_ZONE * 2 };
}

export function QrCode({ value, title, size = 160 }: { value: string; title: string; size?: number }) {
	const qr = useMemo(() => qrPath(value), [value]);
	return (
		<svg
			aria-label={title}
			className="shrink-0 rounded-(--sc-radius-md)"
			data-qr-code
			height={size}
			role="img"
			shapeRendering="crispEdges"
			viewBox={`0 0 ${qr.size} ${qr.size}`}
			width={size}
		>
			<title>{title}</title>
			<rect fill="#ffffff" height={qr.size} width={qr.size} />
			<path d={qr.path} fill="#000000" />
		</svg>
	);
}

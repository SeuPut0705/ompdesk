// Posts a real left-button drag with CGEventPost: press at (x, y), move by (dx, dy) in steps, release.
//   swift scripts/shell-drag-check.swift <x> <y> <dx> <dy>      (coordinates: points, top-left origin, as the page's screenX/screenY)
// Exit 3 when the system refuses to post events (TCC: the process lacks the Accessibility grant), with the reason on stderr.
import ApplicationServices
import Foundation

let a = CommandLine.arguments.dropFirst().compactMap { Double($0) }
guard a.count == 4 else {
	FileHandle.standardError.write("usage: shell-drag-check.swift x y dx dy\n".data(using: .utf8)!)
	exit(2)
}
// Posting events to other apps is gated by the Accessibility (Privacy & Security) grant of the calling process.
if !AXIsProcessTrusted() {
	FileHandle.standardError.write("AXIsProcessTrusted() is false: Accessibility is not granted to the process that runs this helper, so CGEventPost is refused\n".data(using: .utf8)!)
	exit(3)
}
let source = CGEventSource(stateID: .hidSystemState)
func post(_ type: CGEventType, _ x: Double, _ y: Double) {
	CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?.post(tap: .cghidEventTap)
}
post(.mouseMoved, a[0], a[1])
usleep(150_000)
post(.leftMouseDown, a[0], a[1])
for step in 1...12 {
	usleep(25_000)
	post(.leftMouseDragged, a[0] + a[2] * Double(step) / 12, a[1] + a[3] * Double(step) / 12)
}
usleep(100_000)
post(.leftMouseUp, a[0] + a[2], a[1] + a[3])

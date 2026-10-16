/**
 * Every main-process string (native menu, dialogs, coded failures) in both UI
 * languages. Pure data, apart from `i18n.ts` (which needs electron), so tests
 * can hold it against the renderer's names for the same things.
 */
import type { UiLanguage } from "../shared/ui-language";

export const MAIN_TEXT = {
	"dialog.openProject": { en: "Open project", ko: "프로젝트 열기" },
	"web.unknownDevice.title": { en: "An unknown device tried to connect", ko: "알 수 없는 기기가 접속을 시도했어요" },
	"web.unknownDevice.body": {
		en: "Mobile web refused it (no paired device). Nothing to do unless it was you.",
		ko: "모바일 웹이 거부했어요(페어링된 기기가 아니에요). 직접 시도한 게 아니라면 할 일은 없어요.",
	},
	"menu.about": { en: "About OMPdesk", ko: "OMPdesk 정보" },
	"menu.checkUpdates": { en: "Check for Updates…", ko: "업데이트 확인…" },
	"menu.services": { en: "Services", ko: "서비스" },
	"menu.hide": { en: "Hide OMPdesk", ko: "OMPdesk 가리기" },
	"menu.hideOthers": { en: "Hide Others", ko: "기타 가리기" },
	"menu.showAll": { en: "Show All", ko: "모두 보기" },
	"menu.quit": { en: "Quit OMPdesk", ko: "OMPdesk 종료" },
	"menu.addToDictionary": { en: "Add to dictionary", ko: "사전에 추가" },
	"menu.copyImage": { en: "Copy Image", ko: "이미지 복사" },
	"menu.closeTab": { en: "Close Tab", ko: "탭 닫기" },
	"menu.closeWindow": { en: "Close Window", ko: "창 닫기" },
	"menu.commandCenter": { en: "Command Palette", ko: "명령 팔레트" },
	"menu.capabilities": { en: "Agent Behavior", ko: "에이전트 동작" },
	"menu.importSession": { en: "Import External Session", ko: "외부 세션 가져오기" },
	"menu.branchPicker": { en: "Branch from Message", ko: "메시지에서 분기" },
	"menu.sessionTree": { en: "Session Tree", ko: "세션 트리" },
	"menu.modelPicker": { en: "Select Model", ko: "모델 선택" },
	"menu.usage": { en: "Usage & Quotas", ko: "사용량 및 할당량" },
	"menu.workspaceChanges": { en: "Git Changes", ko: "Git 변경 사항" },
	"menu.restartCore": { en: "Restart omp", ko: "omp 다시 시작" },
	"menu.contextReport": { en: "Context Report", ko: "컨텍스트 보고서" },
	"menu.debugConsole": { en: "Debugger Console", ko: "디버거 콘솔" },
	"menu.documentation": { en: "Documentation", ko: "문서" },
	"menu.edit": { en: "Edit", ko: "편집" },
	"menu.exportHtml": { en: "Export HTML", ko: "HTML 내보내기" },
	"menu.file": { en: "File", ko: "파일" },
	"menu.handoff": { en: "Handoff", ko: "핸드오프" },
	"menu.help": { en: "Help", ko: "도움말" },
	"menu.hotkeys": { en: "Keyboard Shortcuts", ko: "키보드 단축키" },
	"menu.jobs": { en: "Background Tasks", ko: "백그라운드 작업" },
	"menu.agentHub": { en: "Agent Definitions", ko: "에이전트 정의" },
	"menu.extensions": { en: "Extensions", ko: "확장" },
	"menu.inventory": { en: "Plugins", ko: "플러그인" },
	"menu.modes": { en: "Modes", ko: "모드" },
	"menu.modelRoles": { en: "Model Roles", ko: "모델 역할" },
	"crash.body": {
		en: "This window's renderer has crashed repeatedly and cannot recover on its own. The failure was written to the runtime log ({logPath}) — restarting may help, and sending the log via Help → Send Feedback helps us fix it.",
		ko: "이 창의 렌더러가 반복해서 충돌해 스스로 복구할 수 없어요. 실패 내용은 런타임 로그({logPath})에 기록했어요. 재시작하면 해결될 수 있고, 도움말 → 피드백 보내기로 로그를 보내 주시면 수정에 도움이 돼요.",
	},
	"crash.close": { en: "Close", ko: "닫기" },
	"crash.title": { en: "OMPdesk window crashed", ko: "OMPdesk 창이 충돌했어요" },
	"menu.newChatTab": { en: "New Chat Tab", ko: "새 채팅 탭" },
	"menu.newSession": { en: "New Session", ko: "새 세션" },
	"menu.newTab": { en: "New Tab", ko: "새 탭" },
	"menu.newWindow": { en: "New Window", ko: "새 창" },
	"menu.openProject": { en: "Open Project…", ko: "프로젝트 열기…" },
	"menu.prCenter": { en: "Pull Requests", ko: "풀 리퀘스트" },
	"menu.providers": { en: "Models & Accounts", ko: "모델 및 계정" },
	"menu.reportIssue": { en: "Send Feedback…", ko: "피드백 보내기…" },
	"menu.session": { en: "Session", ko: "세션" },
	"menu.sessionInfo": { en: "Session Info", ko: "세션 정보" },
	"menu.shareSession": { en: "Share Session", ko: "세션 공유" },
	"menu.settings": { en: "Settings…", ko: "설정…" },
	"menu.stats": { en: "All-Sessions Stats", ko: "전체 통계" },
	"menu.togglePanel": { en: "Toggle Side Panel", ko: "사이드 패널 표시/숨기기" },
	"menu.toggleSidebar": { en: "Toggle Sidebar", ko: "사이드바 표시/숨기기" },
	"menu.tools": { en: "Tools", ko: "도구" },
	"menu.view": { en: "View", ko: "보기" },
	"menu.window": { en: "Window", ko: "창" },
	"menu.workspaceDirs": { en: "Projects & Launch", ko: "프로젝트 및 실행" },
	// Electron names role items in English whatever the language; these replace them.
	"menu.undo": { en: "Undo", ko: "실행 취소" },
	"menu.redo": { en: "Redo", ko: "실행 복귀" },
	"menu.cut": { en: "Cut", ko: "오려두기" },
	"menu.copy": { en: "Copy", ko: "복사하기" },
	"menu.paste": { en: "Paste", ko: "붙여넣기" },
	"tray.keepsRunningTitle": { en: "OMPdesk keeps running in the tray", ko: "OMPdesk는 트레이에서 계속 실행돼요" },
	"tray.keepsRunningBody": {
		en: "Click the tray icon to bring the window back. Quit from the tray menu.",
		ko: "트레이 아이콘을 누르면 창이 돌아와요. 종료는 트레이 메뉴에서 해요.",
	},
	"menu.selectAll": { en: "Select All", ko: "전체 선택" },
	"menu.reload": { en: "Reload", ko: "새로고침" },
	"menu.forceReload": { en: "Force Reload", ko: "강제 새로고침" },
	"menu.toggleDevTools": { en: "Toggle Developer Tools", ko: "개발자 도구 표시/숨기기" },
	"menu.actualSize": { en: "Actual Size", ko: "실제 크기" },
	"menu.zoomIn": { en: "Zoom In", ko: "확대" },
	"menu.zoomOut": { en: "Zoom Out", ko: "축소" },
	"menu.toggleFullScreen": { en: "Toggle Full Screen", ko: "전체 화면 표시/숨기기" },
	"menu.minimize": { en: "Minimize", ko: "최소화" },
	"menu.zoom": { en: "Zoom", ko: "확대/축소" },
	"menu.bringAllToFront": { en: "Bring All to Front", ko: "모두 앞으로 가져오기" },
	"omp.cannotRun": {
		en: "omp at {bin} could not run ({detail}). OMPdesk reinstalls it on its own; to do it yourself, run `bun install -g @oh-my-pi/pi-coding-agent`, then press Restart.",
		ko: "{bin}의 omp를 실행할 수 없어요 ({detail}). OMPdesk가 알아서 다시 설치해요. 직접 하려면 `bun install -g @oh-my-pi/pi-coding-agent`를 실행한 뒤 다시 시작을 눌러 주세요.",
	},
	"omp.notFound": {
		en: "omp is not installed. OMPdesk installs it on its own; to do it yourself, run `bun install -g @oh-my-pi/pi-coding-agent`, then press Restart.",
		ko: "omp가 설치되어 있지 않아요. OMPdesk가 알아서 설치해요. 직접 하려면 `bun install -g @oh-my-pi/pi-coding-agent`를 실행한 뒤 다시 시작을 눌러 주세요.",
	},
	"omp.overrideMissing": {
		en: "OMP_GUI_OMP points at a missing file ({path}). Fix or unset it, then press Restart.",
		ko: "OMP_GUI_OMP가 가리키는 파일이 없어요 ({path}). 값을 고치거나 지운 뒤 다시 시작을 눌러 주세요.",
	},
	"omp.tooOld": {
		en: "omp {version} is too old; this app needs {minimum} or newer. OMPdesk updates it on its own; to do it yourself, run `omp update`, then press Restart.",
		ko: "omp {version}은 너무 오래된 버전이에요. 이 앱은 {minimum} 이상이 필요해요. OMPdesk가 알아서 업데이트해요. 직접 하려면 `omp update`를 실행한 뒤 다시 시작을 눌러 주세요.",
	},
	"quit.keepWorking": { en: "Keep working", ko: "계속 사용" },
	"quit.quitAnyway": { en: "Quit anyway", ko: "그래도 종료" },
	"quit.workingBody": {
		en: "{working} of {total} sessions are still working in {windows} window(s). Quitting stops them and their agents.",
		ko: "{windows}개 창에서 세션 {total}개 중 {working}개가 아직 실행 중이에요. 종료하면 세션과 에이전트가 모두 중단돼요.",
	},
	"quit.workingBodyResume": {
		en: "{working} of {total} sessions are still working in {windows} window(s). Quitting pauses them; they pick up where they left off the next time OMPdesk opens.",
		ko: "{windows}개 창에서 세션 {total}개 중 {working}개가 아직 실행 중이에요. 종료하면 잠시 멈추고, 다음에 OMPdesk를 열 때 하던 작업을 이어서 해요.",
	},
	"quit.workingBodyRestart": {
		en: "{working} of {total} sessions are still working in {windows} window(s). They continue by themselves after the restart.",
		ko: "{windows}개 창에서 세션 {total}개 중 {working}개가 아직 실행 중이에요. 다시 시작한 뒤에 하던 작업을 이어서 해요.",
	},
	"quit.workingTitle": { en: "Sessions are still running", ko: "아직 실행 중인 세션이 있어요" },
	"restart.body": {
		en: "OMPdesk's installed files were replaced while it was running, so this window can no longer load them reliably. {working} of {total} sessions are still working.",
		ko: "OMPdesk 실행 중에 설치 파일이 교체되어 이 창에서 더 이상 안정적으로 불러올 수 없어요. 세션 {total}개 중 {working}개가 아직 실행 중이에요.",
	},
	"restart.later": { en: "Later", ko: "나중에" },
	"restart.now": { en: "Restart now", ko: "지금 재시작" },
	"restart.title": { en: "Restart to finish updating", ko: "업데이트를 마치려면 재시작하세요" },
	"resume.continuing": {
		en: "Continuing {count} interrupted task{plural}",
		ko: "중단된 작업 {count}개를 이어서 하고 있어요",
	},
	// Batched completion notifications (notification-batch.ts): "3 tasks finished · 1 needs you".
	"batch.finished.one": { en: "{count} task finished", ko: "작업 {count}개 완료" },
	"batch.finished.other": { en: "{count} tasks finished", ko: "작업 {count}개 완료" },
	"batch.failed": { en: "{count} failed", ko: "{count}개 실패" },
	"batch.needsYou.one": { en: "{count} needs you", ko: "{count}개 확인 필요" },
	"batch.needsYou.other": { en: "{count} need you", ko: "{count}개 확인 필요" },
	"batch.more": { en: "{list} +{count} more", ko: "{list} 외 {count}개" },
	// Web Push to a paired phone (web/web-push-notifier.ts). The body reads like the desktop banner's; a device that
	// hides content gets only the title, and the batch summary above.
	"push.complete": { en: "Complete", ko: "완료" },
	"push.error": { en: "Stopped with error", ko: "오류로 중단됨" },
	"push.errorDetail": { en: "Stopped with error: {error}", ko: "오류로 중단됨: {error}" },
	"push.ask": { en: "Waiting for your input", ko: "입력을 기다리고 있어요" },
	"push.hidden.completion": { en: "A task finished", ko: "작업이 끝났어요" },
	"push.hidden.error": { en: "A task stopped with an error", ko: "작업이 오류로 중단됐어요" },
	"push.hidden.ask": { en: "A task needs you", ko: "작업에 확인이 필요해요" },
	"resume.stop": { en: "Stop", ko: "중단" },
	// Status of a tab whose omp runs on a paired device that is unreachable.
	"remote.offline": {
		en: "The device running this session is offline. Reconnecting…",
		ko: "이 세션을 실행하는 기기가 오프라인이에요. 다시 연결하는 중이에요…",
	},
	// Stats bridge failures that reach the renderer (toasts, the stats page).
	"stats.notReady": {
		en: "OMPdesk keeps starting it in the background. Stats appear here as soon as it answers.",
		ko: "OMPdesk가 백그라운드에서 계속 시작하고 있어요. 응답하면 바로 여기에 통계가 표시돼요.",
	},
	"stats.notRunning": {
		en: "The stats server isn't running. Restart OMPdesk to bring it back.",
		ko: "통계 서버가 실행되고 있지 않아요. OMPdesk를 다시 시작하면 복구돼요.",
	},
	"updates.checkFailed": {
		en: "Couldn't check for updates. Check your connection and try again.",
		ko: "업데이트를 확인하지 못했어요. 연결을 확인하고 다시 시도하세요.",
	},
	"updates.downloadFailed": {
		en: "The installer download failed. Check your connection and try again.",
		ko: "설치 프로그램을 다운로드하지 못했어요. 연결을 확인하고 다시 시도하세요.",
	},
	"updates.hashMismatch": {
		en: "The downloaded installer failed SHA-512 verification and was removed. Try the update again.",
		ko: "다운로드한 설치 프로그램이 SHA-512 검증에 실패해 삭제했어요. 업데이트를 다시 시도하세요.",
	},
	"updates.installerMissing": {
		en: "This release does not include an installer for this computer.",
		ko: "이 릴리스에는 이 컴퓨터에 맞는 설치 프로그램이 없어요.",
	},
	"updates.failed": {
		en: "Couldn't finish the update. Try again later.",
		ko: "업데이트를 마치지 못했어요. 잠시 후 다시 시도하세요.",
	},
	"updates.noResult": {
		en: "Couldn't finish the update check. Try again later.",
		ko: "업데이트 확인을 마치지 못했어요. 잠시 후 다시 시도하세요.",
	},
	"updates.openInstallerFailed": {
		en: "The installer was downloaded, but macOS could not open it.",
		ko: "설치 프로그램을 다운로드했지만 macOS에서 열 수 없어요.",
	},
	"updates.releaseInvalid": {
		en: "The latest release has no valid update information, so OMPdesk can't update from it.",
		ko: "최신 릴리스에 올바른 업데이트 정보가 없어서 OMPdesk를 업데이트할 수 없어요.",
	},
	"updates.unsupportedArchitecture": {
		en: "This Mac architecture does not have a supported installer.",
		ko: "이 Mac 아키텍처를 지원하는 설치 프로그램이 없어요.",
	},
} satisfies Record<string, Record<UiLanguage, string>>;

export type MainTextKey = keyof typeof MAIN_TEXT;

# Changelog

## [0.62.1] - 2026-10-23

자동 업데이트 뒤 앱이 업데이트 전 그대로(트레이에 숨김, 최소화, 다른 앱 뒤) 돌아와요. 배포되지 못한 0.62.0의 내용도 이 버전에 들어 있어요.

### 새로 생긴 것
- 앱이 트레이에 숨어 있거나 최소화돼 있거나 다른 앱 뒤에 있을 때 자동 업데이트가 되면, 다시 켜진 앱도 그 상태 그대로예요. 예전에는 창이 원래 자리에 최대화돼 앞으로 튀어나왔어요.
- 하위 세션을 연 에이전트가 세션 목록을 보면, 쉬고 있는 하위 세션이 일을 어디서 멈췄는지(끝남, 문제로 끝남, 막힘, 아무 보고 없이 멈춤) 함께 나와요.
- 하위 세션이 판정 줄도 보고도 없이 턴을 끝내면, 보고해 달라고 한 번 요청하고 그래도 없으면 연 세션에 알려요.

### 고친 것
- 입력 없이 열었다가 다른 탭으로 떠난 빈 새 세션은 닫혀요. 사이드바에 행이 없어서 다시 찾을 수 없었어요.
- 오토파일럿의 '남은 후속 작업'이 정리되지 않고 쌓이기만 했어요. 한 번 남기고 다시 언급하지 않은 항목도 이제 나이를 세서, 오토파일럿이 하거나 닫도록 해요.

<!-- en -->

After an automatic update the app comes back as it was (hidden in the tray, minimized, behind another app). This version also carries 0.62.0, whose release did not go out.

### New
- When an automatic update happens while the app sits in the tray, minimized or behind another app, the relaunched app stays that way; it used to come back maximized in front of you.
- An agent that opened child sessions sees, for each idle one, where it left the work: finished, finished with a problem, blocked, or stopped without a report.
- A child session that ends its turn with neither a verdict line nor a report is asked once to report; if it still says nothing, the session that opened it is told.

### Fixed
- An empty new session you opened and left for another tab without typing closes, since it had no sidebar row to find it again.
- Autopilot's "Left for later" list only grew. A follow-up named once and never again now ages too, so the run either does it or closes it.

## [0.62.0] - 2026-10-23

새 세션은 무언가 입력하기 전까지 사이드바에 생기지 않고, 워크트리에서 일한 하위 세션이 끝났다고 보고하면 그 브랜치의 git 상태가 함께 와요.

### 새로 생긴 것
- 워크트리에서 일하는 하위 세션이 끝났다(또는 검토해 달라)고 보고하면, 상위 세션이 받는 보고 끝에 그 브랜치의 git 상태가 한 줄로 붙어요. 아직 main에 안 들어간 커밋, 커밋 안 된 파일, 보고했지만 바뀌지 않은 파일이 나와요. 보고와 git이 어긋나면 하위 세션에 고친 뒤 다시 보고하라고 바로 알려 줘요.

### 고친 것
- 새 세션(⌘T, 프로젝트의 +, ⌘N)을 열기만 해도 사이드바에 "새 세션" 행이 생겼어요. 이제 첫 메시지나 명령을 입력할 때 생겨요. 빈 탭이 열린 폴더는 프로젝트로 그대로 보여서 +와 ⋯를 계속 쓸 수 있어요.
- 폰에서 알림 켜기가 실패하면 이유가 영어로 나왔어요. 이제 화면 언어로 나와요.
- 폰의 보기 시트(작업 트리, 계획, 로그)에서 붙어 있는 버튼을 누르면 옆 버튼이 눌리던 것을 고쳤어요.

<!-- en -->

A new session appears in the sidebar only once you type into it, and a worktree child that reports done brings its branch's git state along.

### New
- When a child session working in a worktree reports done (or asks for review), the report its opener gets ends with one line of that branch's git state: commits not in main yet, uncommitted files, files it named that did not change. When the report and its git disagree, the child is told at once to fix that and report again.

### Fixed
- Opening a new session (⌘T, a project's +, ⌘N) put a "New session" row in the sidebar right away. The row now appears with your first message or command; the folder of an empty tab still shows as a project, with its + and ⋯.
- A failed attempt to turn on notifications on the phone gave its reason in English; it now follows your language.
- In the phone's view sheets (Work tree, Plan, Logs) a tap on a button next to another could press the neighbour; each button keeps its own taps now.

## [0.61.32] - 2026-10-23

폰에서 열 수 없는 링크가 이유를 화면 언어로 말하고, 시트와 대화 상자의 제목을 화면 읽기 프로그램이 제목으로 찾아요.

### 고친 것
- 폰 페이지에서 열 수 없는 링크를 누르면 알림이 'Only web and mail links open from here' 같은 영어로 나왔어요. 이제 '여기서는 웹과 메일 링크만 열 수 있어요'처럼 화면 언어로 나와요.
- 시트(작업 트리, 백그라운드 작업 등)와 대화 상자의 제목이 이제 제목 요소예요. 화면 읽기 프로그램의 제목 탐색에 잡히고, 안의 소제목도 단계를 건너뛰지 않아요.

<!-- en -->

A link the phone cannot open says why in your language, and sheet and dialog titles are headings for screen readers.

### Fixed
- Tapping a link the phone page cannot open showed an English notice ("Only web and mail links open from here"); it now follows your language.
- Sheet titles (Work tree, Background tasks and the rest) and dialog titles are headings now, so a screen reader's heading navigation finds them and the section headings inside follow in order.

## [0.61.31] - 2026-10-23

폰 페이지의 연결 오류 알림도 화면 언어로 나와요. 배포되지 못한 0.61.30의 내용(LSP 진단 개수, 설정 › 메모리의 상태 문장)도 이 버전에 들어 있어요.

### 고친 것
- 폰 페이지에서 컴퓨터와의 연결이 끊기거나 닫혀 동작이 실패하면, 알림이 한국어 화면에도 'The link to the computer dropped' 같은 영어로 나왔어요. 이제 '컴퓨터와의 연결이 끊겼어요'처럼 화면 언어로 나와요.

<!-- en -->

Connection errors on the phone page follow your language too. This version also carries 0.61.30, whose release did not go out (the LSP diagnostics count and Settings › Memory's state sentences).

### Fixed
- When an action on the phone page failed because the link to the computer dropped or closed, its notice was in English on a Korean screen ("The link to the computer dropped"); it now follows your language.

## [0.61.30] - 2026-10-23

한국어 화면에 영어로 남아 있던 문장 몇 개를 고쳤어요.

### 고친 것
- LSP 진단 도구 카드의 머리가 '2 diagnostics' 대신 '진단 2개'처럼 화면 언어로 개수를 말해요.
- 설정 › 메모리가 상태를 화면 언어로 설명해요. 이 컴퓨터용 빌드가 없을 때, 잇단 충돌 뒤의 안전 모드나 개발 빌드라 이번 실행에서 메모리를 설정하지 않을 때(전에는 이것도 '빌드가 없다'고 했어요), 메모리 서버가 응답하지 않을 때(OMPdesk가 계속 다시 시도해요) 각각 다른 문장이 나와요.

<!-- en -->

A few sentences that stayed in English on a Korean screen now follow your language.

### Fixed
- The LSP diagnostics card's header counts in your language ("진단 2개" instead of "2 diagnostics").
- Settings › Memory explains its state in your language: no build for this computer; memory not set up in this launch because of safe mode after repeated crashes or a development build (it used to call that a missing build too); and a memory server that is not answering, which OMPdesk keeps retrying.

## [0.61.29] - 2026-10-23

여러 질문 카드에서 답한 단계를 스크린 리더도 알려 줘요. 배포되지 못한 0.61.28의 내용(오토파일럿 로켓 아이콘, 시스템 언어로 답하기)도 이 버전에 들어 있어요.

### 고친 것
- 질문이 여러 개인 카드의 단계 칩에서, 답한 단계는 ✓ 그림으로만 보여 스크린 리더는 어느 질문에 답했는지 알 수 없었어요. 이제 칩 이름에 '답함'이 함께 읽혀요.

<!-- en -->

Screen readers now say which steps of a multi-question card you answered. This version also carries 0.61.28, whose release did not go out (Autopilot's rocket icon, answers in your language).

### Fixed
- A multi-question card's step chips showed an answered step only as a check mark, so a screen reader could not tell which questions were answered; the chip's name now says "answered".

## [0.61.28] - 2026-10-23

오토파일럿은 글자 대신 로켓 아이콘으로 보이고, 시스템 언어로 답해요.

### 고친 것
- 사이드바 줄, 작업 보드 머리와 프로젝트 줄, 대화 아래 상태 줄, 폰의 작업 줄에서 '오토파일럿' 글자 대신 로켓 아이콘이 보여요. 스크린 리더는 그대로 '오토파일럿'이라고 읽어요.
- 이전 버전이 세션 이름 앞에 써 넣은 '오토파일럿 · '이 더는 보이지 않아요. 이름 없는 실행 탭도 프로젝트 이름만 보여요.
- 오토파일럿이 시스템 언어 대신 영어로 답하던 문제를 고쳤어요. 앱이 대신 쓰는 영어 안내(사이클 시작, 목표 이어하기, 알림)를 사람이 언어를 바꾼 것으로 읽지 않아요. 직접 다른 언어로 쓸 때만 그 언어를 따라요.

<!-- en -->

Autopilot shows as a rocket instead of a word, and answers in your language.

### Fixed
- The sidebar row, the work board's heading and project line, the status row under the conversation and the phone's work strip show a rocket instead of the word Autopilot; screen readers still say it.
- The "Autopilot · " an earlier version wrote in front of a session's name no longer shows, and an unnamed run's tab shows its project alone.
- Autopilot answered in English instead of your language: the English prompts the app writes for it (a cycle's start, a goal's continuation, reminders) no longer read as you switching language. Only what you type yourself in another language changes it.

## [0.61.27] - 2026-10-23

오토파일럿 세션 이름이 지금 하는 일을 말하고, 검색 칸에서 키보드로 바로 결과에 가요.

### 새 기능
- 오토파일럿 실행의 세션 이름이 '오토파일럿 · 폴더' 대신 지금 사이클이 하는 일로 바뀌어요. 사이클마다 새로 붙고, 직접 바꾼 이름은 그대로 둬요. 오토파일럿이라는 표시는 타이틀바와 분할 창 머리의 로켓 아이콘이 해요.
- 사이드바의 '세션 찾기'에서 ↓를 누르면 목록으로, Enter를 누르면 걸러진 첫 세션으로 가요. 페어한 컴퓨터의 세션도 포함해요.
- 설정 검색에서 Enter를 누르면 첫 결과가 열리고, ↓를 누르면 결과 목록으로 가요.

### 고친 것
- 앱이 다시 시작된 뒤 이어진 오토파일럿 실행도 사이클마다 세션 이름을 바꿔요.
- Changes 패널의 브랜치 고르기에서 이름 일부를 치고 Enter를 누르면 그 글자로 새 브랜치를 만들던 문제를 고쳤어요. 이제 일치하는 브랜치로 가고, 화살표로 브랜치 사이를 오가요. 새로 만들기는 일치하는 브랜치가 없을 때만 해요.
- 작업 카드의 테스트 칩을 스크린 리더가 '테스트 128개 통과'로 읽어요. 전에는 통과했다는 사실이 ✓ 그림에만 있었어요.

<!-- en -->

An Autopilot session is named after what it is doing now, and search fields take you to their results by keyboard.

### New
- An Autopilot run's session is named after the work of the cycle at hand, renamed each cycle, instead of "Autopilot · folder"; a name you typed stays. The rocket in the title bar and the split pane's header says it is a run.
- In the sidebar's Find sessions, ↓ goes to the list and Enter to the first session it shows, a paired computer's sessions included.
- In the settings search, Enter opens the first result and ↓ goes to the results.

### Fixed
- An Autopilot run that resumed after the app restarted goes on naming its session after each cycle.
- In the Changes panel's branch picker, typing part of a name and pressing Enter created a branch with that name; it now goes to the matching branch, the arrows walk the branches, and Enter creates only when nothing matches.
- A screen reader reads the work card's tests chip as "128 tests passed"; the pass was only in its check mark.

## [0.61.26] - 2026-10-23

스크린 리더가 하나만 고르는 버튼을 바르게 읽고, 영어 화면의 개수 문구를 마저 다듬었어요.

### 고친 것
- 피드백 창의 유형(버그·기능 요청·질문)을 스크린 리더가 '눌린 토글 세 개'로 읽던 문제를 고쳤어요. 이제 하나를 고르는 라디오 묶음이고, 화살표로 골라요.
- 휴대폰과 세로 태블릿에서 분할 보기를 한 칸씩 볼 때, 창 전환 줄의 지금 창을 '눌린 토글'이 아니라 현재 항목으로 읽어요.
- 화면 언어가 영어일 때 하나인데 복수로 나오던 문구를 마저 고쳤어요. 설정 검색 결과, eval 셀, 이슈 댓글, SSH 호스트, 확장 스킬, 가져오기 메시지, 'N of M' 목록, 인사이트의 메시지 카드가 해당돼요.
- 영어 화면에서 'file(s)', 'task(s)' 같은 표기를 없앴어요. 이제 수에 맞게 '1 file', '2 files'로 나와요.
- 영어 화면의 종료·재시작 확인창이 '1 of 1 sessions are still working in 1 window(s)' 대신 'Still working: 1 of 1 session, in 1 window.'로 나와요.

<!-- en -->

Screen readers read pick-one buttons right, and the remaining English counts are fixed.

### Fixed
- A screen reader read the feedback dialog's type (Bug, Feature request, Question) as three pressed toggle buttons; it is now one radio group, picked with the arrow keys.
- On a phone or portrait tablet showing a split one pane at a time, the switcher reads the pane on screen as its current item, not a pressed toggle.
- More English counts of one read in the singular: settings search results, eval cells, issue comments, SSH hosts, extension skills, import messages, "N of M" lists and the Insights message card.
- English text no longer writes "file(s)" or "task(s)": it says "1 file" or "2 files".
- The quit and restart confirmations read "Still working: 1 of 1 session, in 1 window." instead of "1 of 1 sessions are still working in 1 window(s)."

## [0.61.25] - 2026-10-23

영어 화면에서 하나일 때 단수로 읽어요.

### 고친 것
- 화면 언어가 영어일 때 개수가 하나인데 복수로 나오던 문구를 고쳤어요. 이제 "1 session", "1 file", 파일 내용 검색의 "1 match in 1 file", 사이드바 하위 에이전트의 "1 tool call", 플러그인 다시 불러오기의 "1 plugin", 통계 동기화의 "1 message from 1 file"로 나와요.

<!-- en -->

English counts read right when there is one.

### Fixed
- With the English interface, a count of one showed a plural: it now reads "1 session", "1 file", "1 match in 1 file" in content search, "1 tool call" on a sidebar subagent, "1 plugin" when plugins reload and "1 message from 1 file" when stats sync.

## [0.61.24] - 2026-10-23

명령 팔레트에서 프로젝트를 옮기고, 스크린 리더가 목록을 바르게 읽어요.

### 새 기능
- 명령 팔레트에 **프로젝트 전환**이 생겼어요. 타이틀바를 누르지 않아도 최근 프로젝트를 찾아 이 탭을 옮길 수 있어요.

### 고친 것
- 설정 › 메모리의 페이지·인계·세션, Changes 패널의 파일, 디버그 콘솔의 세션, /copy 대상 목록에서 열린 줄을 스크린 리더가 '눌린 토글 버튼'으로 읽던 문제를 고쳤어요. 이제 목록의 현재 항목으로 읽어요.
- /copy 대상 목록에서 ↑/↓로 옮기면 포커스도 따라가, 스크린 리더가 옮겨 간 줄을 읽어요.

<!-- en -->

Switch projects from the command palette, and screen readers read lists right.

### New
- The command palette has **Switch project**: find a recent project and move this tab to it without the title bar.

### Fixed
- In Settings › Memory (pages, handoffs, sessions), the Changes panel's files, the debug console's sessions and the /copy targets, a screen reader read the open row as a pressed toggle button; it now reads it as the list's current item.
- In the /copy targets, ↑/↓ move the focus with the choice, so a screen reader reads the row it moved to.

## [0.61.23] - 2026-10-23

프로젝트를 고르는 창에서 바로 찾을 수 있어요.

### 새 기능
- 타이틀바의 프로젝트 이름이나 빈 사이드바에서 여는 프로젝트 창에 검색이 생겼어요. 열면 바로 입력되고, 이름·경로로 거르며 ↑/↓와 Enter로 고르면 돼요. 한글 이름 폴더도 찾아요.

### 고친 것
- 설정의 계정·기기·플러그인 같은 목록에서 줄 아래 설명(경로, 계정)을 스크린 리더가 읽지 않아, 이름이 같은 두 줄을 구별할 수 없던 문제를 고쳤어요.

<!-- en -->

Find a project right in the project picker.

### New
- The project picker you open from the title bar's project name or an empty sidebar has a search: typing goes straight into it, it narrows by name and path, and ↑/↓ and Enter pick. Folders with Hangul names are found too.

### Fixed
- In lists such as Settings' accounts, devices and plugins, a screen reader now reads each row's second line (a path, an account), so two rows with the same title can be told apart.

## [0.61.22] - 2026-10-23

키보드 사용과 작은 화면 손질을 고쳤어요.

### 고친 것
- 터미널에서 F6으로 빠져나올 때 셸에 `ESC[17~`가 함께 입력되던 문제를 고쳤어요.
- 휴대폰에서 탭의 포커스 테두리가 가로 스크롤 영역에 잘리지 않고 탭 안쪽에 그려져요.
- Run 설정에서 짝 없이 혼자 남은 스위치(빠른 모드만 있을 때 등)가 한 줄을 다 차지해, 스위치가 다른 줄처럼 오른쪽 끝에 놓여요.

### 개선
- 도구 강제 창에서 검색란에 둔 채 ↑/↓로 도구를 고를 수 있어요. 목록 줄마다 Tab을 누를 필요가 없어요.

<!-- en -->

Keyboard use and small-screen polish.

### Fixed
- Leaving the terminal with F6 no longer also types `ESC[17~` into its shell.
- On a phone a tab's focus ring is drawn inside the tab, where the sideways tab scroller used to clip it.
- In Run settings a switch left alone on its row (for example Fast mode alone) takes the whole row, so its switch sits at the right edge like the others.

### Improved
- In the force-tool dialog ↑/↓ pick a tool from the search field; the list rows are no longer one Tab stop each.

## [0.61.21] - 2026-10-23

키보드만으로 창 안을 더 쉽게 오갈 수 있어요.

### 새 기능
- F6과 Shift+F6으로 사이드바, 대화, 입력창, 작업 보드, 오른쪽 패널 사이를 옮겨 다녀요. 터미널 안에서도 빠져나와요. 설정 › 키보드에 적혀 있어요.

### 고친 것
- 사이드바의 세션·프로젝트 줄, 접기 버튼, 사용량 토글, 프로바이더 카드 등 10곳에서 Tab으로 이동해도 포커스 테두리가 보이지 않던 문제를 고쳤어요.

### 개선
- 휴대폰 웹 화면이 처음 열릴 때 내려받는 코드를 21KB 줄였어요. 테마 선택 창은 처음 열 때 불러와요.

<!-- en -->

Getting around the window from the keyboard is easier.

### New
- F6 and Shift+F6 move between the sidebar, the conversation, the composer, the work board and the side panel, out of the terminal too. Settings › Keyboard lists it.

### Fixed
- Ten controls showed no focus ring when reached with Tab, among them the sidebar's session and project rows, its fold buttons, the usage toggle and the provider cards.

### Improved
- The phone's web page downloads 21 KB less code when it first opens; the theme picker loads the first time it opens.

## [0.61.20] - 2026-10-23

어두운 테마와 휴대폰에서 읽기 어려웠던 글자와 화면 읽기 프로그램의 제목 순서를 다듬었어요.

### 고친 것
- 사용량 게이지가 한도에 가까워질 때(주황·빨강 채움) 창 이름과 퍼센트가 어두운 테마에서도 읽기 쉬운 대비를 가져요.
- 작업 보드에서 답을 기다리는 줄 위의 옅은 글자, 활성 Run 칩의 이름, 작업 카드의 '따라가기'가 모든 테마에서 읽기 쉬워요.
- 화면 읽기 프로그램에서 세션 이름이 창의 첫 제목이 되고, 휴대폰에서 펼친 작업 보드와 메모리 › 프로필의 제목이 단계를 건너뛰지 않아요.
- 설정 › 기기·연결에서 공유가 켜져 있을 때 허용된 계정과 차단한 기기 목록이 한 번만 보여요.

<!-- en -->

Text that was hard to read in the dark theme and on phones, and the heading order screen readers follow, are tidied up.

### Fixed
- A usage gauge nearing its limit (amber or red fill) keeps its window name and percent readable in the dark themes too.
- On the work board, the quiet text on a row waiting for an answer, the active Run chip's label and the work card's Follow read at full contrast in every theme.
- For screen readers the session's name is the window's top heading, and the work board opened on a phone and Memory › Profile no longer skip a heading level.
- Settings › Devices & connections lists the allowed accounts and blocked devices once while sharing is on.

## [0.61.19] - 2026-10-23

⌃Tab으로 탭을 바꾼 뒤 입력한 글자가 컴포저에 들어가지 않던 문제를 고쳤어요.

### 고친 것
- ⌃Tab이나 탭 전환 창으로 다른 탭으로 옮긴 뒤 바로 입력하면 글자가 대화 기록으로 가서 사라지던 문제를 고쳤어요(0.61.16부터). 입력은 새 탭의 컴포저로 들어가요.
- 질문을 기다리는 세션 배지, 파란 배지, 대기열·진행 칩처럼 옅은 색 바탕 위의 작은 상태 글자가 모든 테마에서 읽기 쉬운 대비를 가져요.
- 터미널 탭에서 Delete를 누르면 그 터미널이 닫히고, 그 자리의 터미널(없으면 '새 터미널' 버튼)로 포커스가 옮겨가요. 화면 읽기 프로그램에는 선택된 터미널의 닫기 버튼이 따로 있어요.
- 화면 읽기 프로그램이 시트 손잡이를 이름 없는 장식으로 읽고, 공유 미리보기와 긴 대화상자 본문을 키보드로 스크롤할 수 있어요.

<!-- en -->

Text typed right after switching tabs with ⌃Tab reaches the composer again.

### Fixed
- After moving to another tab with ⌃Tab or the tab switcher, the next keys went to the conversation and were lost (since 0.61.16). They go to the new tab's composer.
- Small status text on a pale wash (a waiting session's badge, blue badges, the queue and progress chips) reads at full contrast in every theme.
- Delete on a terminal tab closes that terminal and moves focus to the one that took its place, or to New terminal when none is left. Screen readers get a close button for the selected terminal.
- Screen readers treat a sheet's handle as decoration, and the share preview and a long dialog's body scroll from the keyboard.

## [0.61.18] - 2026-10-23

지난 두 버전에서 알림이 화면에 남아 버튼을 가리던 문제를 고쳤어요.

### 고친 것
- 템플릿 갤러리처럼 이미 닫힌 창에서 연 편집기를 닫으면 알림(토스트)의 닫기 버튼으로 포커스가 가서, 알림이 사라지지 않고 아래 버튼을 가리던 문제를 고쳤어요(0.61.16부터).
- 사이드바에서 선택된 세션 줄의 시간·표시와 기다리는 세션의 제목, 연결된 컴퓨터의 "오프라인" 표시가 모든 테마에서 읽기 쉬운 대비를 가져요.
- 첫 실행 화면의 제목 단계가 건너뛰지 않아, 화면 읽기 프로그램의 제목 이동이 이어져요.

<!-- en -->

A toast no longer stays on screen covering buttons, as it could in the last two versions.

### Fixed
- Closing an editor opened from a dialog that had already closed (the template gallery) moved the focus to a toast's close button, and the toast then stayed on screen over the buttons beneath it (since 0.61.16).
- On the sidebar's selected session row the age and marks, a waiting session's title and a paired computer's "Offline" tag read at full contrast in every theme.
- The first-run screen's headings no longer skip a level, so a screen reader's heading navigation runs through them.

## [0.61.17] - 2026-10-23

키보드와 화면 읽기 프로그램으로 대화 기록과 사이드바를 다룰 때 걸리던 곳을 더 고쳤어요.

### 고친 것
- 대화 기록의 "이전 메시지 N개 보기"를 누르면 포커스가 페이지 처음으로 빠지지 않고 대화 기록에 남아, 화살표로 바로 읽을 수 있어요.
- ⋯ 메뉴나 우클릭 메뉴에서 그 줄을 없애는 항목(사이드바에서 제거 등)을 고르면 포커스가 그 자리의 다음 줄(없으면 앞 줄)로 가요. 숨겨진 줄은 건너뛰어요.
- 길어서 넘치는 코드 블록에 Tab으로 닿아 키보드로 가로·세로 스크롤할 수 있어요. 넘치지 않는 블록은 그대로예요.
- 사이드바에서 연결된 컴퓨터의 채팅 구역을 화면 읽기 프로그램이 "{기기}의 채팅"으로 읽어요.

<!-- en -->

More keyboard and screen reader fixes in the transcript and the sidebar.

### Fixed
- "Show N earlier messages" in the transcript no longer drops the keyboard focus at the top of the page: it stays in the transcript, where the arrow keys read on.
- Choosing a menu item that removes its own row (Remove from sidebar and the like) moves the focus to the next row, or the one before it, skipping hidden rows.
- A code block that runs past its box can be reached with Tab and scrolled by keyboard, across and down; a block that fits is unchanged.
- In the sidebar, a paired computer's Chats section reads as "Chats on {device}" to screen readers.

## [0.61.16] - 2026-10-23

키보드로 목록을 다루다 포커스를 잃던 곳을 더 고쳤어요.

### 고친 것
- 확인 대화상자로 세션, 폴더, 프로바이더 같은 줄을 지우면 포커스가 페이지 처음으로 빠지지 않고 그 자리의 다음 줄(마지막 줄이었다면 앞 줄)로 가요.
- 긴 diff의 "줄 N개 더 보기", 파일 보기의 "줄 모두 보기", 컨텍스트 검사기의 "모두 보기"를 누르면 새로 드러난 첫 줄로 포커스가 가요.
- MCP 서버 카드의 ⋯ 메뉴 버튼을 화면 읽기 프로그램이 "{서버} 서버 메뉴"처럼 서버 이름과 함께 읽어요.

<!-- en -->

More places where the keyboard focus got lost in a list now keep it.

### Fixed
- Deleting a row (a session, a folder, a provider) through a confirmation dialog no longer drops the focus at the top of the page: it moves to the row that took its place, or the one before it when it was the last.
- A long diff's "Show N more lines", the file viewer's "Show all lines" and the context inspector's "Show all" move the focus to the first row they reveal.
- Each MCP server card's ⋯ menu button reads with its server's name to screen readers ("Actions for {server}").

## [0.61.15] - 2026-10-23

목록마다 같은 이름이던 아이콘 버튼을 화면 읽기 프로그램이 줄마다 구별해 읽어요.

### 고친 것
- 줄마다 반복되는 아이콘 버튼의 이름에 무엇에 대한 버튼인지 들어가요. 사용자 지정 프로바이더의 모델 상세·제거, 작업 폴더 제거, 단축키 변경·재설정, 프로바이더 편집·삭제, 헤더 제거, 터미널 닫기, SSH 포워딩 시작·멈추기·지우기, 일정 실행·중단, 키-값 행 제거, GitHub 알림 열기·읽음 표시, 탭 개요의 위·아래 이동이에요.
- 사용자 지정 프로바이더의 모델 상세 버튼이 열렸는지 닫혔는지 알려요.

<!-- en -->

Icon buttons repeated on every row of a list now read differently for each row to screen readers.

### Fixed
- Icon buttons repeated on every row now say what they act on: a custom provider's model details and remove, removing a workspace folder, changing and resetting a shortcut, editing and deleting a provider, removing a header, closing a terminal, starting, stopping and removing an SSH forward, running and stopping a schedule, removing a key-value row, opening a GitHub notification and marking it read, and moving a tab in the tab overview.
- A custom provider's model details button says whether the details are open.

## [0.61.14] - 2026-10-23

키보드와 화면 읽기 프로그램으로 작업 기록을 볼 때 걸리던 곳을 고쳤어요.

### 고친 것
- 파일 쓰기 카드의 내용 펼침 버튼을 화면 읽기 프로그램이 "파일 내용"이라고 읽어요. 펼칠 때 화살표가 돌아가고 키보드 포커스 테두리가 보여요.
- 작업판의 "+N개 더", 어드바이저 카드의 "메모 N개 더", 진단 목록의 "진단 N개 더"를 누르면 포커스가 페이지 처음으로 빠지지 않고 새로 드러난 첫 줄로 가요.

<!-- en -->

Smoother keyboard and screen reader use in the work record.

### Fixed
- The write card's content toggle reads as "File content" to screen readers, its chevron turns as it opens and it shows the keyboard focus ring.
- The work board's "+N more", the advisor card's "N more notes" and the diagnostics list's "N more" no longer drop the keyboard focus at the top of the page: it moves to the first row they reveal.

## [0.61.13] - 2026-10-23

검색 창의 키보드 이동과 화면 읽기 프로그램이 읽는 내용을 다듬었어요.

### 고친 것
- 빠른 열기(⌘P)에서 결과가 없을 때 ↓를 누르면 결과가 다시 나와도 Enter가 아무것도 열지 않던 것을 고쳤어요. 검색어를 바꾸면 강조가 맨 위 결과로 돌아가요.
- 테마 고르기에서 테마마다 Tab이 멈추지 않고, ↑/↓로 옮기는 강조를 화면 읽기 프로그램이 읽어요. 지금 쓰는 테마는 "현재"라고 읽어요.
- 펼치고 접는 버튼(긴 출력 더 보기, 작업 결과 모두 보기, 디버그 변수, PR 본문, 일정 실행 기록, 메모리 세션)이 열렸는지 닫혔는지 화면 읽기 프로그램에 알려요.
- 설정의 프로바이더별 동시 요청 한도 칸과 할 일 고치기 칸에 이름이 생겼어요.

<!-- en -->

Smoother keyboard movement in search pickers, and more for screen readers to read.

### Fixed
- In Quick Open (⌘P), ↓ with no results no longer leaves Enter opening nothing once results come back, and a changed query starts at the top match.
- The theme picker's themes are no longer one tab stop each, and screen readers read the highlight the arrows move; the theme in use reads as "Current".
- The show-more toggles (long output, all work results, debug variables, PR body, schedule runs, memory sessions) tell screen readers whether they are open.
- The per-provider request limit fields in Settings and the todo edit field have names.

## [0.61.12] - 2026-10-23

키보드로 질문 카드와 목록을 다룰 때 걸리던 곳을 고쳤어요.

### 고친 것
- 질문이 여러 개인 카드에서 위쪽 단계 칩에 Tab으로 닿고, ←/→와 Home/End로 질문을 오가요. 화살표로 옮긴 뒤에도 포커스가 칩에 남아요.
- 컴포저 자동완성, 입력 기록 검색, 기술 선택 목록에서 마우스를 한 행에 둔 채 키보드로 강조를 옮기면 두 행이 칠해지던 것을 하나만 칠해요.
- 탭 개요 검색에서 결과가 없을 때 ↓를 누르면 결과가 다시 나와도 Enter가 아무것도 고르지 않던 것을 고쳤어요. 검색어를 바꾸면 강조가 맨 위 결과로 돌아가요.

<!-- en -->

Fixes for moving through question cards and lists with the keyboard.

### Fixed
- In a card with several questions, the step chips at the top are reachable with Tab, and ←/→ and Home/End move between questions; focus stays on the chip after an arrow.
- The composer's completions, the history search and the skill picker draw one highlight: moving it with the keyboard while the pointer rests on another row no longer paints two rows.
- In the tab overview's search, ↓ with no results no longer leaves Enter picking nothing once results come back, and a changed query starts at the top match.

## [0.61.11] - 2026-10-23

연결한 컴퓨터끼리 주고받는 데이터가 약 3분의 1로 줄고, 키보드로 고르는 목록과 탭이 제대로 움직여요.

### 빨라진 것
- 호스트가 연결한 기기에 보내는 큰 메시지를 압축해서 보내요. 대화와 Autopilot 상태 같은 데이터가 약 3배 작아져요. 양쪽 모두 이 버전이어야 하고, 예전 버전 기기는 지금처럼 받아요.

### 고친 것
- MCP 서버 추가 화면의 전송 방식과 범위 카드를 화살표 키로 고를 수 있어요. 카드마다 Tab이 멈추지 않고, 화면 읽기 프로그램이 각 묶음의 이름을 읽어요.
- 터미널 패널의 세션 탭이 Tab 한 번에 들어가고, 화살표와 Home/End로 세션을 바꿔요. 화살표로 바꾼 뒤에도 포커스가 탭에 남아 다음 화살표가 셸로 가지 않아요.
- 입력 기록 검색(Ctrl+R)과 컴포저의 `/`·`@`·`:` 자동완성에서 Tab을 누르면 결과를 하나씩 지나가지 않고 바로 목록을 벗어나요.

<!-- en -->

Data between paired computers shrinks to about a third, and keyboard lists and tabs move as they should.

### Faster
- A host compresses the large messages it sends a paired device: transcripts, Autopilot status and the like get about 3x smaller. Both computers need this version; an older device receives as before.

### Fixed
- The transport and scope cards of the MCP add-server screen are picked with the arrow keys, are one tab stop each, and screen readers name each group.
- The terminal panel's session tabs are one tab stop, and the arrow keys and Home/End switch the session. Focus stays on the tab after a switch, so the next arrow does not go to the shell.
- In the history search (Ctrl+R) and the composer's `/`, `@` and `:` completions, Tab leaves the list at once instead of walking every result.

## [0.61.9] - 2026-10-23

연결한 컴퓨터에 다시 붙을 때 받는 양이 줄고, 접기 화살표가 부드럽게 돌아요.

### 빨라진 것
- 연결이 끊겼다 돌아온 기기가 탭의 Autopilot 상태, 설정, 대화 내용을 처음부터 다시 받지 않고 바뀐 부분만 받아요(재연결 한 번에 약 1MB가 줄어요).

### 고친 것
- 작업판에서 사라졌다 돌아오고 다시 사라진 행이 첫 퇴장의 남은 시간만큼만 흐려지고 끊겼어요. 이제 매번 끝까지 흐려져요.
- 대화의 작업 카드, 도구 카드, 생각, 읽기 묶음, 할 일 줄의 접기 화살표가 돌지 않고 바로 뒤집혔어요. 이제 펼칠 때 돌아요.

<!-- en -->

A device that reconnects downloads less, and disclosure arrows turn smoothly.

### Faster
- A device whose link comes back no longer downloads its tab's Autopilot status, settings and transcript whole: it gets only what changed (about 1 MB less per reconnect).

### Fixed
- A work board row that left, came back and left again faded only for what was left of its first exit. It now fades out fully every time.
- The disclosure arrows of work cards, tool cards, thinking, read groups and todo lines flipped instead of turning. They now turn as the row opens.

## [0.61.8] - 2026-10-23

Autopilot을 일시정지하면 확실히 멈춰요.

### 고친 것
- Autopilot 사이클이 끝나고 결과를 올리는 중에 누른 일시정지가 그 올리기 기록에 덮여, 실행이 다시 '실행 중'이 되고 다음 사이클이 시작됐어요. 이제 일시정지가 그대로 남아요.
- 첫 실행과 설정의 프로바이더 고르기에서 '주요 프로바이더' 제목이 검색칸에 붙어 있었어요. '다른 프로바이더'와 같은 간격을 둬요.
- 설정 › 모델 역할의 상태 줄이 사용량 막대를 문단 안에 담고 있던 잘못된 마크업을 고쳤어요.

<!-- en -->

Pausing Autopilot now always pauses it.

### Fixed
- A Pause given while an Autopilot cycle's result was being pushed was overwritten by that push's record: the run went back to running and started the next cycle. The pause now stays.
- In the provider picker of first run and Settings, the Popular providers heading sat against the search field. It has the same space as Other providers.
- A model role's status line in Settings › Model roles held its usage bar inside a paragraph, which is invalid markup.

## [0.61.7] - 2026-10-23

연결한 컴퓨터의 탭에서 도구가 출력을 쏟아낼 때 주고받는 양이 크게 줄었어요.

### 빨라진 것
- 셸 같은 도구가 돌며 출력을 낼 때마다 지금까지의 출력 전체를 다시 보냈어요(하루 64MB, 한 분에 31MB까지). 이제 앞 갱신에 이어지는 부분만 보내요. 두 컴퓨터가 모두 이 버전이어야 해요.

### 고친 것
- 작업판에서 사라지는 중인 실행 중 작업이나 서브에이전트가 바로 다시 나타나면 잠깐 두 줄로 보였어요.

<!-- en -->

Much less crosses the link while a tool streams output on a paired computer's tab.

### Faster
- A running tool such as the shell sent its whole output so far with every update (64 MB in a day, up to 31 MB in one minute). It now sends what follows the last update. Both computers need this version.

### Fixed
- On the work board a running job or subagent that came back while it faded out showed on two rows for a moment.

## [0.61.6] - 2026-10-22

키보드로 고르는 목록과 폰의 버튼 탭을 다듬었어요.

### 고친 것
- 명령 팔레트·세션·브랜치·모델·스킬 피커에서 검색칸이 결과 목록을 이끄는 칸이 됐어요. 화면 읽기 프로그램이 목록과 지금 고른 항목을 읽고, Tab 한 번이면 목록을 벗어나요.
- 설정의 모델·프로바이더 선택에서 검색칸의 Enter가 첫 번째 일치 항목을 골라요(없으면 입력한 값). '직접 입력값 사용'과 '지우기' 행에도 화살표로 닿아요.
- 320px 폰에서 두 줄로 넘어간 대화상자 아래쪽 버튼(모델 설정의 취소와 적용 등)과 설정 › 권한의 스캔 범위와 스캔 버튼이 서로의 탭을 가로채지 않아요.

<!-- en -->

Keyboard pickers and phone button taps, refined.

### Fixed
- In the command palette and the session, branch, model and skill pickers the search field now drives the result list: a screen reader reads the list and the highlighted row, and one Tab leaves the list.
- In Settings' model and provider dropdowns Enter in the search picks the first match (or the typed value when nothing matches), and the arrows reach the "Use …" and "Clear" rows.
- On a 320 px phone a dialog's buttons that wrap to a second line (model setup's Cancel and Apply, for one) and Settings › Permissions' scan scope and Scan no longer take each other's taps.

## [0.61.5] - 2026-10-22

연결한 컴퓨터의 탭에서 서브에이전트가 일할 때 주고받는 양이 줄었고, 태블릿 사이드바에서 오프라인 컴퓨터 이름이 잘리지 않아요.

### 빨라진 것
- 서브에이전트가 도는 동안 3초마다 받던 서브에이전트 목록을 이제 바뀐 부분만 받아요. 진행 상황만 바뀐 에이전트는 바뀐 값만 와요. 두 컴퓨터가 모두 이 버전이어야 해요.
- 서브에이전트의 제목을 되찾을 때 대화 전체(한 번에 수 MB) 대신 첫 지시문만 읽어요.

### 고친 것
- 태블릿 사이드바에서 오프라인 컴퓨터의 이름이 '오프라인' 표시와 쓸 수 없는 프로젝트 버튼에 밀려 몇 글자만 보였어요. 오프라인일 때는 그 버튼을 빼요.

<!-- en -->

Less moves over the link while subagents work on a paired computer's tab, and an offline computer's name is no longer cut in a tablet's sidebar.

### Faster
- The subagent list, read every 3 seconds while subagents run, now crosses as what changed; an agent whose progress moved sends only the values that changed. Both computers need this version.
- Recovering a subagent's title reads only its first instruction instead of the whole conversation (several MB at a time).

### Fixed
- In a tablet's sidebar an offline computer's name showed only a few letters beside its offline badge and a project button that could do nothing. That button is gone while the computer is offline.

## [0.61.4] - 2026-10-22

연결한 컴퓨터의 탭에서 설정을 열 때 주고받는 양이 크게 줄었어요. GitHub 카드의 열기 버튼과 작업판의 불필요한 다시 읽기도 고쳤어요.

### 빨라진 것
- 연결한 컴퓨터의 탭에서 설정을 열 때마다 모델 목록, 설정 항목, 모델 역할을 통째로 다시 받았어요(한 번에 수백 KB). 이제 두 번째부터는 바뀐 부분만 받아요. 두 컴퓨터가 모두 이 버전이어야 해요.

### 고친 것
- GitHub 도구 카드의 '브라우저에서 열기' 버튼에 이름이 없어 화면 읽기 프로그램이 읽지 못했고, 키보드로 갔을 때 설명도 뜨지 않았어요.
- 이미 열려 있던 세션에서 작업판이 지난 호출을 새 호출로 세어, 파일을 읽기만 했는데도 아직 main에 없는 작업을 다시 읽었어요.

<!-- en -->

Opening Settings on a paired computer's tab moves far less over the link. The GitHub card's open button and a needless re-read on the work board are fixed.

### Faster
- Each time Settings opened on a paired computer's tab, the model list, the settings schema and the model roles crossed the link whole (hundreds of KB). From the second time on, only what changed crosses. Both computers need this version.

### Fixed
- The GitHub tool card's Open in browser button had no name, so screen readers could not read it, and it showed no tooltip on keyboard focus.
- On a session already open, the work board counted earlier calls as new ones and read the branch's unlanded work again after a call that only read files.

## [0.61.3] - 2026-10-22

체크박스가 앱 어디서나 같은 모양과 크기로 그려지고, 고르는 창의 키보드 이동이 바로잡혔어요. 작업판이 연결한 컴퓨터를 덜 자주 묻습니다.

### 고친 것
- 설정, 대화상자, 변경 사항 목록의 체크박스와 라디오 버튼이 곳마다 크기가 달랐어요. 이제 모두 같은 크기와 강조색으로 그려져요.
- 명령 팔레트, 세션·브랜치·파일 고르기 창에서 Tab을 누르면 결과 줄을 하나씩 거쳤어요. 이제 검색칸에서 Tab을 누르면 목록을 건너뛰어요.
- 생각 수준, 도구 승인 같은 한 줄 선택에서 고른 값이 쓸 수 없는 값이면 키보드로 그 줄에 들어갈 수 없었어요.

### 빨라진 것
- 턴이 도는 동안 작업판이 파일을 읽기만 하는 호출이 끝날 때마다 아직 main에 없는 작업을 다시 읽었어요(연결한 컴퓨터의 탭은 분당 열 번 가까이). 이제 편집이나 명령처럼 체크아웃을 바꿀 수 있는 호출 뒤에만 읽어요.

<!-- en -->

Checkboxes look and size the same everywhere in the app, and keyboard movement in the pickers is fixed. The work board asks a paired computer less often.

### Fixed
- Checkboxes and radio buttons in Settings, dialogs and the Changes list had different sizes from place to place. They now all draw at one size in the accent colour.
- In the command palette and the session, branch and file pickers, Tab walked through every result row. Tab from the search field now leaves the list.
- In a one-line choice such as the thinking level or tool approval, the keyboard could not reach the row when its held value was unavailable.

### Faster
- While a turn ran, the work board read the branch's unlanded work again after every finished call, even one that only read files (about ten times a minute on a paired computer's tab). It now reads it only after a call that can change the checkout, such as an edit or a command.

## [0.61.2] - 2026-10-22

연결한 컴퓨터에서 도는 세션도 사이드바에서 하위 세션과 서브에이전트를 보여 줘요. 휴대폰에서 붙어 있는 버튼이 서로의 탭을 가져가던 곳들을 고쳤어요.

### 고친 것
- 연결한 컴퓨터에서 도는 세션의 사이드바 줄에 하위 세션과 서브에이전트가 보이지 않았어요. 이제 이 컴퓨터의 세션처럼 줄 끝의 칩으로 펼쳐 보고, 그 세션이 연 하위 세션은 따로 흩어지지 않고 그 아래에 모여요.
- 휴대폰에서 오토파일럿 시작 창의 (i)를 누르면 옆의 '오토파일럿 시작'이 눌렸어요.
- 좁은 휴대폰에서 가져오기 창의 '모두 선택'이 위 검색칸의 탭을, 디버그 콘솔의 아래 예시 버튼이 위 예시 버튼의 탭을 가져갔어요.
- 휴대폰에서 작업 카드의 결과 칩이 바로 위 '진행 단계' 펼침 버튼의 탭을 가져갔어요.

<!-- en -->

Sessions running on a paired computer show their child sessions and subagents in the sidebar too. Several places on a phone where neighbouring buttons took each other's taps are fixed.

### Fixed
- A session running on a paired computer showed no child sessions or subagents in the sidebar. Its row now opens them from the chip at its end, like this computer's sessions, and the sessions it opened gather under it instead of being loose rows.
- On a phone, a tap on the (i) of the Autopilot start sheet went to Start beside it.
- On a narrow phone, the import dialog's select-all took the search field's taps, and the debug console's lower example button took the upper one's.
- On a phone, a work card's finding chips took taps meant for the Steps toggle just above them.

## [0.61.1] - 2026-10-22

연결한 컴퓨터에 다시 연결해도 열린 탭이 '기기가 오프라인'으로 멈추지 않아요.

### 고친 것
- 이미 연결된 컴퓨터에 **연결**을 다시 누르면, 그 컴퓨터의 열린 탭이 옛 연결에 남아 컴퓨터가 연결돼 있는데도 "이 세션을 실행하는 기기가 오프라인이에요"로 멈췄어요. 이제 탭이 새 연결로 옮겨 가고, 옮기는 순간에도 오류로 깜빡이지 않아요.
- 360px 폰에서 GitHub 이슈 도구 줄이 두 줄로 접히면 '새 이슈' 버튼이 위 줄 검색칸의 아래쪽 탭을 가져갔어요.
- 태블릿에서 오프라인인 컴퓨터 머리줄의 '오프라인' 배지가 읽기 어려울 만큼 작았어요.

<!-- en -->

Connecting again to a paired computer no longer leaves its open tabs stuck reading "offline".

### Fixed
- Pressing **Connect** again for a computer that was already connected left its open tabs on the old connection, reading "The device running this session is offline" while the computer was connected. The tabs now move to the new connection, without flashing an error as they do.
- On a 360 px phone, when the GitHub Issues toolbar wrapped to two lines, New issue took taps meant for the bottom edge of the search field above it.
- On a tablet, the Offline badge on a disconnected computer's header was too small to read.

## [0.61.0] - 2026-10-22

연결한 컴퓨터에서 도는 탭의 기기 칩이 사이드바와 같은 기기 색을 써요. 휴대폰 입력창의 보내기 버튼을 누르기가 더 정확해졌어요.

### 새로 생긴 것
- 연결한 컴퓨터에서 도는 탭의 제목줄 기기 칩이 그 컴퓨터의 사이드바 색을 입어요.

### 고친 것
- 사이드바 기기 머리줄의 색 버튼이 늘 자리를 차지해 기기 이름이 거의 다 잘렸어요. 이제 마우스로는 머리줄에 올리거나 포커스할 때만 보여요(터치에서는 계속 보여요).
- 휴대폰에서 글을 쓴 상태로 보내기 버튼 왼쪽 끝을 누르면 옆의 컨텍스트 링이 눌렸어요.
- 연결한 컴퓨터에서 실행 중인 세션을 다시 불러올 때 대화 끝부분 전체가 아니라 새 메시지만 받아요(두 컴퓨터가 모두 이 버전일 때).

<!-- en -->

A remote tab's device chip wears the same device color as the sidebar. Send in the phone composer takes its taps more reliably.

### Added
- The device chip in a remote tab's title bar wears that computer's sidebar color.

### Fixed
- The device header's color button always took its room and cut the device name to a few letters; with a mouse it now shows on hover or focus (touch keeps it).
- On a phone with a draft, a tap on Send's left edge went to the context ring beside it.
- Reloading a session running on a paired computer receives only its new messages, not the whole tail of the conversation (when both computers run this version).

## [0.60.0] - 2026-10-22

사이드바의 기기 머리줄마다 색이 생겨 연결한 컴퓨터의 세션을 이 컴퓨터 것과 쉽게 구분해요. 작업판은 닫히지 않고 늘 보여요.

### 새로 생긴 것
- 사이드바의 기기 섹션 머리줄이 기기마다 다른 색을 입어요. 연결한 컴퓨터는 색이 저절로 정해지고, 머리줄의 톱니 버튼으로 다른 색이나 색 없음을 고를 수 있어요.

### 고친 것
- 작업판의 닫기 버튼을 없앴어요. 닫으면 다시 열 방법이 없었어요. 이제 자리가 있으면 옆에 붙고, 없으면 상태 줄로 보여요.
- 작업판이 계획을 보여 주는 동안 '할 일 편집'을 눌러도 아무것도 나오지 않았어요. 이제 펼친 할 일 카드가 보여 바로 고칠 수 있어요.
- 연결한 컴퓨터에서 탭을 다시 불러올 때 명령 목록과 대화 끝부분을 매번 통째로 받지 않고 바뀐 부분만 받아요(두 컴퓨터가 모두 이 버전일 때). 바뀌지 않은 명령 목록은 다시 보내지 않아요.

<!-- en -->

Each device header in the sidebar now wears its own color, so a paired computer's sessions are easy to tell from this one's. The work board no longer closes.

### Added
- The sidebar's device section headers each wear their own color. A paired computer gets one by itself; the header's gear picks another color or none.

### Fixed
- The work board's close button is gone: once closed, nothing could open it again. It docks where there is room and shows as the status strip elsewhere.
- Edit todos showed nothing while the work board showed the plan; the opened todo card now shows, ready to edit.
- Reloading a tab of a paired computer no longer receives the whole command list and the transcript's tail every time, only what changed (when both computers run this version); an unchanged command list is not sent again.

## [0.59.1] - 2026-10-22

화면 조작을 백그라운드로만 하도록 설정했을 때도, 화면 제어를 넘겨주지 못한 세션은 입력을 보내지 않아요.

### 고친 것
- omp 설정 `computer.backgroundFallback`이 `refuse`일 때, 화면 제어를 돌려주지 못한 세션이 백그라운드 입력을 계속 보낼 수 있었어요. 이제 그런 세션의 입력은 막히고, 제어를 넘길 때 진행 중이던 조작도 멈춰요.

<!-- en -->

With screen control set to stay in the background, a session that could not give control back no longer sends input.

### Fixed
- With omp's `computer.backgroundFallback` set to `refuse`, a session whose screen control could not be taken back could still send background input; its input is now blocked, and a hand-off stops the action in progress.

## [0.59.0] - 2026-10-22

사이드바의 코드/채팅 탭이 사라지고 한 목록에 프로젝트, 그 아래 채팅이 나와요. 보낸 메시지가 입력한 줄바꿈을 그대로 보여 줘요.

### 바뀐 것
- 사이드바에 코드/채팅 전환이 없어요. 프로젝트들 아래에 기기마다 '채팅' 섹션이 있고, 접을 수 있으며 버튼 하나로 새 채팅을 열어요. 검색 한 줄이 프로젝트와 채팅을 함께 찾아요.
- 오토파일럿이 한 사이클에 서로 독립된 개선 여러 개를 동시에 진행하고, 항목마다 커밋해요.

### 고친 것
- Shift+Enter로 넣은 줄바꿈이 보낸 메시지에서 한 줄로 붙어 보였어요.
- 휴대폰 입력창 아래 줄의 칩, 오토파일럿 '실행 보기' 칩, 컨텍스트 링이 손가락으로 누르기에 작았어요. 이제 36px 터치 영역이에요.
- 연결한 컴퓨터로 가는 데이터를 줄였어요: 컨텍스트 링은 현재 모델의 압축 시점만, 오토파일럿 상태는 바뀐 부분만 받아요(두 컴퓨터가 모두 이 버전일 때).

<!-- en -->

The sidebar's Code/Chat tabs are gone: one list shows the projects and then the chats. A sent message keeps the line breaks you typed.

### Changed
- The sidebar has no Code/Chat switch. Under the projects each device has a Chats section, foldable, with one button for a new chat; one search finds projects and chats alike.
- Autopilot works on several independent improvements side by side in one cycle, with one commit each.

### Fixed
- Line breaks typed with Shift+Enter ran together into one line in the sent message.
- On phones the composer's chips, Autopilot's "Show the run" chip and the context ring were small to tap; they are now 36 px touch targets.
- Less data crosses to a paired computer: the context ring asks only for the current model's compaction point, and an Autopilot run's status sends only what changed (once both computers run this version).

## [0.58.0] - 2026-10-22

오토파일럿의 남은 후속 작업이 오래돼도 목록에서 사라지지 않고 어느 사이클이 남겼는지 보여요. 휴대폰과 태블릿의 실행 설정 시트에서 스위치와 (i)를 누르기 쉬워졌어요.

### 바뀐 것
- 작업 현황의 남은 후속 작업 줄마다 그 일을 남긴 사이클 번호(#N)가 보여요. 오래 기다린 항목을 알아볼 수 있어요.

### 고친 것
- 오토파일럿 실행이 길어지면 아무도 하지 않은 후속 작업이 30 사이클 뒤에 말없이 목록에서 사라졌어요. 이제 그 일을 한 사이클이 닫거나 ✕로 치울 때까지 남아요.
- 휴대폰과 태블릿의 실행 설정 시트에서 스위치 타일의 (i)와 스위치가 손가락으로 누르기에 작았어요. 이제 서로를 가리지 않는 36px 터치 영역이에요.

<!-- en -->

An Autopilot follow-up no longer drops off the list as it ages, and each says which cycle left it. On phones and tablets the Run sheet's switches and (i) are easier to tap.

### Changed
- Each follow-up left on the work board shows the cycle that left it (#N), so one that has waited long stands out.

### Fixed
- In a long Autopilot run a follow-up nobody did vanished from the list 30 cycles later without a word; it now stays until a cycle that does it closes it or you dismiss it with ✕.
- On phones and tablets a Run sheet switch tile's (i) and switch were small to tap; they are now 36 px touch targets that keep clear of each other.

## [0.57.0] - 2026-10-22

오토파일럿 백로그가 없어지고, Windows 노트북 같은 좁은 데스크톱 창에서도 작업 현황이 채팅 오른쪽에 붙으며, Windows에서 오른쪽 패널 버튼이 창 버튼 줄 아래로 내려왔어요.

### 바뀐 것
- 오토파일럿 백로그를 없앴어요. 사이클이 남긴 후속 작업은 그 일을 한 사이클이 닫거나 ✕로 치우고, 다음 사이클이 먼저 할 일은 실행 탭 입력창에 적어요. 집중 영역은 실행 섹션에서 바꿔요.

### 고친 것
- 배율을 높인 Windows 노트북처럼 좁은 데스크톱 창에서는 작업 현황이 위쪽 띠로만 보였어요. 이제 대화 칸을 조금 좁혀 오른쪽에 붙여요.
- Windows에서 오른쪽 패널의 닫기 버튼이 창의 최소화·최대화·닫기 버튼 바로 옆에 있어 창을 닫기 쉬웠어요. 이제 패널 버튼들은 창 버튼 줄 아래 줄에 있어요.
- 연결한 컴퓨터로 턴이 끝날 때 보내는 답변을 다시 통째로 보내지 않아요(두 컴퓨터가 모두 이 버전일 때).

<!-- en -->

The Autopilot backlog is gone, the work board docks beside the chat in narrower desktop windows such as a Windows laptop's, and on Windows the right panel's buttons sit below the window's caption buttons.

### Changed
- The Autopilot backlog is removed. A follow-up a cycle leaves is closed by the cycle that does it or by ✕, and what the next cycle should do first is typed into the run's composer. Focus areas are changed in the run's section.

### Fixed
- In a narrower desktop window, such as a Windows laptop at a higher scale, the work board showed only as the strip at the top; it now docks on the right beside a slightly narrower chat column.
- On Windows the right panel's close button sat right beside the window's minimize, maximize and close buttons, so the window was easy to close by mistake; the panel's buttons now sit on a row below them.
- A paired computer no longer receives each reply whole again when a turn ends (once both computers run this version).

## [0.56.0] - 2026-10-22

연결한 컴퓨터에서 작업 중인 세션이 열어 보기 전에도 사이드바에 작업 중으로 보이고, 상단 바 위에 뜬 창이나 메뉴를 누르면 창이 끌리던 문제를 고쳤어요.

### 새로 생긴 것
- 연결한 컴퓨터에서 작업 중인 세션은 열어 보기 전에도 사이드바 행에 작업 표시(움직이는 빛, 작업 원, 질문이 있으면 대기 색)가 나와요. 두 컴퓨터가 모두 이 버전일 때 보여요.

### 고친 것
- 이미지 보기나 키 큰 모델 선택 창처럼 창 맨 위까지 올라온 대화상자·메뉴를 누르면 창이 끌리던 문제를 고쳤어요.
- 대화 칸 안에서 연 이미지 보기가 칸보다 커서 아래가 잘리던 문제를 고쳤어요. 휴대폰에서는 홈 바에 가리지 않고, 닫기 버튼이 더 누르기 쉬워요.
- 연결한 컴퓨터의 세션 목록을 그 컴퓨터 목록이 바뀔 때만 다시 받아요(전에는 어느 쪽이든 바뀌면 1분에 20번 넘게 받았어요).

<!-- en -->

Sessions a paired computer works on show it in your sidebar before you open them, and clicking a dialog or menu that reaches the top bars no longer drags the window.

### Added
- A session a paired computer is working on shows it on its sidebar row (the moving light, the working circle, or the waiting colour for a question) before you open it, once both computers run this version.

### Fixed
- Clicking a dialog or menu that reaches the window's top bars, such as the image viewer or a tall model picker, dragged the window instead.
- An image viewer opened in a chat pane was taller than the pane and lost its bottom edge; on a phone it now stays clear of the home bar, and its close button is easier to tap.
- A paired computer's session list is read again only when that computer's list changed (any change on either computer read it 20 times a minute and more).

## [0.55.0] - 2026-10-22

이미지 보기에 자체 상단 바가 생겨 Windows 창 닫기 버튼과 헷갈리지 않고, 모델 선택 창이 입력창 바로 위에서 열리며, 사용량을 너무 자주 읽어 생기던 Claude 429 오류가 사라졌어요. omp 18.12.6 이상이 필요해요.

### 새로 생긴 것
- 모델 선택 창이 지금 쓰는 입력창 바로 위에서 열리고, 뒤 화면을 어둡게 하거나 흐리게 하지 않아요(휴대폰은 그대로 아래 시트예요).
- 오토파일럿이 시간 대신 내용으로 릴리스 시점을 정해요. 기본 브랜치에 들어간 사용자에게 보이는 변경이 셋 모이거나, 급한 수정이거나, 하루를 기다린 변경이 있을 때예요.
- Windows에서 Bun으로 전역 설치한 도구 CLI도 알아서 업데이트돼요.
- 디스크 정리가 저장소마다 따로 정한 작업 트리 위치(`worktree.base`)에 있는 작업 트리도 찾아 정리해요.

### 고친 것
- 이미지를 크게 볼 때 맨 위에 파일 이름과 닫기 버튼이 있는 자체 바가 생겼어요. 창 전체를 덮을 때는 Windows의 최소화·최대화·닫기 버튼과 macOS 신호등 자리를 비워, 이미지를 닫으려다 창을 닫는 일이 없어요.
- GUI가 30초마다 사용량을 읽어 Anthropic 계정 조회가 하루 수백 번 429로 실패하던 문제를 고쳤어요. 이제 omp 상태줄처럼 5분마다 읽어요.
- 오래된 인증 헤더가 남은 MCP 서버에 다시 로그인할 수 없던 문제를 고쳤어요.
- 만료되지 않는 프롬프트 캐시를 쓰는 세션(Codex)이 쉬는 동안 자동 압축되지 않아요.
- 알림이 창보다 많이 쌓이면 창 아래로 넘치지 않고 안에서 스크롤돼요.
- 데스크톱 작업 띠가 보일 때 할 일 카드와 작업 섬이 같은 내용을 한 번 더 보여주지 않아요.
- 작업 띠: 아래로 열릴 때 입력창에서 멈추고, 화살표가 패널이 열리는 쪽을 가리키며, 휴대폰에서는 36px 크기로 눌려요.
- 태블릿 작업 카드의 결과 칩이 "진행 단계" 버튼과 겹치지 않아요.
- 오래 돈 오토파일럿 세션을 열 때 받는 대화 양을 줄여(끝 페이지 최대 256K자) 휴대폰에서 더 빨리 열려요.
- 연결된 컴퓨터로 가는 도구 결과와 파일 읽기 결과가 참조로 가서 데이터가 더 줄었어요(두 컴퓨터가 모두 이 버전일 때).

<!-- en -->

Image views get a bar of their own, so their close is never mistaken for the Windows window's; the model picker opens right on the composer; and the Claude 429 errors from reading usage too often are gone. Requires omp 18.12.6 or newer.

### Added
- The model picker opens right above the composer you are using and no longer dims or blurs the window behind it (a phone keeps its bottom sheet).
- Autopilot decides when to release by content, not the clock: three user-visible changes on the default branch, an urgent fix, or a change that has waited a day.
- Windows: a tool CLI installed globally with Bun now updates by itself.
- Disk care also finds and tidies worktrees a repository keeps in its own `worktree.base`.

### Fixed
- A full-size image now has a bar of its own with the file name and its close button. Covering the window, it keeps clear of the Windows minimize, maximize and close buttons and of macOS's traffic lights, so closing an image never closes the window.
- OMPdesk read usage every 30 seconds, and Anthropic account lookups failed with 429 hundreds of times a day; it now reads every 5 minutes, as omp's status line does.
- Signing in again to an MCP server that held a stale authorization header failed; it works now.
- A session whose prompt cache never expires (Codex) is no longer compacted while idle.
- A stack of toasts taller than the window scrolls inside it instead of running past its bottom.
- Beside a desktop work strip, the todo card and the work island no longer repeat what the strip shows.
- Work strip: opening downward it stops at the composer, its chevron points the way it opens, and on a phone it is a 36 px tap.
- A tablet work card's findings sit clear of its Steps toggle.
- Opening a long Autopilot session reads less of its transcript (a page from the end weighs at most 256 K characters), so it opens faster on a phone.
- Tool results and file reads cross to a paired computer as references, so paired computers exchange even less (once both run this version).

## [0.54.0] - 2026-10-22

데스크톱 창에서 작업 보드를 펼쳐도 입력창이 가려지지 않고, "동작 줄이기"를 켠 Mac에서도 도표가 제대로 그려지며, 연결된 컴퓨터와 주고받는 데이터가 크게 줄었어요.

### 새로 생긴 것
- 진단 정보 복사에 화면을 그리는 방식(하드웨어·소프트웨어 렌더링)과 "동작 줄이기" 설정이 들어가요.

### 고친 것
- 보드가 옆에 붙을 자리가 없는 데스크톱 창(예: 1280×800에 사이드바를 연 창)에서 작업 띠를 펼치면 패널이 입력창을 덮고 창 아래로 잘리던 문제를 고쳤어요. 이제 위로 열리고, 짧은 창이나 위아래로 나눈 칸에서도 칸 안에 맞춰 열려요.
- macOS에서 "동작 줄이기"를 켜면 mermaid 도표의 글자와 상자가 사라지고 크게 퍼져 그려지던 문제를 고쳤어요.
- 모델 자동 구성의 이유에서 싼 모델의 가격이 잘려 보이지 않아요($0.075가 $0.07로 보이던 것).
- 태블릿에서도 작업 카드의 "진행 단계" 버튼이 36px 크기로 눌려요.
- 사이드바 기기 머리에 마우스를 올리면 잘린 기기 이름 전체가 보여요.
- 오토파일럿 보드에서 뜻 없던 "초록 사이클마다 기본 브랜치에 반영해요" 줄이 없어졌어요.
- 연결된 컴퓨터로 가는 모델 목록, 모델 역할, 메시지가 훨씬 작게 가요(모델 목록 1.7MB → 약 0.4MB, 모델 역할 882KB → 약 200KB, 한 번 보낸 메시지는 다시 통째로 보내지 않아요). 메시지는 두 컴퓨터가 모두 이 버전일 때 줄어요.

<!-- en -->

The work board no longer covers the composer in a desktop window, diagrams draw right with Reduce motion on, and paired computers exchange far less data.

### Added
- Copy diagnostics names how the window draws (hardware or software rendering) and whether Reduce motion is on.

### Fixed
- In a desktop window with no room to dock the board (1280×800 with the sidebar open, say), the expanded work strip covered the composer and ran past the window's bottom edge; it opens upward now, and fits its pane in a short window or a split stacked in two.
- With macOS's Reduce motion on, a mermaid diagram lost its labels and boxes and spread out huge; it lays out right now.
- The model setup's reasons no longer cut a cheap model's price ($0.075 read as $0.07).
- A work card's Steps toggle is a 36 px target on a tablet too.
- Hovering a device section's header in the sidebar shows the device's whole name.
- The Autopilot board no longer shows the meaningless "each green cycle lands on the default branch" line.
- Paired computers send far less for the model list, model roles and messages (the model list 1.7 MB → about 0.4 MB, model roles 882 KB → about 200 KB, and a message already sent whole is not sent whole again). Messages shrink once both computers run this version.

## [0.53.0] - 2026-10-22

오토파일럿 보드에서 남은 후속 작업을 바로 고정하거나 치울 수 있고, 연결된 컴퓨터마다 실행 중인 OMPdesk 버전이 보이며, 휴대폰과 태블릿의 작은 버튼이 더 누르기 쉬워졌어요.

### 새로 생긴 것
- 오토파일럿 보드에 최근 사이클이 남기고 아직 아무도 하지 않은 후속 작업이 "남은 후속 작업"으로 한 줄씩 보여요. 핀을 누르면 백로그에 올라 다음 사이클이 먼저 하고, ✕로 치울 수 있어요.
- 설정 › 기기 및 연결에서 연결된 컴퓨터마다 실행 중인 OMPdesk 버전과, 이 컴퓨터보다 오래됐는지 새로운지가 보여요.
- 진단 정보 복사에 지금 연결된 컴퓨터들의 OMPdesk 버전이 들어가요(이름은 넣지 않아요).

### 고친 것
- 오토파일럿이 커밋과 같은 메시지에서 사이클을 끝내도 그 커밋을 놓치지 않아요. 지금까지는 초록 사이클이 커밋 없이 기록돼 main에 반영되지 않을 수 있었어요.
- 설정의 "몇 분 전" 표시(연결이 끊긴 기기의 마지막 연결, 디스크 정리, 보안 스캔)가 페이지를 열어 둔 동안에도 움직이고, 언어를 바꾸면 바로 그 언어로 바뀌어요.
- 연결 중인 기기 줄에 "마지막 연결 3시간 전"처럼 연결된 시각이 잘못 나오지 않아요.
- 숫자와 날짜가 운영체제 언어가 아니라 앱의 언어를 따라요.
- 질문이 여러 개인 카드의 단계 칩에 마우스를 올리면 잘린 제목과 그 단계의 질문이 보여요.
- 휴대폰과 태블릿에서 작업 카드, 오토파일럿 보드, 목표 막대, 변경 사항 보기, 터미널 키 막대, 설정의 버튼 묶음, 일정의 요일, 그림 머리, 메시지 동작, 의견 보내기와 워크트리 대화상자의 작은 버튼이 36px 크기로 눌리고, 서로의 탭을 가로채지 않아요. 컴퓨터 화면은 그대로예요.
- 연결이 끊겨 취소가 omp에 닿지 못한 로그인은 그렇다고 알려 줘요.
- 오토파일럿 상태와 서브에이전트 이벤트, 턴 끝 알림이 창과 연결된 기기로 더 작게 가요.
- 휴대폰 첫 화면이 더 가벼워졌어요(디버그 콘솔과 가져오기 대화상자는 처음 열 때 불러와요).

<!-- en -->

The Autopilot board lets you pin or dismiss what the recent cycles left for later, each connected computer shows the OMPdesk version it runs, and small buttons on a phone or tablet are easier to tap.

### Added
- The Autopilot board lists what recent cycles left for later and no later cycle did ("Left for later"), one line each. A pin puts one on the backlog so the next cycle does it first; ✕ dismisses it.
- Settings › Devices & connections names the OMPdesk version each connected computer runs, and whether it is older or newer than this one.
- Copy diagnostics includes the OMPdesk versions of the computers connected now (never their names).

### Fixed
- An Autopilot cycle that ends in the same message as its commit keeps that commit; a green cycle could be recorded without one and never land on main.
- Settings' "ago" times (an away device's last connection, disk care, security scans) move on while the page stays open, and follow a language switch at once.
- A connected device's line no longer reads "last seen" hours ago.
- Numbers and dates follow the app's language, not the OS locale.
- Hovering a step chip of a several-question card shows its full label and the question that step asks.
- On a phone or tablet, the small buttons of work cards, the Autopilot board, the goal bar, the Changes view, the terminal's key bar, Settings' button clusters, a schedule's days, figure headers, message actions and the feedback and worktree dialogs are 36 px targets that no longer take each other's taps. The desktop layout is unchanged.
- A sign-in whose Cancel could not reach omp over a dropped link says so.
- Autopilot status, subagent events and turn ends reach windows and paired devices smaller.
- The phone's first screen is lighter: the debug console and the import dialog load when first opened.

## [0.52.7] - 2026-10-21

연결이 잠깐 끊겨 링크나 업데이트 버튼이 실패하면 이제 알려 주고, 휴대폰과 태블릿의 작은 버튼이 더 누르기 쉬워요.

### 고친 것
- 링크를 열지 못하거나(연결이 끊김, 휴대폰이 막는 주소) 업데이트 받기·설치·나중에 버튼이 컴퓨터에 닿지 못하면 알림이 떠요. 지금까지는 눌러도 아무 일이 없었어요.
- 업데이트 실패 알림의 "다시 확인"이 메뉴의 확인과 같아져, 결과가 사이드바 카드에 나와요.
- 워크트리를 만들지·지울지 묻는 질문의 답이 전달되지 않으면 알려 주고, 질문은 그대로 남아 다시 답할 수 있어요.
- 휴대폰 페이지가 켜지거나 다시 연결되는 동안 연결이 끊겨도 페이지 오류가 남지 않아요.
- 휴대폰과 태블릿에서 실행 설정의 (i) 안내 아이콘, 그림·코드 블록의 미리보기·코드·복사·내려받기·확대 버튼이 36px 크기로 눌려요. 컴퓨터 화면은 그대로예요.
- 오토파일럿 상태가 바뀔 때마다 창과 연결된 기기로 가는 데이터가 더 줄었어요(각 사이클 요약을 로그처럼 400자로 보내요).

<!-- en -->

When a dropped link makes a link or an update button fail, the app now says so, and small buttons on a phone or tablet are easier to tap.

### Fixed
- A link that cannot open (the link to the computer dropped, an address the phone page refuses) and an update button (download, install, later) that cannot reach the computer now say so; until now the click did nothing.
- The update failure notice's "Check again" is the menu's check, and its outcome lands in the sidebar card.
- An answer to the worktree question (create, remove) that could not be sent says so, and the question stays up to answer again.
- A phone page that loses the link while it starts or reconnects no longer leaves page errors behind.
- On a phone or tablet, the Run settings' (i) glyphs and a figure's or code block's Preview, Code, copy, download and enlarge buttons are 36 px targets. The desktop layout is unchanged.
- Each Autopilot status update to windows and paired devices is smaller again: every cycle's summary goes as the log clips it, 400 characters.

## [0.52.6] - 2026-10-21

휴대폰에서 연결이 잠깐 끊겨도 화면에 오류가 남지 않고, 휴대폰의 작은 글자와 버튼이 더 다루기 쉬워져요.

### 고친 것
- 휴대폰 페이지가 연결이 잠깐 끊기는 동안 보낸 요청 몇 가지(하위 에이전트 구독, 슬래시 명령 목록과 인자 완성, 세션 고정)의 실패를 놓쳐 페이지 오류를 남기던 문제를 고쳤어요. 보이던 명령은 그대로 남고, 고정이 실패하면 경고가 떠요.
- 휴대폰에서 오토파일럿 실행 버튼, 벤치마크 모델, 원격 기기 주소 복사 버튼의 누르는 영역이 다시 충분히 커요(지난 버전에서 26~29px로 작아졌어요). 컴퓨터 화면은 그대로예요.
- 휴대폰에서 표 글자가 다른 작은 글자와 같은 12px이에요(11.3px였어요).
- 오토파일럿 상태가 바뀔 때마다 창과 연결된 기기로 가는 데이터가 약 30% 줄었어요. 화면이 쓰지 않는 각 사이클의 검사 명령과 닫힌 후속 목록을 빼요.

<!-- en -->

A phone page that loses the link for a moment no longer leaves errors behind, and small text and buttons on a phone are easier to use.

### Fixed
- A few calls a phone page makes (the subagent subscription, the slash-command list and argument completions, the session pin) left a page error when the link dropped for a moment. The commands shown stay, and a pin that fails warns.
- On a phone, the running Autopilot's buttons, the benchmark's models and the remote addresses' copy buttons are big enough to tap again (the last version cut them to 26 to 29 px). The desktop layout is unchanged.
- A table's text on a phone is 12 px like the rest of the small text (it was 11.3 px).
- Each Autopilot status update sent to windows and paired devices is about 30 % smaller: it leaves out each cycle's check command and closed follow-ups, which nothing on screen reads.

## [0.52.5] - 2026-10-21

휴대폰과 태블릿에서 붙어 있는 버튼을 누를 때 옆 버튼이 눌리지 않고, 진단 정보가 긴 로그를 더 짧게 담아요.

### 고친 것
- 휴대폰에서 바로 옆 컨트롤이 눌리던 곳을 고쳤어요: 진행 중인 하위 세션 목록, GitHub·PR 화면의 열림/닫힘/전체 탭, 오토파일럿 실행 중 버튼, 원격 기기 주소 복사, 벤치마크 모델 목록, 터미널 도구줄, 세션 가져오기의 검색 칸과 새로고침. 컴퓨터 화면의 배치는 그대로예요.
- 진단 정보 복사가 5분마다 남는 업데이트 확인 줄을 다른 줄 사이에 있어도 하나로 접어, 마지막 100줄에 정말 일어난 일이 더 많이 담겨요. 상태가 바뀌었다 돌아온 기록은 순서대로 모두 남아요.

<!-- en -->

Close controls on a phone or tablet no longer take each other's taps, and Copy diagnostics fits more of what happened into its window.

### Fixed
- A tap on a phone no longer lands on the control beside the one under the finger: the sessions at work, the Open/Closed/All tabs of the GitHub and PR pages, the running Autopilot's buttons, the remote addresses' copy buttons, the benchmark's models, the terminal toolbar, and the import dialog's search and refresh. The desktop layout is unchanged.
- Copy diagnostics folds the update check's every-5-minutes line into one even between other lines, so its last 100 lines hold more of what really happened; a state that changed and came back keeps every step in order.

## [0.52.4] - 2026-10-21

AI가 답하는 동안 화면과 다른 기기로 가는 데이터가 더 줄고, 변경 사항의 stash 수가 바로 바뀌어요.

### 고친 것
- AI 답변이 실시간으로 올 때마다 함께 가던, 화면이 쓰지 않는 요청 기록을 빼요. 긴 세션에서는 메시지 하나의 80% 가까이 되던 양이라, 이 컴퓨터의 화면과 다른 기기 모두 가벼워져요.
- 대화 기록을 불러올 때 AI 생각 블록의 서명값을 빼요. 화면은 이 값을 쓰지 않고, 긴 세션 첫 페이지의 약 5분의 1이었어요.
- 변경 사항 패널이 stash를 만들거나 지우면 stash 수를 바로 다시 읽어요. 지금까지는 파일이 바뀌기 전까지 옛 수가 남았어요.
- 오토파일럿이 초록 사이클을 main에 반영하기 전 다시 돌리는 검사가, 사이클이 보고한 저장소 검사예요. 지금까지는 마지막에 돌린 일부 테스트만 다시 돌 수 있었어요.
- 오토파일럿이 만든 AUTOPILOT.md의 릴리스 주기 줄이 "가이드를 쓸 때의 최신 릴리스"라고 적어요. 가이드는 다시 쓰이지 않아서 "최신 릴리스"가 곧 틀린 정보가 됐어요.

<!-- en -->

Less data reaches the window and paired devices while the agent answers, and the Changes bar's stash count updates at once.

### Fixed
- Live answer events no longer carry the request bookkeeping no window reads, close to four fifths of a message in a long session, to this computer's windows and to paired devices.
- Transcript pages leave out each thinking block's provider signature, which nothing on screen reads (about a fifth of a long session's first page).
- The Changes panel reads the stash count again as soon as a stash is made or removed; it kept the old count until a file changed.
- Before Autopilot lands a green cycle on main it runs the check the cycle reported, not a narrower run that came after it.
- The AUTOPILOT.md Autopilot writes names the latest release as of when the guide was written, since the guide is never rewritten.

## [0.52.3] - 2026-10-21

다른 기기에서 이 컴퓨터의 세션을 볼 때 주고받는 데이터가 크게 줄어요.

### 고친 것
- 화면이 15초마다, 그리고 턴마다 세션 상태를 확인할 때 시스템 프롬프트와 도구 설명 전체를 더는 받지 않아요. 다른 기기에서 이 컴퓨터의 세션 하나를 보는 것만으로 1분에 약 3 MB를 받던 일이 사라져요. 두 컴퓨터가 모두 이 버전이어야 효과가 있어요.
- 목표나 오토파일럿처럼 오래 이어지는 실행에서 대화 기록을 처음 불러올 때 몇 시간 치를 한꺼번에 받지 않아요. 이 저장소의 오토파일럿 세션에서는 4.6 MB가 0.5 MB로 줄었어요. 앱을 열 때와 다른 기기가 다시 연결될 때 빨라져요.
- 에이전트가 세션 목록을 보거나 끝난 세션을 닫을 때도 필요 없는 세션 정보를 받지 않아요.

<!-- en -->

Much less data crosses the link while another device views a session on this computer.

### Fixed
- The page's session-state checks, every 15 seconds and at every turn, no longer carry the whole system prompt and every tool's schema. Viewing one session of this computer from another device no longer costs about 3 MB a minute. Both computers need this version.
- Opening the transcript of a long goal or Autopilot run no longer loads hours of it at once: this repository's Autopilot session went from 4.6 MB to 0.5 MB. Opening the app and a paired device's reconnect are faster.
- An agent listing sessions or closing a finished one no longer reads session details it does not use.

## [0.52.2] - 2026-10-21

오토파일럿 타임라인이 대화 언어로 적히고, 진단 정보 복사에 실제로 일어난 일이 담겨요.

### 고친 것
- 오토파일럿 타임라인의 사이클 제목, 요약, 후속 항목이 대화 언어를 따라요. 지금까지는 에이전트가 영어로 써서 한국어 화면에서도 영어로 보였어요. 새로 시작하는 세션부터 적용돼요.
- 진단 정보 복사에서 시간만 다르고 내용이 같은 로그 줄이 연달아 나오면 횟수와 함께 한 줄로 접어요. 5분마다 남는 업데이트 확인 줄이 최근 기록을 다 차지하지 않아요. 로그 파일은 그대로 모두 기록해요.
- 메모리가 이름이 겹쳐 읽을 수 없게 된 프로젝트를 앱 시작 때뿐 아니라 실행 중에도 한 시간에 한 번 고쳐요. 고치지 못하면 그 이유를 로그에 남겨요.
- 다른 컴퓨터와 주고받은 데이터 기록이 세션 명령을 종류별로 나눠 남겨요. 어떤 명령이 데이터를 많이 쓰는지 알 수 있어요.
- 오토파일럿이 다른 저장소에 만들어 주는 AUTOPILOT.md가 없어진 오토파일럿 패널 대신 작업 보드를 가리켜요.

<!-- en -->

The Autopilot timeline is written in your conversation language, and Copy diagnostics shows what actually happened.

### Fixed
- An Autopilot cycle's title, summary and follow-ups on the run's timeline follow the conversation language. The agent wrote them in English, so a Korean screen showed English. Applies from sessions started after the update.
- Copy diagnostics folds a run of log lines that differ only in their time into one line with a count, so the update check written every 5 minutes no longer fills the recent entries. The log file itself still records every line.
- Memory repairs a project whose name became unreadable (shared with another project's key) while the app runs, at most once an hour, not only at launch, and logs why when it cannot.
- The log of what crosses the link to a paired computer names each session command's type, so the commands that use the most data can be found.
- The AUTOPILOT.md Autopilot writes into other repositories points to the work board instead of the removed Autopilot panel.

## [0.52.1] - 2026-10-21

두 컴퓨터가 같은 저장소를 다른 이름으로 부를 때도 메모리가 한 프로젝트로 모여요.

### 고친 것
- 다른 컴퓨터에서 동기화된 메모리가 저장소 정보를 함께 가져와서, 이 컴퓨터가 처음 그 저장소에서 작업할 때 따로 갈라진 프로젝트를 만들지 않아요. 프로젝트 이름이 서로 달라도 같은 저장소로 맞춰져요.
- 예전에 이름만 보고 동기화돼 따로 떨어져 있던 메모리를, 두 컴퓨터가 모두 저장소 정보를 보내게 되면 한 번 다시 동기화해 제자리로 돌려놔요.
- 다른 컴퓨터와 주고받은 데이터 기록에 어떤 종류의 데이터였는지도 남아요. 진단 정보를 복사하면 함께 들어가요.

<!-- en -->

Memory comes together in one project even when two computers call the same repository by different names.

### Fixed
- Memory synced from another computer carries its repository, so this computer's first own work in that repository no longer splits off a second project, whatever each computer names it.
- Memory that was synced by name before and ended up apart is synced once more, into its repository's project, once both computers send repositories.
- The log of what crosses the link to a paired computer keeps what kinds of data it was; Copy diagnostics includes it.

## [0.52.0] - 2026-10-21

실행 중이라 지우지 못하던 세션을 한 번에 멈추고 지울 수 있고, 재시작 뒤 다른 기기가 다시 보낸 요청이 두 번 실행되지 않아요.

### 새로 생긴 것
- 실행 중이라 세션 삭제가 거절되면 안내에 "멈추고 삭제"가 떠요. 누르면 그 세션의 턴을 멈추고, 멈춘 뒤 바로 지워요. 이 컴퓨터의 세션도, 다른 컴퓨터의 세션도 같아요.

### 고친 것
- 이 컴퓨터가 재시작한 뒤 다른 컴퓨터가 다시 보낸 에이전트 요청(세션 열기, 메시지 보내기, 멈추기, 병합, 예약 만들기 등)이 두 번 실행되지 않아요. 결과를 알 수 없으면 다시 실행하지 않고 그렇다고 알려요.
- 오토파일럿이 다른 세션의 푸시나 작업 브랜치 때문에 안전 점검에서 멈추지 않아요. 멈출 때는 예상하지 못한 git 변경을 봤다고 말하고, 재개하면 이어간다고 알려요.
- 메모리가 읽지 못하는 프로젝트 하나 때문에 다른 프로젝트의 학습과 정리가 멈추지 않아요. 이름이 같아 헷갈리는 프로젝트는 한 번 정리하고, 두 컴퓨터가 같은 저장소를 각자 프로젝트로 맞춰 동기화해요.
- 창이 가려져 있는 동안 하위 에이전트 목록, 계획 카드, PR 창이 omp에 아무것도 묻지 않아요.
- GitHub 도구 카드가 초안 PR과 실행 결과를 화면 언어로 보여요.

<!-- en -->

A session a running turn kept from being deleted now stops and deletes in one step, and a request another computer sends again after this one relaunched no longer runs twice.

### New
- When a running turn refuses a session's delete, the notice offers "Stop and delete": it stops the turn on that session and deletes it once the turn has ended, on this computer and on a paired one alike.

### Fixed
- An agent request a paired computer sends again after this computer relaunched (open a session, send, stop, merge, create a schedule and the like) no longer runs twice; when its outcome cannot be known it says so instead of running again.
- Autopilot no longer pauses its safety check for another session's push or worktree branch; when it does pause, it says it saw a git change it did not expect and that Resume continues.
- One memory project the server cannot read no longer stops learning and curation for every other project; an ambiguous project name is repaired once, and two computers pair the same repository under their own projects when syncing.
- While the window is hidden, the subagent roster, the plan card and the PR dialog ask omp nothing.
- The GitHub tool card names a draft PR and a run's conclusion in the UI's language.

## [0.51.0] - 2026-10-21

GitHub 화면이 GitHub 영어 대신 화면 언어로 보이고, 오토파일럿이 결과를 main에 더 안정적으로 반영해요.

### 새로 생긴 것
- 사이드바 너비를 키보드로 조절할 수 있어요. 경계선에 초점을 두고 화살표, Home, End를 눌러요.
- 워크플로 실행 창에서 브랜치를 비워 두면 저장소의 기본 브랜치에서 실행해요.

### 고친 것
- GitHub Actions의 실행 결과, 실행을 시작한 이벤트, 알림의 종류와 이유가 영어 대신 화면 언어로 보여요.
- 결과가 "중립"인 Actions 실행에 "실패한 작업 다시 실행" 버튼이 나오던 문제를 고쳤어요. GitHub에서 꺼진 워크플로는 실행 버튼이 왜 꺼졌는지 알려 줘요.
- 오토파일럿 작업현황에 누를 일이 없는 내보내기 버튼, 다음 사이클 지시 칸, "초록 사이클마다 푸시" 스위치가 더는 나오지 않아요. 다음 사이클에 줄 말은 채팅으로 보내요. 작업현황이 좌우로 스크롤되던 문제도 고쳤어요.
- 오토파일럿이 Finder로 연 앱에서 main 반영 전 검사를 돌리지 못하던 문제(`bun`을 찾지 못함), 평범한 fetch 뒤에 "금지된 작업"으로 멈추던 문제를 고쳤어요.
- 오토파일럿의 main 반영이 거절되면 검사의 첫 오류를 알려 주고, 끝낸 후속 작업을 다시 하라고 하지 않아요.
- 다른 컴퓨터가 업데이트로 재시작해도 그 컴퓨터에서 돌던 세션의 턴이 멈추지 않아요.
- 다른 기기가 세션을 지울 때 그 세션이 쉬고 있는 탭에 열려 있으면 탭을 닫고 지워요. 예전에는 계속 거절됐어요.
- 피드백에 붙는 오류 기록이 넘칠 때 가장 최근 오류가 아니라 가장 오래된 오류를 빼요.
- 화면이 소프트웨어 렌더링으로 그려질 때 반복 애니메이션이 한 번만 돌고 멈춰요.
- 작업현황 카드의 높이 조절 손잡이가 스크린 리더에 높이를 알려 주고 Home·End로 움직여요.

<!-- en -->

The GitHub screens read in the UI's language instead of GitHub's English, and Autopilot lands its results on main more reliably.

### New
- The sidebar's width can be changed from the keyboard: focus its edge and use the arrows, Home and End.
- Run workflow starts on the repository's default branch when the branch field is left empty.

### Fixed
- GitHub Actions run results, the event that started a run, and a notification's kind and reason read in the UI's language instead of GitHub's English.
- A "neutral" Actions run no longer offers "Re-run failed jobs", and a workflow turned off on GitHub says why Run workflow is off.
- Autopilot's work board no longer shows shipping buttons nobody needs to press, a next-cycle instruction field or a "push after every green cycle" switch; tell the next cycle what to do in the chat. The board no longer scrolls sideways.
- Autopilot's check before landing on main now runs in an app opened from Finder (it could not find `bun`), and a plain fetch no longer pauses a run as a forbidden action.
- A refused landing names the check's first error, and Autopilot no longer sends the agent back to follow-ups it finished.
- A session running on a paired computer keeps its turn going when that computer restarts for an update.
- Deleting a session from another device closes an idle tab holding it and deletes it, instead of being refused for good.
- The error log attached to feedback drops the oldest errors when it is over its size, not the newest.
- Under software rendering every looping animation plays once and rests.
- The work board card's height handle tells screen readers its height and moves with Home and End.

## [0.50.0] - 2026-10-21

오토파일럿 화면이 작업현황으로 옮겨졌고, 업데이트나 재시작 뒤에도 하던 일이 끊기지 않고 이어져요.

### 새로 생긴 것
- 오토파일럿 화면이 오른쪽 패널이 아니라 작업현황 맨 위에 보여요. 창이 좁거나 다른 패널이 열려 있으면 대화 위 한 줄로 보이고, 누르면 펼쳐져요.
- 프로젝트가 세션과 따로 사이드바에 남아요. 세션을 모두 지워도 프로젝트는 그대로이고, 프로젝트 메뉴의 "사이드바에서 제거"로만 빠져요. 다른 컴퓨터도 각자 목록을 가져요.
- 업데이트가 기본으로 자동 설치돼요. "중단된 작업 이어 하기"가 켜져 있으면 작업 중이어도 안전한 순간(열린 질문·승인 카드와 대화 압축이 없을 때) 60초 안내 뒤 재시작하고, 하던 일은 이어서 해요.
- 오토파일럿이 바쁜 main에도 결과를 반영해요. 그사이 main이 바뀌었으면 합친 결과를 따로 다시 검사하고, 통과한 것만 올려요.
- 작업현황에서 끝난 하위 세션이 "n개 완료" 한 줄로 접혀요.
- 사이드 패널에는 터미널·변경·미리보기·파일만 남았어요. 백그라운드 작업·계획·로그·트리·작업 트리는 명령 팔레트와 메뉴에서 작은 창으로 열고, 대기열은 입력창의 대기열 버튼에서, 메모리는 설정에서 다뤄요.
- 메인 세션이 일하는 중에도 하위 세션의 보고를 바로 받아요. 기다리던 작업이 있어도 보고가 오면 먼저 읽어요.
- 메인 세션이나 앱이 강제로 꺼져도 하위 세션의 보고가 사라지지 않고, 다시 켜지면 한 번만 전달돼요.
- 사이드바 세션 줄이 작업 중이면 도는 표시를 보여요. 하위 에이전트나 그 세션이 연 세션(다른 기기 포함)이 일할 때도요. 쉬는 줄의 시간은 마지막 대화 기준이라 재시작해도 바뀌지 않아요.
- 채팅 탭의 기기 줄 버튼이 프로젝트 추가가 아니라 그 기기에서 새 채팅을 열어요.
- MCP 서버마다 꺼진 이유를 보여주고, omp에서 쓰기·로그인 버튼, 열린 탭에 바로 적용, 입력창의 `/mcp reauth`·`/mcp reload`를 넣었어요.

### 고친 것
- 업데이트로 재시작한 뒤 하던 턴이 이어지지 않던 문제를 고쳤어요.
- 앱을 끌 때 다른 컴퓨터의 탭이 사라지던 문제, 하위 세션의 완료 보고가 사라지던 문제를 고쳤어요.
- 업데이트 확인이 끝나지 않고 계속 돌던 문제를 고쳤어요.
- 탭을 바꾸는 중에 누른 키가 다른 탭으로 가거나 사라지던 문제를 고쳤어요.
- 오토파일럿 할 일 목록에 같은 이름의 항목이 지워지지 않고 남던 문제를 고쳤어요.
- omp 18.12.5에서 바뀐 프롬프트 캐시 옵션에 한국어 설명을 넣었어요.
- PR 센터에서 Jenkins·Prow 같은 외부 검사가 계속 "진행 중"으로만 보이던 문제, 검사 상태가 영어로 나오던 문제, 이름이 같은 검사 줄이 남던 문제를 고쳤어요. (오토파일럿이 고친 것)
- MCP 로그인이 설정의 프로바이더·계정 목록에 계정처럼 뜨던 문제를 고쳤어요.
- 다른 세션의 에이전트가 연 세션에 제목이 생기지 않던 문제를 고쳤어요.
- 할 일이 많을 때 작업현황 진행 막대가 개수 숫자와 겹치던 문제를 고쳤어요.
- 재시작 뒤 작업현황의 "n개 완료" 개수가 두 번 세어지던 문제를 고쳤어요.

### 고친 것 (Windows)
- 다른 컴퓨터의 세션을 지워도 파일이 다시 생기던 문제를 고쳤어요.
- 예약 실행을 멈출 때 그 사이 새로 뜬 프로세스가 남던 문제를 고쳤어요.
- 오토파일럿이 main에 반영하기 전 검사에서 경로 표기 때문에 실패하던 문제를 고쳤어요.

<!-- en -->

The Autopilot screen moved to the work board, and work picks up where it left off after an update or a restart.

### New
- Autopilot shows at the top of the work board instead of the side panel. In a narrow window or beside another panel it is one line above the conversation that opens on a click.
- Projects stay in the sidebar apart from their sessions: deleting every session keeps the project, and only the project menu's "Remove from sidebar" takes it out. Each paired computer keeps its own list.
- Updates install by themselves by default. With "Continue interrupted work" on, the app restarts at the next safe moment (no open question, approval or compaction) after a 60-second notice, even while work runs, and the work continues.
- Autopilot lands its results on a busy main: when main moved, the merged result is checked again on its own and only a passing one lands.
- Finished child sessions fold into one "n done" row on the work board.
- The side panel keeps Terminal, Changes, Preview and Files. Background tasks, plan, logs, session tree and work tree open as sheets from the command palette and menus; the queue lives in the composer's queue button and memory in Settings.
- A main session receives its child sessions' reports while it works, and a wait returns as soon as one arrives.
- A child's report survives the receiver's omp or the app being killed and is delivered exactly once after the relaunch.
- A sidebar session row shows a working arc while it, its subagents or the sessions it opened (on any device) work; an idle row's age is its last message, so a restart no longer changes it.
- In the Chat lane a device row's button starts a new chat on that device instead of adding a project.
- Each MCP server says why it is off, with "Use in omp" and Sign in actions, changes apply to every open tab, and the composer takes `/mcp reauth` and `/mcp reload`.

### Fixed
- A turn cut off by an update restart now continues.
- A paired computer's tab no longer disappears when the app quits, and a child session's done report is no longer lost.
- An update check no longer spins forever.
- Keys pressed while switching tabs no longer go to the wrong tab or get lost.
- Autopilot's todo list no longer keeps a stale row when two items share a name.
- omp 18.12.5's renamed prompt-cache option has its Korean text.
- The PR Center no longer shows outside checks such as Jenkins or Prow as pending forever, shows check states in the UI's language, and no longer keeps a stale row when two checks share a name. (Fixed by Autopilot)
- An MCP server's sign-in no longer shows as an account under Settings › Providers & accounts.
- A session another session's agent opened now gets a title.
- The work board's progress bar no longer overlaps its count on a long plan.
- The work board's "n done" count no longer counts a child twice after a relaunch.

### Fixed (Windows)
- Deleting a paired computer's session no longer leaves its file behind.
- Stopping a scheduled run no longer leaves a process that started during the stop.
- Autopilot's check before landing on main no longer fails on Windows path spellings.

## [0.49.0] - 2026-10-21

설정이 훨씬 줄었고, 오토파일럿 결과가 main에 저절로 올라가며, 작업현황에서 하위 세션이 하는 일이 보여요.

### 새로 생긴 것
- 오토파일럿이 검사를 통과한 사이클을 기본 브랜치(main)에 저절로 올려요. 강제 푸시는 하지 않고, main이 그사이 바뀌었으면 먼저 합치고 다시 검사해요. 보호된 브랜치면 PR 하나에 모아요. 실행이 끝나거나 멈추면 사이클·커밋·반영 수를 한 줄로 알려 줘요.
- 오토파일럿이 프로젝트를 보고 배포 규칙을 알아서 만들어요. 가이드 상자는 이제 보이지 않아요.
- 작업현황에서 하위 세션마다 지금 하는 일, 묻고 있는 질문, 끝난 결과가 한 줄씩 보여요. 하위 세션을 기다리는 동안 작업 카드에도 일하는 하위 세션이 보여요.
- 작업현황의 바뀐 파일과 +/− 줄 수에 하위 세션 작업까지 들어가요. 끝난 할 일은 "n개 완료" 한 줄로 접혀요.
- 자동 모드가 계획 모드를 고르면 승인 카드 없이 계획을 짜고 바로 진행해요. 직접 켠 계획 모드는 그대로 물어요.
- 사이드바의 "이 기기" 줄에도 프로젝트 추가 버튼이 생겼어요. 기기 목록이 보일 때는 검색칸 옆 버튼을 숨겨 검색칸이 넓어져요.
- 워크트리 세션이 별도 목록이 아니라 그 프로젝트 안에 보여요.

### 바뀐 것
- 설정 9개를 하나로 합치거나 자동으로 바꿨어요. 사고 과정은 "숨김·접힘·펼침" 하나로, 도구 자동 업데이트 셋은 "도구 최신으로 유지" 하나로, 새 기기 승인 둘은 하나로 합쳤어요. 창 제목 실행 상태와 앱 아이콘 진행률은 항상 켜져요. 쓰던 값은 그대로 이어져요.
- 설정 모든 화면의 간격과 줄 높이를 맞췄어요.
- 오토파일럿 시작 화면의 브랜치는 지금 폴더의 브랜치만 보여요.

### 고친 것
- 자동 모드가 길고 구체적인 첫 메시지를 계획 모드로 보내던 문제를 고쳤어요.
- 보내기가 끝나기 직전에 누른 Enter가 사라지던 문제, 탭을 바꾼 직후 누른 첫 키가 사라지던 문제, 새 탭이 열리는 중에 누른 ⌘W가 이전 탭을 닫던 문제를 고쳤어요.
- 원격 호스트를 다시 켠 직후 휴대폰이 오류를 받던 문제, 휴대폰 미리보기에서 한글과 영어 입력 순서가 바뀌던 문제를 고쳤어요.
- 업데이트 확인이 응답 중간에 멈추면 계속 기다리던 문제를 고쳤어요.
- 오래된 할 일 목록을 새 요청에서 에이전트가 잊지 않고 고쳐요.

### 고친 것 (Windows)
- 계획 파일이 Windows 경로면 계획 패널이 비어 보이던 문제를 고쳤어요.
- 다른 프로그램이 파일을 열고 있으면 설정·페어링·재개 기록 저장이 실패하던 문제를 고쳤어요.
- 예약 실행을 멈춰도 omp가 남아 폴더를 잡고 있던 문제, 주사율 높은 모니터에서 ⌃Tab 뒤 포커스가 사라지던 문제를 고쳤어요.

<!-- en -->

Far fewer settings, Autopilot lands its results on main by itself, and the work board shows what each child session is doing.

### New
- Autopilot lands green cycles on the default branch by itself: fast-forward only, never forced; when main moved it merges and checks again first; a protected branch gets one pull request. Each run ends with a one-line summary of cycles, commits and what landed.
- Autopilot writes the project's release rules from the project itself; the guide box is gone.
- The work board shows, under each child session, what it is doing, the question it asks, or its result; while the parent waits on children, its work card lists the ones at work.
- The work board's changed files and +/− count the child sessions' work too; finished todos fold into one "n done" row.
- When automatic mode picks Plan, the plan runs without an approval card; a Plan you turn on yourself still asks.
- The sidebar's "This device" row has its own add-project button; while device sections show, the search row's button goes and search takes the width.
- Worktree sessions show inside their project instead of a separate list.

### Changed
- Nine settings were merged or made automatic: thinking is one hidden/collapsed/expanded choice, the three tool auto-update switches are one "Keep tools up to date", the two new-device approvals are one, and the window-title run state and app-icon progress are always on. Your saved values carry over.
- One spacing rhythm across every Settings page.
- Autopilot's start sheet shows only the folder's current branch.

### Fixed
- Automatic mode no longer sends long, concrete first messages to Plan.
- An Enter pressed just before a send finished, the first key after a tab change, and ⌘W pressed while a new tab opened no longer go astray.
- A phone no longer gets an error right after its host restarts, and phone preview keeps Korean and English keys in order.
- An update check that stalls mid-response no longer waits forever.
- The agent updates a stale todo list when a new request arrives.

### Fixed (Windows)
- The Plan panel reads a plan at a Windows path.
- Saving settings, pairing and resume records no longer fails while another program has the file open.
- A stopped scheduled run no longer leaves omp holding the folder, and focus survives ⌃Tab on high-refresh displays.

## [0.48.0] - 2026-10-21

노트북이 충전 중이면 덮개를 닫아도 작업이 멈추지 않고, Windows에서 디스크 정리와 세션 닫기가 제대로 동작해요.

### 새로 생긴 것
- 노트북이 충전 중이면 덮개를 닫아도 OMPdesk가 하던 작업을 계속해요. 배터리로 바뀌면 평소처럼 잠들어요. 맥과 Windows 노트북 모두 되고, 설정은 따로 없어요. "작업 중에는 잠자기 막기"가 이제 기본으로 켜져 있어요.

### 고친 것
- 작업이 끝났는데 "정리 중"에 계속 머물던 문제를 고쳤어요(할 일 목록 오류 뒤에 생기던 문제).
- 에이전트가 일을 시작할 때 절차 문서를 읽느라 한 번 더 왕복하지 않아서, 응답이 조금 빨라졌어요.
- 앱을 다시 켠 뒤 부모 세션이 이어서 진행 중인데 하위 세션이 먼저 닫히던 문제를 고쳤어요.
- 다른 컴퓨터의 하위 에이전트가 돌 때 오가는 데이터를 3~7분의 1로 줄였어요. 데이터가 한꺼번에 몰리면 작업이 "작업 중"에 멈춰 있던 문제도 고쳤어요.
- 휴대폰에서 새로고침하면 "탭을 쓸 수 없어요" 알림이 뜨던 문제, 휴대폰에 처음 설치한 직후 페이지가 다시 로드되던 문제를 고쳤어요.
- 말풍선 설명이 그 아래 버튼의 클릭을 가로채던 문제를 고쳤어요.
- 디스크 사용량을 재는 시간이 크게 줄었어요(맥 18초 → 0.4초, Windows 30초 → 0.4초).
- 업데이트 확인이 네트워크가 멈췄을 때 계속 "확인 중"에 머물지 않아요.

### 고친 것 (Windows)
- 디스크 정리가 Electron이 들어 있는 작업 폴더를 지우지 못하던 문제를 고쳤어요(앱이 그 파일을 붙잡고 있었어요).
- 세션을 닫거나 지울 때 omp가 완전히 끝난 뒤에 폴더를 정리해요. Windows가 바쁠 때 닫은 세션의 omp가 남아 있던 문제도 고쳤어요.

<!-- en -->

A charging laptop keeps working with its lid closed, and disk care and session closing work properly on Windows.

### New
- While a laptop is charging, closing its lid no longer stops OMPdesk's work; on battery it sleeps as usual. On Mac and Windows laptops, with no setting of its own: "Keep awake while working" is now on by default.

### Fixed
- A turn that had finished no longer stays "settling" (it happened after a refused todo call).
- The agent no longer spends a round trip reading its playbook on its own, so replies start a little sooner.
- After a relaunch, a session's children no longer close while their parent is still being continued.
- A paired computer's subagents send 3 to 7 times less data, and a burst of data no longer leaves a session stuck "running".
- A phone reload no longer shows "This tab is no longer available", and a phone's first install no longer reloads the page after pairing.
- A tooltip no longer takes the clicks of the control under it.
- Measuring disk usage is much faster (Mac 18 s → 0.4 s, Windows 30 s → 0.4 s).
- An update check no longer stays "checking" when the network stalls.

### Fixed (Windows)
- Disk care can delete worktrees that contain Electron again (the app was holding their files open).
- Closing or deleting a session waits until its omp has exited before cleaning up its folder, and a closed session's omp no longer lingers when Windows is busy.

## [0.47.0] - 2026-10-21

다른 컴퓨터에서 돌리는 세션이 끊김 없이 실시간으로 이어지고, 작업현황이 늘 최신 상태를 보여줘요.

### 바뀐 것
- 작업 중 표시가 테두리를 도는 빛에서, 세션 제목 위로 빛이 스치는 모습으로 바뀌었어요. 입력창은 배경에 은은한 빛이 지나가고, 답을 기다릴 때는 움직이지 않는 경고색으로 보여요.
- 세션 찾기나 /resume에서 다른 폴더의 세션을 고르면 그 폴더의 새 탭으로 열려요. 예전에는 아무 일도 일어나지 않았어요.

### 고친 것 (다른 컴퓨터)
- 맥을 끄거나 업데이트해도 다른 컴퓨터에서 돌던 작업이 멈추지 않고 끝까지 돌아요. 다시 켜면 그 작업에 그대로 붙어요.
- 다른 컴퓨터에서 세션을 지우면, 이 컴퓨터가 그 세션을 열어 두고 있어도 지워지고 목록에서도 바로 사라져요.
- 연결이 잠깐 끊겼다 붙어도 작업 중 상태와 경과 시간이 그대로 이어져요. 절전에서 깨어나면 바로 다시 연결되고, 상대 컴퓨터 앱이 다시 켜지면 0.2초 만에 붙어요(예전 11초).
- "연결이 끊겼어요" 알림은 2.5초 넘게 끊겼을 때만 떠요.
- 다른 컴퓨터에서 긴 답이 나올 때 오가는 데이터를 19~65분의 1로 줄였어요.
- 폴더 없이 다른 컴퓨터에 연 세션이 그 컴퓨터에서도 같은 채팅 목록에 보여요.

### 고친 것 (작업현황과 세션)
- 하위 세션의 현재 단계, 경과 시간, 비용이 2초 안에 바뀌어요. 다른 하위 세션에게 한 질문이 "답 기다림"으로 잘못 뜨지 않아요. 목표 예산, "main에 아직 없음", 사이드바의 시간도 작업 중에 바뀌어요.
- 닫았던 세션을 다시 열면 원래 폴더에서 열려요. 폴더가 지워졌으면 다른 폴더로 옮기지 않고 알려 주고, 디스크 정리가 저장해 둔 폴더면 복원 버튼이 떠요.
- "새 창에서 열기"가 빈 세션으로 열리던 문제를 고쳤어요.
- 자동 재시도가 진행 중인데 "응답 실패" 카드가 떠 있던 문제를 고쳤어요.
- 에이전트의 세션 도구가 연결이 잠깐 끊기거나 앱을 다시 켠 뒤에도 같은 세션을 찾고, 바쁜 세션도 시간 초과 없이 닫아요.

### 고친 것 (Windows)
- 세션 시작이 빨라졌어요(처음 켤 때 9.6초 → 1.3초).
- 업데이트를 설치할 때 앱이 몇 초 멈추던 문제, Windows를 끄거나 로그아웃할 때 omp가 다시 켜지고 하던 작업이 사라지던 문제를 고쳤어요.
- 디스크 정리가 줄바꿈 변환 규칙이 있는 저장소의 작업 폴더는 지우지 않아요.

<!-- en -->

Sessions on a paired computer keep up in real time without dropping out, and the work board always shows what is happening now.

### Changed
- The working cue is a light sweeping over the session's title instead of a light running around its border; the composer shows a soft sweep in its background, and a session waiting for an answer shows a still warning colour.
- Picking a session of another folder in the session picker or /resume opens it in a new tab in its folder. It used to do nothing.

### Fixed (paired computers)
- Quitting or updating this Mac no longer stops the work it was running on a paired computer; after relaunching, this Mac picks that work up again.
- Deleting a session on a paired computer deletes it even while this computer has it open, and it leaves the lists at once.
- A short link drop keeps a session's running state and clock. Waking from sleep reconnects at once, and a paired computer's restarted app is back in 0.2 s (was 11 s).
- "Disconnected" shows only after the link stayed down for 2.5 s.
- A long reply streamed from a paired computer sends 19 to 65 times less data.
- A no-folder session opened on a paired computer shows in the same Chat list on that computer too.

### Fixed (work board and sessions)
- A child session's step, clock and cost update within 2 s, and a question it asked another child no longer reads as waiting for you. The goal budget, "not in main yet" and the sidebar's ages also move during a turn.
- A reopened session opens in its own folder. When that folder is gone it says so instead of moving the session elsewhere, and offers Restore when disk care saved the folder.
- "Open in new window" no longer opens an empty session.
- No failure card while an automatic retry is still running.
- The agents' session tools find the same session across a short link drop or a relaunch, and close a busy session without a timeout.

### Fixed (Windows)
- Sessions start faster (first start 9.6 s → 1.3 s).
- Installing an update no longer freezes the app for seconds, and shutting down or signing out no longer restarts omp or loses the running work.
- Disk care keeps the worktrees of repositories with line-ending or filter rules.

## [0.46.0] - 2026-10-20

원격 연결이 돌아와도 대화가 비지 않고 바로 이어지며, 디스크와 메모리를 앱이 알아서 정리해요.

### 새로 생긴 것
- 디스크 자동 정리: 3일 넘게 안 쓴 작업 폴더의 다시 만들 수 있는 빌드 결과물을 지우고, 반영된 작업 폴더는 git이 무시하는 파일을 비공개 보관함에 먼저 저장한 뒤 지워요. 14일 넘게 안 쓴 미반영 작업은 브랜치에 저장하고 복원할 수 있어요. 설정 › 업데이트 및 정보에 "디스크" 줄과 정리 버튼이 있어요.
- 메모리 자동 정리: 업데이트 뒤 한 번과 매일, 낡거나 겹치는 기억을 정리하고 사라진 파일을 가리키는 기억을 표시해요. 예전 대화의 결론도 채워요. 바뀐 내용은 설정 › 메모리에 한 줄로 남고 되돌릴 수 있어요.

### 고친 것
- 다른 컴퓨터 세션의 연결이 돌아오면 화면을 지우고 대화를 처음부터 다시 받던 문제를 고쳤어요. 이제 놓친 부분만 이어 붙이고, 읽던 위치도 그대로예요.
- 잘 동작하는 세션에 "omp를 사용할 수 없어요"가 잘못 뜨던 문제를 고쳤어요. 확인이 한 번 늦은 것만으로는 띄우지 않고, 다시 반응하면 저절로 사라져요.
- 하위 세션(다른 컴퓨터 포함)에 질문 카드가 뜨면 이를 연 세션에 바로 알려요.
- 앱을 다시 켜도 하위 세션의 이름과 번호가 유지되고, 바쁜 하위 세션에 보낸 메시지가 늦게 도착하지 않아요.
- 휴대폰에서 입력하던 글이 가끔 지워지던 문제와, 앱을 연 직후 메뉴(☰)가 안 열리던 문제를 고쳤어요.
- 휴대폰·태블릿에서 옆 버튼의 터치를 가로채거나 노치·홈바에 가리던 곳을 크게 줄였어요(문제 점수 −69%).
- 작업 중 테두리 빛이 순간이동하거나 옆면을 건너뛰지 않고, 둥근 테두리를 같은 속도로 돌아요.
- 작업현황의 "바뀐 파일"이 다른 세션의 커밋까지 세던 문제를 고쳤어요. 사용량 칩은 "5H 64%"처럼 띄워 보여요.
- 다른 컴퓨터 세션을 다시 시작하면 원래 대화가 아니라 빈 세션으로 켜지던 문제를 고쳤어요.

### 바뀐 것
- 입력창 + 메뉴에서 "입력창 크게 펼치기"와 "목표 정하기"를 뺐어요(⌃G와 모드 버튼은 그대로). 휴대폰의 "사진"과 "파일 첨부"는 "첨부파일" 하나로 합쳤어요.

<!-- en -->

A paired computer's session continues at once when its link comes back, and the app tidies its disk and memory by itself.

### New
- Disk care: build output that can be made again is removed from worktrees idle 3+ days; a landed worktree's ignored files go to a private archive before it is removed; unlanded work idle 14+ days is saved to a branch and can be restored. Settings › Updates & about has a Disk row with Clean up.
- Memory care: after each update and daily, memory retires stale or repeated notes, flags notes naming files that are gone, and fills in conclusions from older conversations. Each change is one undoable line in Settings › Memory.

### Fixed
- A paired computer's tab no longer goes blank and reloads its whole transcript when the link comes back; it merges what it missed and keeps the reader's place.
- "omp isn't responding" no longer shows on a working session after one slow check, and it clears itself when omp answers again.
- A child session's question card (on a paired computer too) now tells the session that opened it.
- Child sessions keep their names and ids across a relaunch, and a message to a busy child no longer arrives late.
- Text typed on a phone was sometimes wiped, and the ☰ menu sometimes did not open right after loading.
- Far fewer touch targets on phones and tablets steal a neighbour's tap or sit under the notch or home bar (−69% audit score).
- The working light runs the rounded border at an even pace instead of jumping or skipping the sides.
- Work board "Changed" no longer counts other sessions' commits; usage chips read "5H 64%".
- Restarting a paired computer's tab reopens its own conversation instead of an empty session.

### Changed
- The composer's + menu no longer has Expand composer or Set a goal (⌃G and the Mode button remain). On phones, Photos and Attach files are one Attach item.

## [0.45.0] - 2026-10-20

일부 Windows 노트북에서 창이 켜졌다 꺼졌다 반복하던 문제를 고쳤어요.

### 고친 것
- 그래픽 처리가 불안정한 Windows PC(드라이버가 기본이거나 오래된 내장 GPU 노트북 등)에서 앱이 저절로 다시 켜지기를 끝없이 반복하던 문제를 고쳤어요. 그래픽 가속을 끈 상태에서는 다시 켜지 않고, 자동 재시작은 10분에 한 번까지만 해요. 연속으로 금방 꺼지면 다음에는 안전 모드로 켜요. 드라이버가 바뀌거나 7일이 지나면 그래픽 가속을 한 번 다시 써 봐요.
- 메모리가 지금 대화의 이전 답이나 이미 알려 준 기억을 매번 다시 붙이던 문제를 고쳤어요. 고쳐진 기억과 새 결론은 다시 붙여요.
- 휴대폰·아이패드에서 병렬 세션이 세션 목록에 안 보이고 위 세션의 작업중 불빛이 안 켜지던 문제를 고쳤어요.
- 하위 세션 보고가 다음 메시지를 보낼 때까지 안 보이다가 몰아서 나오던 문제, 앱을 다시 켜면 끝난 하위 세션이 목록에 남던 문제를 고쳤어요.
- 할 일 목록이 대화 언어가 아니라 영어로 써지던 문제를 고쳤어요.
- 통계가 10월 15일 이후 갱신되지 않던 문제와, omp 로그 파일을 수천 개씩 열어 두던 문제를 고쳤어요.
- 오토파일럿이 일시적인 git 오류로 멈추던 문제를 고쳤고, 창이 없어도 사용량 한도 뒤에 다시 시작하며, 시작한 기기와 휴대폰에도 알림이 가요.

### 바뀐 것
- 입력창의 보내기와 정지가 버튼 하나로 합쳐졌어요. 입력 중에 멈추려면 길게 누르거나(휴대폰) 우클릭(데스크톱)해요. 모델 이름은 "Sonnet 5.5 · 자동"처럼 짧게, 컨텍스트는 작은 원으로 보여요.
- 작업현황이 모든 화면에서 한 줄씩 컴팩트하게 바뀌었어요. 바뀐 파일, 마지막 검사, 개발 서버, 같은 폴더 세션, 이번 턴에 쓴 기억이 더해졌고, 아이패드 가로 화면에서도 오른쪽에 붙어요.
- 하위 세션 보고는 한 줄로 접혀 보이고, 질문만 펼쳐져요.
- 같은 폴더에서 일하는 다른 세션의 이름은 작업현황에서 바로 열 수 있어요.
- 설정에서 자동으로 정할 수 있는 항목을 없애거나 고급으로 접었어요(알림 묶기, 예약 재시도, 오토파일럿 내보내기·알림 등).
- 내장 스킬(ECC)이 프로젝트 언어에 맞는 스킬을 짚어 줘서, 모델이 실제로 찾아 읽어요.

<!-- en -->

Fixes a window that kept opening and closing on some Windows laptops.

### Fixed
- On Windows PCs with unstable graphics (a basic or old integrated-GPU driver, for example), the app relaunched itself over and over. A launch without hardware acceleration no longer relaunches, an automatic relaunch happens at most once in 10 minutes, and launches that keep ending quickly start the next one in safe mode. Hardware acceleration is tried again after a driver change or 7 days.
- Memory kept attaching this conversation's own earlier answers, and notes it had already given, on every turn. An edited note or a newer conclusion still comes back.
- On a phone or iPad, parallel sessions were missing from the session list and the parent's working light stayed off.
- Child session reports waited for your next message and then arrived all at once, and finished child sessions stayed listed after a relaunch.
- Todo lists came out in English instead of the conversation language.
- Stats stopped updating after 15 October, and the app held thousands of omp log files open.
- Autopilot no longer stops on a passing git error, resumes after a usage limit with no window open, and notifies the device that started it and phones.

### Changed
- Send and Stop are one button in the composer. To stop while typing, long-press it (phone) or right-click it (desktop). The model chip is shorter ("Sonnet 5.5 · Auto") and context is a small ring.
- The work board is compact on every screen, one line per row, adds changed files, the last check, dev servers, sessions in the same folder and the memory used this turn, and docks on the right on a sideways iPad too.
- Child session reports fold to one line; only questions stay open.
- Sessions working in the same folder open straight from the work board.
- Settings drops or folds under Advanced what can be decided automatically (notification batching, scheduled retry, Autopilot's shipping and notification rows, and more).
- The built-in ECC skills name the skills that fit the project's languages, so the model actually reads them.

## [0.44.0] - 2026-10-20

ECC 스킬이 내장되고, 데스크톱 세션 줄이 ⋯ 메뉴 하나로 정리됐어요.

### 새로 생긴 것
- ECC(Everything Claude Code)의 omp용 스킬 묶음을 내장했어요. 언어·프레임워크별 지식이 스킬 118개, 명령 24개로 들어 있고, 모델에게는 목차 하나만 보여서 세션마다 늘어나는 토큰은 60개 남짓이에요. pstack과 겹치는 14개는 뺐고, 설정 › 에이전트 동작에서 끌 수 있어요.
- 작업현황에 OpenRouter처럼 쓴 만큼 내는 계정의 실제 청구액이 이 세션과 오늘 기준으로 보여요. 구독 계정의 추정 금액과는 따로 표시해요.

### 바뀐 것
- 사이드바 세션 줄에 금액을 표시하지 않아요.
- 데스크톱에서도 세션 줄의 이름 바꾸기·삭제 버튼이 ⋯ 메뉴 하나로 합쳐져서 제목이 더 넓게 보여요.

### 고친 것
- 맥에서 메모리 서버가 업데이트마다 새 경로에 설치되던 것을 한 경로로 고정했어요. 맥이 권한을 프로그램 경로로 기억하기 때문이에요. 이 버전으로 넘어갈 때 경로가 한 번 바뀌어요.
- omp가 프로젝트 위치를 알려 줘서, 메모리 서버가 데스크톱 같은 보호 폴더를 직접 열어 보는 일이 줄었어요.

<!-- en -->

ECC skills are built in, and a desktop session row's actions are one ⋯ menu.

### Added
- ECC (Everything Claude Code)'s omp skill pack is built in: 118 language and framework skills and 24 commands. The model sees only one index, so each session costs about 60 more tokens. The 14 that overlap pstack are left out, and Settings › Agent behavior turns it off.
- The work board shows the real charge of pay-per-use accounts such as OpenRouter, for this session and today, apart from the subscription accounts' estimates.

### Changed
- The sidebar's session rows show no money.
- On the desktop too, a session row's rename and delete buttons are one ⋯ menu, so the title shows wider.

### Fixed
- On the Mac, the memory server now stays at one path across updates instead of a new one each time; macOS remembers permissions by a program's path. The path changes once with this version.
- omp now tells the memory server where the project is, so the server opens protected folders such as Desktop itself less often.

## [0.43.0] - 2026-10-20

같은 폴더에서 동시에 일하는 세션끼리 서로 알고 조율해서, 남의 작업을 커밋하거나 지우지 않아요.

### 새로 생긴 것
- 같은 작업 폴더나 같은 저장소에서 다른 세션이 일하고 있으면 에이전트가 그걸 알고, 그 세션과 메시지로 조율해요. 다른 세션이 있을 때만 전부 커밋, 경로 없는 커밋, 되돌리기, 초기화, 임시 보관, 브랜치 삭제, 남의 파일 덮어쓰기를 막고, 누구 때문인지와 물어볼 방법을 알려 줘요.
- 세션 결론도 페어링한 컴퓨터끼리 나눠서, 다른 컴퓨터에서도 이전에 한 일을 떠올려요.
- 승인 방식에 "묻고 기억하기"가 생겼고, 그 승인 카드의 기억 선택지를 그대로 보여 줘요. 에이전트와 오토파일럿은 항상 이번만 허용해요.
- 끝나서 main에 들어간 작업 폴더를 앱이 알아서 정리해요(앱을 켤 때와 6시간마다, 브랜치는 남겨요).

### 고친 것
- 휴대폰·아이패드에서 병렬 세션이 세션 목록에 안 보이고, 위 세션의 작업중 불빛이 안 켜지던 문제를 고쳤어요.
- 화면에 쓰지 않는 작업 위젯 때문에 모델 요청이 나가던 것을 막았어요.
- 메모리가 관계없는 질문에 결론을 붙이는 일을 줄였어요.
- omp 18.12.3의 새 설정에 한국어를 붙였어요. 필요한 omp 최소 버전은 18.12.3이에요.
- 메모리 상태 확인이 겹쳐서 복구를 건너뛰던 문제를 고쳤어요.

<!-- en -->

Sessions working in the same folder at the same time know about each other and coordinate, so none commits or wipes another's work.

### Added
- When another session works in the same worktree or repository, the agent knows it and coordinates with it by message. Only while another session is there, it refuses commit -a, commits without paths, reverts, resets, stash, branch deletes and overwriting another session's file, and says whose work it is and how to ask.
- Session conclusions are shared between paired computers, so the other computer recalls earlier work too.
- A new tool approval mode, Ask and remember, with the approval card's remember choices shown as they are. Agents and Autopilot always approve once.
- Agent worktrees whose work has landed are cleaned up automatically, at launch and every six hours; branches are kept.

### Fixed
- Parallel sessions missing from the session list on a phone or iPad, and the parent's working light staying off.
- Model requests for job widgets the app never shows.
- Memory attaching conclusions to unrelated prompts less often.
- Korean text for omp 18.12.3's new settings. omp 18.12.3 is now the minimum.
- Overlapping memory health checks that skipped a repair.

## [0.42.0] - 2026-10-20

모델 역할을 몇 초 만에 자동으로 구성하고, 원격 컴퓨터 세션도 이 컴퓨터 세션과 똑같이 다룰 수 있어요.

### 새로 생긴 것
- 모델 구성 도우미가 두 가지 방식이 됐어요. "완전 자동 구성"은 아무것도 고르지 않아도 연결된 구독 계정의 모델로 모든 역할을 0.5초 안에 채워요. "모델 선택 + 자동"은 고른 모델 안에서만 배정해요. 모델 호출이 없어서 비용이 들지 않아요. 적용과 되돌리기는 한 번에 되고, 직접 지정한 역할은 그대로 둬요. 완전 자동은 OpenRouter 같은 종량제 모델을 쓰지 않아요(판단 모델만 예외).
- omp에 새 역할이 생기면 모델 역할 화면에 바로 나타나요. 사용자 지정 역할은 없어지고, OMPdesk가 다른 계열 모델로 검토하는 "리뷰" 역할을 더해요(설정 파일은 바꾸지 않아요).
- 에이전트 도구가 원격 컴퓨터의 세션에서도 똑같이 동작해요. 세션 열기·닫기·삭제·다시 열기, 작업 폴더 만들기·비교·합치기, 예약 실행, 오토파일럿, 앱 조작 모두요. 원격 컴퓨터에 연 세션은 연 세션 아래 자식으로 보여요.
- 하위 작업 비교가 바뀐 내용·검사 결과·합칠 때 충돌 예측까지 증거로 판정하고, 충돌이 예상되면 합치지 않아요.
- 작업 묶음의 비용과 하위 작업별 모델이 보이고, 작업 트리 화면에서 주인 없이 남은 작업 폴더를 정리할 수 있어요. 조언자 비용도 보여요.
- 메모리가 세션마다 결론을 남기고, 입력한 질문과 관련된 이전 결정을 찾아 조용한 한 줄로 알려 줘요. 한국어 조사를 떼고 찾고, 판단 모델이 엉뚱한 기억을 걸러요. 취향과 교정도 기억하고, 결정·취향은 페어링한 컴퓨터끼리 나눠요.
- 세션 ⋯ 메뉴와 설정 › 업데이트 및 정보에서 "진단 묶음 저장"으로 세션 기록과 진단 정보를 개인 정보를 가린 압축 파일로 저장해요.
- 백그라운드 작업이 하위 에이전트 아래 트리로 묶여 보여요.
- 에이전트가 오래 걸리는 테스트와 빌드를 백그라운드로 돌리고 그동안 다른 일을 해요.
- 사이드바의 이 기기·원격 컴퓨터 묶음 순서를 드래그로 바꾸면 기억해요.
- 입력창의 컨텍스트 사용량이 작은 원으로 보여요.

### 바뀐 것
- 처음 실행이 짧아졌어요. 계정을 연결하면 브라우저가 알아서 열리고, 기본 모델이 자동으로 정해져서 클릭 한 번이면 대화를 시작해요. GitHub 연결 단계는 설정으로 옮겼어요.
- 사이드바 위쪽이 한 줄이에요: 세션 찾기와 폴더 추가, 채팅 찾기와 새 채팅. 새 세션 버튼과 최근순 보기는 없어졌어요.
- 하위 세션 보고는 한 줄로 접혀 보이고, 질문만 펼쳐져요.
- 실행 설정의 고급은 항상 닫힌 채로 시작하고, 입력창의 사고 수준·위임 아이콘은 없어졌어요.
- 라이선스가 MIT에서 Apache License 2.0으로 바뀌었어요(NOTICE 파일 추가). v0.41.0까지의 버전은 MIT 그대로예요.

### 고친 것
- Windows에서 창이 뜨지 않던 문제를 고쳤어요.
- Windows 사이드바에 다른 컴퓨터가 열어 준 세션이 보이지 않던 문제와, 짧은 경로 이름 때문에 작업 폴더가 어긋나던 문제를 고쳤어요.
- 업데이트 뒤 메모리 서버가 꺼진 채 돌아오지 않던 문제와, 켜져 있어도 응답하지 않던 문제를 고쳤어요.
- 하위 세션 보고가 다음 메시지를 보낼 때까지 안 보이다가 몰아서 나오던 문제를 고쳤어요.
- 휴대폰에서 하위 작업이 도는 세션의 작업현황이 안 뜨던 문제, 꺼진 앱에서 알림을 눌러도 탭이 안 열리던 문제, 세게 스크롤하면 끝에서 튀던 문제, 가로 화면의 작은 버튼을 고쳤어요.
- 진단 묶음의 일반 모드에도 비밀값이 남지 않게 했어요.
- 좁은 창에서 전송 버튼이 화면 밖으로 밀리던 문제를 고쳤어요.
- 재시작 직후 다음 모델 요청 전에 끊긴 턴도 이어서 해요.

<!-- en -->

Model roles configure themselves in seconds, and a paired computer's sessions work exactly like this computer's.

### Added
- The model setup assistant has two modes. Full auto fills every role from your connected subscription models in under half a second without asking you to pick anything; Pick models + auto assigns only among the models you chose. It makes no model call, so it costs nothing. Apply and undo are one click each, and roles you set by hand stay. Full auto never uses metered models such as OpenRouter's (judge models excepted).
- A role omp adds shows up in Model roles right away. Custom roles are gone; OMPdesk adds a Review role that checks with another model family (your config file is not touched).
- Agent tools work on a paired computer's sessions just as here: open, close, delete and reopen sessions, make, compare and merge worktrees, schedules, Autopilot and app actions. A session opened on a paired computer shows as its opener's child.
- Comparing child work now judges from evidence: the diff, check output and a merge conflict prediction. A predicted conflict blocks the merge.
- A work family shows its cost and each child's model, and the Work tree view cleans up worktrees nothing uses any more. The advisor's cost is shown too.
- Memory records each session's conclusion and recalls earlier decisions related to what you type, shown as one quiet line. Korean search ignores particles, and the judge model filters out unrelated memories. It also learns your preferences and corrections, and decisions and preferences are shared between paired computers.
- "Save diagnostic bundle" in a session's ⋯ menu and in Settings › Updates & about saves the session's records and diagnostics as one zip with private data redacted.
- Background jobs are shown as a tree under the subagent that started them.
- Agents run long tests and builds in the background and keep working meanwhile.
- Drag the This device and paired computer sections in the sidebar to reorder them; the order is remembered.
- Context usage in the composer is a small ring.

### Changed
- First run is shorter: connecting an account opens the browser by itself and picks the default model, so one click gets you to your first message. Connecting GitHub moved to Settings.
- The sidebar header is one line: Find sessions and Add folder, or Find chats and New chat. The New session button and the recent view are gone.
- Child session reports fold to one line; only questions stay open.
- Run settings' Advanced always starts closed, and the thinking and delegation icons beside the composer are gone.
- OMPdesk is now licensed under the Apache License 2.0, with a NOTICE file; versions up to v0.41.0 stay MIT.

### Fixed
- A window that never appeared on Windows.
- Sessions another computer opened missing from the Windows sidebar, and worktrees going astray under short Windows path names.
- The memory server staying off after an update, and not answering while it ran.
- Child session reports held back until your next message, then arriving all at once.
- On the phone: the work strip missing for a session whose children were working, a notification tap not opening its tab from a closed app, a jump at the end of a fling, and small buttons in landscape.
- Secrets left in a diagnostic bundle's normal mode.
- The Send button pushed off-screen in a narrow window.
- A turn cut off right before its next model request now continues after a relaunch.

## [0.41.0] - 2026-10-19

컴퓨터끼리 공유가 Tailscale 계정만으로 페어링 코드 없이 이어지고, 컴퓨터를 다시 켜도 끊기지 않아요.

### 새로 생긴 것
- 컴퓨터 공유가 Tailscale 전용이 됐어요. 설정 › 기기 및 연결에 같은 Tailscale 계정의 컴퓨터가 보이고, "연결"만 누르면 돼요. 페어링 코드와 주소 입력은 없어요. 공유하는 컴퓨터는 Tailscale 주소에서만 연결을 받고, 허용 계정과 차단은 휴대폰 웹과 함께 관리해요.
- 이미 코드로 연결해 둔 컴퓨터는 업데이트 때 Tailscale 기기로 자동으로 옮겨져서 다시 연결할 필요가 없어요.
- 메모리를 OMPdesk 안에서 직접 빌드해요. 외부 배포판을 받아 오지 않아요.
- 설정 › 모델 역할의 판단 모델 줄이 더 빠르고 저렴한 판단 모델(Jev)을 못 쓸 때 이유와 연결할 곳을 알려 줘요.

### 고친 것
- 컴퓨터를 다시 켜면 공유 연결이 다시 이어지지 않던 것을 고쳤어요. 기억해 둔 임시 포트 대신 매번 컴퓨터의 현재 Tailscale 주소로 찾아가요.
- 휴대폰 웹에서 원격 컴퓨터의 세션이 끝없이 로딩되던 것을 고쳤어요. 60초 안에 열리지 않으면 이유와 "다시 시작"이 보이고, 대화를 불러오지 못하면 "다시 시도"가 보여요.
- omp가 "이 세션 동안 허용"을 함께 묻는 도구 승인을 승인 카드로 알아보지 못해서, 알림과 오토파일럿 자동 승인에서 빠지던 것을 고쳤어요. 승인 카드에 "이 세션 동안 허용"이 생겼어요.
- OMPdesk가 일부 omp 설정을 실행 중인 omp가 아닌 다른 복사본에서 읽어 잘못된 값을 쓰던 것을 고쳤어요(목표 모드 켜기 등).
- 대화 자동 압축이 1시간짜리 캐시가 만료되기 직전에 일어나도록 omp에 맞췄어요.
- 자동 모드의 계획 판단이 한국어 요청을 더 잘 알아봐요.
- 휴대폰 아래쪽 창에 스크롤바가 두 개 보이던 것을 고쳤어요.
- 휴대폰에서 원격 컴퓨터 세션 줄의 닫기·삭제 버튼이 그대로 드러나던 것을 ⋯ 메뉴 하나로 정리했어요.
- 작업판의 열린 세션 중 답을 기다리는 줄만 강조돼요. 목록 전체가 경고 색이 되지 않아요.
- 보안 검사 화면이 재시작 직후 중단된 검사를 "실행 중"으로 보여 주던 것을 고쳤어요.

<!-- en -->

Sharing between computers now runs on your Tailscale account alone, with no pairing code, and survives a restart.

### Added
- Computer sharing is Tailscale-only: Settings › Devices & connections lists the computers on your Tailscale account, and Connect is all it takes. No pairing code, no address field. A sharing computer accepts connections only on its Tailscale address, and allowed accounts and blocks are shared with mobile web.
- Computers already paired by code move over to their Tailscale node on update, with no reconnect needed.
- Memory is built by OMPdesk itself; no upstream release download.
- Settings › Model roles' judge row says when the faster, cheaper judge model (Jev) is skipped and where to connect it.

### Fixed
- A shared computer reconnects after a restart: the client always dials the computer's current Tailscale address instead of a remembered temporary port.
- A remote computer's session on the phone no longer loads forever: after 60 s it names the computer with Restart, and a failed transcript read offers Retry.
- Tool approvals that also offer "Approve for this session" are recognised as approvals again (notifications, Autopilot's approver), and the card offers that choice.
- Some omp settings were read from a second copy of omp's modules instead of the running omp (goal mode and others); they now read the real values.
- Idle compaction now happens just before a 1-hour prompt cache expires, matching omp.
- Auto mode recognises Korean planning requests better.
- Bottom sheets on a phone show one scrollbar, not two.
- On touch, a remote computer's session row keeps Close and Delete behind one ⋯.
- On the work board, only the opened session that waits on you is tinted, not the whole list.
- The security dashboard no longer shows an interrupted scan as running right after a restart.

## [0.40.0] - 2026-10-19

화면 전체의 군더더기 설명을 걷어 내고, 에이전트가 OMPdesk를 확인 카드 없이 다룰 수 있게 했어요. 원격 세션은 이제 어느 쪽에서 열어도 하나로 이어져요.

### 새로 생긴 것
- 에이전트에게 OMPdesk 모든 권한을 주는 스위치를 넣었어요(기본 켜짐). 켜져 있으면 삭제, 설치, 종료, 설정 변경까지 확인 카드 없이 하고, 한 일은 알림과 되돌리기로 보여요. 계정 비밀번호와 토큰은 계속 읽을 수 없어요.
- 시작하기와 모델 설정에서 ChatGPT, Claude, OpenRouter, Google, Grok을 맨 위 카드로 보여 줘요. 구독 로그인이 먼저, API 키가 다음이에요.
- 오토파일럿이 시작 버튼 하나로 돌아가요. 저장소를 보고 내보내기 방식을 정하고(원격이 있으면 작업 브랜치 푸시, main에는 직접 푸시하지 않음), 병렬 수와 예산·시간 상한은 없어요. 알려진 버그를 먼저 고치고, 세션 제목은 작업 내용으로 붙어요.
- 연결된 컴퓨터와 기기의 이름을 언제든 바꿀 수 있어요. 다른 컴퓨터의 이름도 원격으로 바꾸고, 바뀐 이름은 연결된 기기에 바로 보여요.
- 호스트 컴퓨터 화면에서 다른 기기가 연 세션이 보이고, 열면 그 세션에 같이 보기로 붙어요.
- 작업 중인 세션 카드에 입력창과 같은 빛이 테두리를 돌아요. 하위 작업 줄은 차분하게 두고, 숫자는 한 번만 보여요.
- 윈도우에서 Git Bash가 하위 프로그램을 띄우지 못하면 설정의 Git 항목에 원인과 "고치기" 버튼이 나와요. Git 프로그램에만 예외를 걸고, "되돌리기"는 바꾼 설정 하나만 원래대로 돌려요.
- 메모리가 세션을 작업 이름으로 기록하고, 사람이 쓴 대화에서 규칙과 결정을 스스로 정리해요(설정 › 메모리 › 대화에서 배우기).
- 앱 자동 업데이트와 앱 멈춤, 입력 기록 시간 초과의 원인을 기록에 남겨요.

### 바뀐 것
- 설정, 대화상자, 패널, 사이드바, 대화 화면의 설명을 정리했어요. 줄마다 한 줄이고, 필요한 설명은 ⓘ 툴팁에 있어요. 설정 페이지 맨 위 소개 문장도 없앴어요.
- 휴대폰의 실행 설정이 한 줄씩이고, 스위치는 두 칸 타일, 사고 수준·승인·위임은 버튼 한 줄이에요. 입력창 줄은 아이콘 위주라 보내기 버튼 밑으로 파고들지 않아요.
- 에이전트가 연 세션은 끝나면 사이드바에 남지 않고, 작업판의 "검토가 필요해요"와 검토·승인·버리기 버튼도 없어졌어요. 결과는 메인 세션이 직접 확인하고 합쳐요.
- 에이전트 도구의 횟수와 개수 제한을 모두 없앴어요.
- 입력창 아래 "다른 기기와 함께 쓰는 중" 줄과 사이드바 숫자의 깜빡임, 사용 중인 계정 옆 세로선을 없앴어요.

### 고친 것
- 윈도우에서 앱이 한 번 정상 종료되면 그다음부터 그래픽 가속이 꺼진 채로 실행되던 것을 고쳤어요.
- 원격 컴퓨터에서 이미 열려 있는 세션을 다른 기기가 열면 omp가 하나 더 떠서 대화가 갈라지던 것을 고쳤어요.
- 계획 승인 카드가 답한 뒤에도 남던 것을 고쳤어요. 어느 창, 기기, 에이전트가 답해도 모든 창에서 닫혀요.
- 이미 진행 중인 일에 "좋아 진행해" 같은 추천 문장이 나오던 것을 고쳤어요.
- 작업 중이거나 바꾼 게 없는 세션이 "검토가 필요해요"에 뜨던 것을 고쳤어요.

<!-- en -->

Filler text is gone from every screen, and agents can operate OMPdesk without confirmation cards. A remote session now stays one session whichever side opens it.

### Added
- A "Give agents full control of OMPdesk" switch (on by default): agents delete, install, quit and change settings without a card, and every action shows as a notice with undo where possible. Account secrets and tokens stay unreadable.
- Getting started and model settings lead with ChatGPT, Claude, OpenRouter, Google and Grok as cards, subscription sign-in first and API key second.
- Autopilot starts with one button: it picks the shipping level from the repository (pushes its work branch when there is a remote, never straight to main), with no fan-out cap and no budget or time ceilings. It fixes known bugs first and titles its session after the work.
- Rename a computer or device any time, including another computer remotely; the new name reaches connected devices at once.
- A host's own windows list the sessions paired devices run on it and open them as a viewer.
- A working session's card wears the composer's travelling light; child rows stay plain and the count shows once.
- On Windows, when Git Bash cannot start child processes, the Git item in setup explains why and offers Fix, which exempts only Git's programs, and Undo, which restores only that one setting.
- Memory names sessions after their task and learns rules and decisions from your own messages (Settings › Memory › Learn from conversations).
- The runtime log records app auto-update decisions, the step a main-thread stall happened in, and where a timed-out history load waited.

### Changed
- Settings, dialogs, panels, the sidebar and the transcript lost their filler: one line per row, explanations in ⓘ tooltips, no intro sentence under Settings titles.
- The phone's Run settings are one line per row with two-up switch tiles and segmented thinking, approval and delegation; the composer row is icon-first and nothing slides under Send.
- Sessions an agent opened leave the sidebar once done, and the work board's "Needs review" with Review, Approve and Discard is gone; the main session reviews and lands its children itself.
- The agent control tools have no count or rate limits.
- The "shared with other devices" line under the composer, the breathing sidebar counts and the edge beside the account in use are gone.

### Fixed
- On Windows, one normal shutdown no longer leaves every later launch without hardware acceleration.
- A device opening a session a host window already has open no longer starts a second omp that splits the conversation.
- A plan approval card no longer stays after it was answered; any window, device or agent closes it everywhere.
- No more "ok, go ahead" suggestions for work that is already underway.
- Running sessions and sessions with no changes no longer show under "Needs review".

## [0.39.0] - 2026-10-19

세션이 겹치거나 지운 세션이 되살아나던 문제를 고친 안정판이에요. 앱이 로딩 화면 없이 바로 뜨고, 휴대폰 입력창과 메모리 페이지가 새로 바뀌었어요.

### 새로 생긴 것
- 설정 › 메모리가 한 페이지로 바뀌었어요. 개요, 검색, 페이지(읽기·편집·고정·삭제·되살리기), 인계, 세션, 프로필, 관리를 한곳에서 다뤄요. 사이드 패널에는 요약만 보여요.
- 왼쪽 사이드바가 열고 닫은 상태를 기억해요. 사이드바 표시 여부와 프로젝트·폴더·기기 묶음, 하위 작업 묶음의 접힘이 앱을 다시 켜도 그대로예요.
- 앱이 켜지는 첫 화면부터 실제 화면 모양으로 떠요. 세션 목록, 대화, 탭, 모델, 사용량, 패널이 마지막으로 본 내용으로 바로 보이고 회전하는 로딩 표시가 없어요.
- 입력창을 새로 다듬었어요. 실행 설정을 칩 하나로 모았고, 대기 중인 메시지는 버튼 하나로 보여요. @ 목록이 저장소 전체 파일을 찾고, 붙여넣기·받아쓰기·되돌리기가 더 정확해졌어요. omp가 아직 켜지는 중이어도 입력하고 보낼 수 있어요.
- 휴대폰 입력창은 항상 열려 있고, 모든 버튼이 입력창 상자 안에 있어요. 터치 키보드의 Enter는 줄을 바꾸고 보내기 버튼으로만 보내요.
- 작업 카드가 테스트 결과, 오류 원인, 미리보기를 칩으로 보여 주고, 같은 의도의 단계를 한 줄로 묶어요.
- 에이전트가 연 세션이 하위 에이전트처럼 여는 세션 아래에 접히고, 끝나면 스스로 닫혀요. 세션끼리 보고를 주고받을 수 있고, 다른 창·연결된 기기·저장된 세션도 다룰 수 있어요.
- 에이전트가 세션을 열거나 메시지를 보내는 횟수 제한을 없앴어요.
- 원격 기기의 세션을 사이드바에서 닫거나 삭제할 수 있어요.

### 바뀐 것
- 패널(변경 사항, 미리보기 등)이 저절로 열리지 않아요. 개발 서버 주소가 나오면 "미리보기 열기" 링크가 보여요.
- 제목 표시줄의 보는 사람 표시를 없앴어요.

### 고친 것
- 지운 세션이 재시작이나 다른 기기를 거쳐 다시 나타나던 것을 고쳤어요. 지운 기록이 모든 복원 경로를 막아요. 처음 대화를 이어 하는 기능은 그대로예요.
- 원격 컴퓨터에서 같은 대화가 탭 여러 개로 열리던 것을 고쳤어요. 한 세션 파일에는 omp가 하나만 돌아요.
- 이미 main에 반영된 작업이 "검토가 필요해요"에 파일 수천 줄짜리로 뜨던 것을 고쳤어요.
- 앱을 다시 켜면 직전에 고른 탭 대신 그 전 탭이 열리던 것을 고쳤어요.
- 앱을 다시 켠 뒤 에이전트가 연 세션이 여는 세션과의 관계를 잃던 것을 고쳤어요. 쉬고 있는 세션의 탭을 닫을 때 확인 카드가 뜨지 않아요.
- 휴대폰 웹 화면이 연결이 끊긴 뒤 스스로 새로고침되던 것을 고쳤어요. 저장 안 된 내용이 있으면 업데이트를 미뤄요.
- 좁은 창이나 200 % 확대에서 보내기·중지 버튼이 화면 밖으로 밀리던 것을 고쳤어요.
- 받는 쪽이 닫힌 콘솔에 쓸 때 앱이 오류 창과 함께 꺼지던 것을 고쳤어요.
- Windows에서 작업 폴더 준비, 명령 실행, 테스트가 실패하던 여러 문제를 고쳤어요.

<!-- en -->

A stable release that stops sessions from duplicating and deleted sessions from coming back. The app now opens without loading screens, and the phone composer and the Memory page are new.

### Added
- Settings › Memory is one page: overview, search, pages (read, edit, pin, delete, restore), handoffs, sessions, profile and maintenance. The side panel shows a summary.
- The left sidebar remembers what was open or closed: whether it is shown, and the folds of projects, folders, devices and sub-task families survive a relaunch.
- The first frame is the real layout: the session list, transcript, tabs, models, usage and panels paint from what you last saw, with no spinners.
- A reworked composer: one Run chip for run settings, a queue pill, @ finds every file in the repository, and paste, dictation and undo are more precise. You can type and send while omp is still starting.
- The phone composer is always open with every control inside its box. On a touch keyboard Enter adds a line and only Send sends.
- Work cards show test results, the cause of an error and a preview as chips, and group steps of one intent on one row.
- Sessions an agent opened fold under their opener like subagents and close themselves when done. Sessions can report to each other, and agents can work with other windows, paired devices and saved sessions.
- No more limits on how many sessions or messages an agent can open or send.
- Close or delete a remote device's session from the sidebar.

### Changed
- Panels (Changes, Preview and others) no longer open by themselves; a dev-server address shows an "Open Preview" link.
- The viewers chip is gone from the title bar.

### Fixed
- A deleted session no longer comes back through a restart or another device; a deletion record blocks every restore path, and a first conversation still resumes.
- A remote computer no longer opens one conversation in several tabs; one session file runs one omp.
- Work that already landed on main no longer shows under "Needs review" with thousands of lines.
- A relaunch opens the tab you picked last, not the one before it.
- Sessions an agent opened keep their opener after a relaunch, and closing a resting session's tab asks nothing.
- The phone web page no longer reloads itself after a dropped connection, and waits with updates while anything is unsaved.
- Send and Stop no longer slide off screen in a narrow pane or at 200 % zoom.
- A write to a closed console no longer crashes the app with an error dialog.
- Several Windows failures in worktree setup, running commands and tests.

## [0.38.2] - 2026-10-18

Mac에서 메모리(ai-memory)가 켜지지 않던 문제를 고쳤어요.

### 고친 것
- 설치한 Mac에서 서명된 ai-memory 실행 파일이 확인을 통과하지 못해 메모리가 시작되지 않던 것을 고쳤어요. 이제 OMPdesk의 서명 요건을 만족하는 파일만 받아들이고, 복사해 둔 파일은 내용이 같을 때만 믿어요.
- 메모리가 각 단계와 실패를 기록하고, 설정에서 켜지지 않은 이유를 보여줘요.
- Windows에서 새로 설치한 컴퓨터는 설정이 Bun을 준비할 때까지 메모리가 기다렸다가, Bun이 생기면 다시 설정해요. 첫 실행에서 메모리가 알아서 켜져요.
- Windows에서 설정 명령이 실행 중에 컴파일하는 C# 코드 대신 Bun의 FFI로 시작돼서, 더 안정적으로 실행돼요.
- 사이드바에서 하위 에이전트 묶음이 저절로 펼쳐지거나 접히지 않고, 기다리는 하위 에이전트만 보여요. 하위 에이전트 행은 처음 맡긴 작업의 제목을 유지해요.
- 앱을 다시 켜서 하위 에이전트를 되살릴 때, 쉬고 있던 세션에 조용한 한 턴을 주고, 복원이 실패하면 이유를 기록해요.

<!-- en -->

Fixed memory (ai-memory) not starting on Mac.

### Fixed
- On an installed Mac, the signed ai-memory executable failed the verification check, so memory never started. It now accepts only a file that meets OMPdesk's signing requirement, and trusts a staged copy only when its bytes match.
- Memory now logs each phase and failure, and Settings shows why it failed to start.
- On a fresh Windows machine, memory waits until setup has Bun, then wires itself up again once Bun is there, so it turns on by itself on the first launch.
- On Windows, setup commands start through Bun's FFI instead of C# code compiled at run time, so they run more reliably.
- In the sidebar, subagent groups no longer open or fold by themselves; only a waiting child surfaces. Subagent rows keep the original assignment's title.
- When a relaunch revives subagents, an idle session gets one quiet turn, and a failed restore logs why.

## [0.38.1] - 2026-10-18

휴대폰에서 사진이나 파일을 골라도 첨부되지 않던 문제를 고쳤어요.

### 고친 것
- 휴대폰에서 사진이나 파일을 고르는 동안 페이지가 다시 불러와져 선택이 사라지던 것을 고쳤어요. 이제 선택 창이 열려 있는 동안에는 다시 불러오기를 기다려요.
- Windows에서 ai-memory 서비스가 켜져 있으면 앱을 끄거나 업데이트할 때 멈추던 것을 고쳤어요.

### 바뀐 것
- 휴대폰의 + 메뉴에 "사진"(갤러리/카메라)과 "파일 첨부"가 생겼어요.
- 이미지가 아닌 파일도 올려서 경로로 전달해요. 올리는 동안 진행 칩이 보이고, 실패하면 이유를 알려줘요.
- 작업 막대가 시트나 가림막 없이 그 자리에서 펼쳐져서, 화면의 어떤 부분도 가리지 않아요.

<!-- en -->

Picking a photo or file on a phone no longer fails to attach.

### Fixed
- The page used to reload while a phone's photo or file picker was open, losing the pick. It now waits to reload while a picker is open.
- On Windows, quitting or updating no longer hangs while ai-memory's service is running.

### Changed
- The phone's + menu now offers "Photos" (gallery/camera) and "Attach files".
- Non-image files are uploaded and passed to the agent by path, with a progress chip and a worded error if it fails.
- The work strip expands in place, with no sheet or scrim, so nothing is covered.

## [0.38.0] - 2026-10-18

기억 기능(ai-memory)과 엔지니어링 모드(pstack)를 내장해서, 세션이 이어지고 더 꼼꼼하게 일해요.

### 기억 (ai-memory)
- 기억 기능 ai-memory([akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory), MIT)가 앱에 내장돼 기본으로 켜져요. 따로 설치하지 않아요.
- 같은 폴더의 다음 세션이 이전 세션의 인수인계(handoff)를 이어받아요. 검색은 전문 검색이라 모델 호출이 전혀 없고, 모델이나 임베딩을 내려받지도 않아요.
- 설정 › 메모리에서 켜고 끄고, 저장된 내용을 콘솔에서 보고, 모든 기억을 지울 수 있어요. 옆 패널의 메모리 보기는 최근 페이지와 인수인계를 읽기 전용으로 보여줘요.
- 끄면 OMPdesk만 영향을 받아요. OMPdesk가 띄우는 omp에만 연결되고, 다른 에이전트나 터미널의 omp 설정은 건드리지 않아요. 터미널의 omp에서도 쓰고 싶다면 선택 버튼 "터미널 omp에서도 사용"을 눌러요.
- 탭을 닫을 때 세션이 정상적으로 끝나서 인수인계가 만들어져요.
- omp 기본 메모리 설정(메모리 백엔드와 그 행들, 메모리 모델 역할, `ompdesk_remember`)은 없어졌어요. ai-memory가 대신해요.
- 앱이 약 15 MB 커져요.
- 개인정보: 모든 것이 이 컴퓨터에만 남아요(로컬 서버, 텔레메트리 없음). OMPdesk가 실행하는 omp 세션의 입력한 프롬프트, 도구 호출과 결과, 세션의 시작과 끝을 기록하고, 어시스턴트의 답변은 기록하지 않아요. API 키·토큰·비공개 키·URL 속 비밀번호는 저장 전에 최선을 다해 지우지만 "내 비밀번호는 …" 같은 글은 알아보지 못해요. 프로젝트의 `.ai-memory.toml`로 파일을 기록에서 뺄 수 있어요.

### 엔지니어링 모드 (pstack)
- [pstack](https://github.com/cursor/plugins/tree/main/pstack)(MIT, Lauren Tan)이 내장돼 기본으로 켜져요. 플레이북과 원칙을 담고 있어서, 사소하지 않은 요청이면 에이전트가 맞는 플레이북을 먼저 읽고 단계를 할 일로 옮겨 일해요.
- 세션마다 프롬프트에 약 7k 토큰이 더해져요(프롬프트 캐시됨). 하위 에이전트, 계획 모드, 프로젝트 없는 채팅에는 들어가지 않아요.
- 설정 › 에이전트 동작 › 스마트 자동화의 스위치로 끌 수 있어요.

### 안정성
- Windows에서 탭을 닫을 때 omp와 그 하위 프로세스가 모두 끝나요(`taskkill /T`). Windows 패키징 검사도 바로잡았어요.

<!-- en -->

ai-memory and the pstack engineering mode are built in, so sessions carry on from each other and the agent works more carefully.

### Memory (ai-memory)
- ai-memory ([akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory), MIT) is built into the app and on by default. There is nothing to install.
- The next session in the same folder picks up the previous session's handoff. Search is full-text, so it makes zero model calls and downloads no model or embeddings.
- Turn it on or off, open the console, and delete all memory in Settings › Memory. The side panel's Memory view shows recent pages and handoffs, read-only.
- Turning it off only affects OMPdesk: memory is wired only into the omp that OMPdesk starts, and no other agent's or the terminal omp's setup is touched. An optional "Also use in the terminal omp" button wires the terminal omp too.
- Closing a tab ends the session gracefully, so the handoff is written.
- The stock omp memory settings (the memory backend and its rows, the memory model role, `ompdesk_remember`) are removed; ai-memory replaces them.
- The app is about 15 MB bigger.
- Privacy: everything stays on this computer (a local server, no telemetry). It records the prompts you type, the tool calls with their arguments and results, and each session's start and end for the omp sessions OMPdesk runs; the assistant's replies are not recorded. API keys, tokens, private keys and passwords in URLs are stripped before storage on a best-effort basis, but free text like "my password is …" is not detected. A project's `.ai-memory.toml` can keep files out of capture.

### Engineering mode (pstack)
- [pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT, Lauren Tan) is built in and on by default. It carries playbooks and principles: for anything non-trivial the agent reads the matching playbook first and copies its steps into its todo list.
- It adds about 7k tokens to a session's prompt (prompt-cached). Subagents, Plan mode and a chat without a project don't get it.
- Switch it off in Settings › Agent behavior › Smart automation.

### Stability
- On Windows, closing a tab now ends omp and all its child processes (`taskkill /T`). The Windows packaging check is fixed too.

## [0.37.0] - 2026-10-18

휴대폰과 태블릿에서 훨씬 촘촘하고 빠르게 쓸 수 있게 됐고, 테마가 새로 바뀌었어요.

### 휴대폰·태블릿
- 화면이 데스크톱 밀도로 촘촘해졌어요. 글자와 간격이 줄고, 입력창은 한 줄로 줄어 모델·모드 선택은 ⋯ 뒤로 들어갔어요. 작업 상태는 머리글 아래 띠로 보이고, 눌러야 하는 영역은 눈에 보이는 크기와 상관없이 44px를 지켜요.
- 휴대폰에서 고른 사진은 소켓 대신 `/upload`로 컴퓨터에 전달돼요. 큰 사진도 메시지가 끊기지 않고, HEIC/HEIF는 모델이 읽을 수 있게 변환돼요. 브라우저가 그리지 못하는 사진은 형식과 크기를 적은 칩으로 보여요.
- 터치에서는 프롬프트 제안이 한 줄 칩으로 나와요. 누르면 채워지고, 길게 누르면 바로 보내요.
- 웹 페이지를 앱처럼 설치할 수 있어요(도움말 메뉴, 설정, 두 번째 방문 때 한 번 안내). 화면 회전 잠금도 그대로 지켜져요.
- 테마·글자 크기·레이아웃은 기기마다 따로 저장돼서, 폰에서 바꿔도 컴퓨터가 바뀌지 않아요.
- 컴퓨터의 세션을 보고 있던 휴대폰은 앱이 재시작된 뒤에도 그 세션을 다시 봐요.
- 웹 화면을 더 빨리 열고 다시 이어요. 화면을 놓친 게 없으면 돌아와도 새로 고침하지 않고, 첫 화면의 JavaScript가 줄었고, 사용하는 언어만 불러와요.
- 도움말 메뉴에서 시트를 열고 사이드바를 닫으면 about:blank로 이동하던 것, 탭이 없는 웹 창이 계속 로딩만 보이던 것을 고쳤어요.

### 오토파일럿
- 내보내기 단계를 커밋 / 푸시 / 배포로 고를 수 있고, 커밋하고 푸시할 브랜치와 대상을 직접 골라요. 다른 워크트리가 쓰는 브랜치는 작업 브랜치를 거쳐 푸시해요.
- 시작 시트는 안내, 내보내기, 브랜치, 시작만 보이고 나머지는 고급 아래에 있어요.
- 이제 멈추지 않아요. 빨간 사이클, 거절된 푸시, 실패한 배포, 계획 모드, 조용한 턴은 멈추지 않고 스스로 고쳐요.

### 테마
- 서로 확실히 다른 테마 10개가 생겼어요. 시스템을 고르면 밝은 테마와 어두운 테마를 한 쌍으로 따라가요.

### 사이드바
- 세션이 연 하위 에이전트와 세션이 한 가족으로 묶여 보이고, 시간 표기가 하나로 통일됐어요. 좁은 사이드바에서는 요약 칩이 실행 중 표시만 남겨요.
- 분기한 세션은 행과 제목 표시줄에 ⑂ 와 ← 부모 이름으로 어디서 왔는지 보여줘요.
- 오토파일럿 실행의 하위 세션이 실행 행 아래 작업 이름과 함께 모여요.

### 안정성
- 한글 입력 중 Enter로 글자를 확정하면 전송 등 다른 동작이 실행되던 것을 고쳤어요.
- 메인 스레드가 멈추면 감지해서 다음 실행 때 알려주고, 30초 넘게 끝나지 않는 종료·업데이트 설치는 강제로 끝내요.
- 설정에서 진단 보고서를 복사할 수 있어요(버전, 기기 구성, 최근 로그 일부. 미리 보고, 아무것도 업로드하지 않아요).
- 앱이 스스로 업데이트하는 때가 조용해졌어요.

### 기타
- 새 워크트리를 만들 때 `.worktreeinclude`에 적은 파일을 복사하고 `.ompdesk/worktree-setup`을 실행해요.

<!-- en -->

You can use OMPdesk much more compactly and quickly on a phone or tablet, and the themes are new.

### Phone and tablet
- The UI is denser, at desktop density: smaller type and gaps, a one-row composer with the model and mode pickers behind ⋯, and a work strip under the header. Tap targets stay 44 px regardless of the visible size.
- Photos picked on the phone reach the computer through `/upload` instead of the socket, so large pictures no longer get lost, and HEIC/HEIF is converted so the model can read it. A picture the browser cannot draw shows as a chip with its format and size.
- On touch, prompt suggestions are one row of chips: tap to fill, long press to send.
- You can install the web page as an app (Help menu, Settings, one quiet hint on the second visit), and the system rotation lock is respected.
- Theme, text size and layout are saved per device, so changing them on the phone does not change the computer.
- A phone that was viewing a desktop session views it again after the app restarts.
- The web page loads and reconnects faster: coming back no longer reloads when nothing was missed, the first-screen JavaScript is smaller, and only the language in use is loaded.
- Fixed the Help menu's sheet-then-drawer sequence navigating to about:blank, and a tab-less web window showing only a spinner.

### Autopilot
- Shipping has Commit / Push / Release levels, and you pick the branch to commit on and the target to push to. A branch another worktree holds is pushed through a work branch.
- The start sheet shows only guide, shipping, branch and Start; the rest is under Advanced.
- No more soft stops: red cycles, rejected pushes, failed releases, plan mode and quiet turns are repaired instead of pausing the run.

### Themes
- Ten clearly distinct themes. System pairs a light theme with a dark one and follows the OS.

### Sidebar
- A session's subagents and the sessions it opened show together as one family, with one age format; a narrow sidebar shrinks the summary chip to its running pill.
- A fork shows where it came from on its row and in the title bar (⑂ and ← parent).
- An Autopilot run's children sit under the run's row with their task.

### Stability
- Enter that commits a Korean (IME) composition no longer fires send or other handlers.
- A hung main thread is detected and reported on the next launch, and a quit or update install that wedges for 30 seconds is force-exited.
- Settings can copy a diagnostics report (versions, machine setup, recent log lines), previewed first, nothing uploaded.
- Automatic updates are quieter.

### Other
- New worktrees get the files listed in `.worktreeinclude` copied in and run `.ompdesk/worktree-setup`.

## [0.36.1] - 2026-10-18

앱을 켜자마자 새 탭을 열면 단축키가 모두 먹통이 되던 문제를 고쳤어요.

### 고친 것
- 앱을 켜는 중에 ⌘T로 새 탭을 열면 탭 선택과 화면 경로가 어긋나서, 그 뒤 모든 단축키(⌘, 로 설정 열기 등)가 거부되던 것을 고쳤어요. 탭 목록을 맞추는 중에 시작된 탭 전환도 이제 화면 경로를 그대로 지켜요.

<!-- en -->

Opening a new tab right after launch no longer leaves every keyboard shortcut dead.

### Fixed
- Pressing ⌘T while the app was still starting up left the tab selection and the screen route out of step, so every shortcut afterwards (such as ⌘, for Settings) was refused. A tab switch that begins while the tab list is being reconciled now keeps the route state in step.

## [0.36.0] - 2026-10-18

휴대폰과 태블릿에서 쓰기 편해졌고, 휴대폰 화면 아래가 가려지던 문제를 고쳤어요.

### 새로 생긴 것
- 휴대폰·태블릿에서 터치로 누르기 편하게 다듬었어요. 세션 목록, 프로젝트 머리글, 할 일, 계획 단계, 변경된 파일, 작업 칩, 보드 행, 질문·승인 카드의 버튼이 44px로 커지고, 마우스를 올려야만 보이던 행 동작은 ⋯ 메뉴로 열려요. 스위치도 터치에서 더 넓어졌고 작은 글자는 한 단계 커졌어요.
- 세로로 든 태블릿(너비 800px 이상)에서는 세션 목록이 두 번째 패널로 붙어요.
- 웹 화면이 알맞은 때에 스스로 업데이트돼요. 저장하지 않은 파일 편집이나 열려 있는 시트·대화상자가 있으면 기다리고, 업데이트 배너와 관련 문구는 없어졌어요.
- 휴대폰·태블릿에서 열어 둔 탭이 컴퓨터 쪽 앱이 재시작되어도 남아요. 같은 기기로 다시 접속하면 탭이 돌아오고, 차단하거나 해제한 기기의 탭은 지워져요.

### 고친 것
- 휴대폰에서 화면 아래의 UI가 시스템 내비게이션 바나 홈 인디케이터에 가려지던 것을 고쳤어요. 시트, 토스트, 입력창, 배너가 안전 영역 위에 놓여요. 키보드가 화면 크기를 바꾸는 기기에서는 아래 여백을 따로 더하지 않아요.
- 내가 보낸 메시지에서 "여기서 새 탭으로 분기"를 누르면 그 메시지까지 복사한 세션이 생겨서, 보낸 적 없는 요청이 답 없이 남았어요. 재시작 뒤에는 "중단됨"으로 보이고 이어지지도 않았어요. 이제 분기는 그 메시지 바로 앞에서 끝나고, 메시지는 새 탭 입력창에 들어가요.
- 결과를 기다리는 도구 호출에서 분기하면 그 호출 바로 앞에서 끊어요. 답이 오지 않을 호출이 새 세션에 남지 않아요.
- 휴대폰에서 메시지를 탭한 뒤 스크롤을 멈추려고 다시 탭하면 분기 버튼이 눌리던 것을 고쳤어요. 터치에서는 분기가 ⋯ 메뉴 안에 있어요.
- 재시작 뒤 이어서 돌아가는 서브에이전트가 화면에 보이지 않던 것을 고쳤어요. 이제 작업 보드와 에이전트 목록에 실행 중으로 나와요.
- 재시작 후 이어하기 판단(찾은 기록, 탭, 이어간 결과)을 `logs/gui-runtime.jsonl`에 남겨요.
- 세션을 연달아 열면 사이드바 목록이 오래된 순으로 보였다가 잠시 뒤 최신 순으로 뒤집히던 것을 고쳤어요.
- 로컬 포트가 바뀌어도 모바일 웹이 Tailscale 주소를 하나 더 남겨 두지 않아요.

<!-- en -->

Phones and tablets are easier to use, and the bottom of the screen is no longer covered on phones.

### Added
- Touch use on phones and tablets is easier. Buttons on session rows, project heads, todos, plan steps, changed files, work chips, board rows and the ask/approval card grow to 44 px, and row actions that only showed on hover open from a ⋯ menu. Switches are wider on touch and small type steps up a point.
- A portrait tablet from 800 px wide docks the session list as a second pane.
- The web page now updates itself at a safe moment. It waits while there are unsaved file edits or an open sheet or dialog; the update banner and its strings are gone.
- Tabs opened on a phone or tablet survive the desktop app's relaunch. Reconnecting with the same device brings them back, and a blocked or revoked device's tabs are dropped.

### Fixed
- Bottom UI on phones was hidden behind the system navigation bar or home indicator. Sheets, toasts, the prompt and banners now sit above the safe area, and no extra bottom inset is added on devices whose keyboard resizes the content.
- Choosing "Branch to new tab here" on a message you sent copied the session including that message, leaving a request that was never sent and never answered; after a restart it showed as "Interrupted" and did not resume. A branch now ends just before that message, and the message goes into the new tab's composer.
- Branching at a tool call that is still awaiting its result now cuts just before that call, so no call that will never be answered lands in the new session.
- On a phone, tapping a message and then tapping again to stop scrolling pressed the Branch button. On touch, Branch is inside the ⋯ menu.
- Subagents that resume after a restart were not visible. They now show as running on the task board and in the agent list.
- Resume decisions after a relaunch (the records found, the tabs, the outcome) are logged to `logs/gui-runtime.jsonl`.
- Sessions opened in quick succession no longer show oldest first in the sidebar and flip to newest first a moment later.
- Mobile web no longer leaves a second Tailscale address behind when the local port changes.

## [0.35.1] - 2026-10-18

오토파일럿 시작 창에서 가이드나 백로그를 입력한 뒤 시작을 눌러도 반응이 없던 문제를 고쳤어요.

### 고친 것
- 가이드·백로그 입력칸에서 포커스가 빠질 때 입력칸이 줄어들며 시트가 다시 배치되어, 마우스를 누르는 사이 시작 버튼이 밀려 클릭이 닿지 않던 것을 고쳤어요. 이제 입력한 뒤 바로 시작을 눌러도 시작돼요.

### 바뀐 것
- 오토파일럿이 사이클 끝에 낸 보고를 그대로 믿지 않고 git 변경과 그 턴의 도구 호출로 확인해요. 변경이 없는데 "끝났다"고 하거나, 검증을 돌리지 않았는데 통과했다고 하면 받아들이지 않아요.
- 한 사이클에서 처음 낸 종료 보고가 유지돼요. 나중에 다시 낸 보고가 앞선 결과를 덮어쓰지 않아요.
- 새 "고르기" 단계가 이번 사이클에서 맡을 항목의 이름을 남기고, 사이클을 시작할 때 힌트를 함께 전달해요.
- 타임라인에 변경 규모, 문서만 바뀐 사이클인지, 검증 메모가 표시돼요.

<!-- en -->

Fixed Autopilot's Start button doing nothing after typing a guide or backlog in the start sheet.

### Fixed
- The guide and backlog box collapsed on blur, which reflowed the sheet between mouse-down and mouse-up so the click never reached Start. Typing and then pressing Start now starts the run.

### Changed
- Autopilot no longer takes a cycle's report at its word: it is checked against git and the turn's tool calls. A claim of finished work with no change, or of passing verification that never ran, is not accepted.
- The first end report of a cycle stands; a later report cannot overwrite it.
- A new pick step names the item the cycle works on, and the cycle's start carries hints.
- The timeline shows the change size, whether a cycle changed docs only, and verification notes.

## [0.35.0] - 2026-10-18

휴대폰을 모바일 웹에 연결하면 OMPdesk가 "A JavaScript error occurred in the main process" 오류로 멈추던 0.34.0의 문제를 고쳤어요.

### 고친 것
- 연결한 휴대폰이 보낸 첫 WebSocket 메시지에서 메인 프로세스가 `bufferUtil.unmask is not a function`으로 죽던 것을 고쳤어요. 번들이 설치되지 않은 `ws`의 선택 모듈(`bufferutil`, `utf-8-validate`)을 빈 객체로 넣어서 생긴 일이라, 이제 그 경로를 빌드에서 끄고, 빌드 검사가 그런 빈 대역을 거부하고 번들된 `ws`로 실제 왕복을 돌려 봐요.
- 새 소식 카드는 제목 표시줄 아래 한 줄로 자리를 잡아 입력창을 가리지 않아요(넓은 창, 좁은 창, 분할 화면, 사이드 패널 모두).

### 바뀐 것
- 모바일 웹은 주소만 열면 연결돼요(Tailscale 로그인). 페어링 코드 대신, 허용한 Tailscale 계정으로 로그인한 기기가 처음 열 때 바로 연결되고, 데스크톱에는 차단 버튼이 있는 알림이 떠요. 차단은 해제할 때까지 그 기기에 남고, 새 기기를 승인하는 스위치(기본 꺼짐)도 있어요. 설정에는 링크, 큰 복사 버튼, QR 하나가 보여요. 모바일 웹은 여전히 베타이고 기본으로 꺼져 있어요.
- 업데이트를 알아서 설치할 수 있어요(설정 › 업데이트·정보 › 업데이트 자동 설치, 기본 꺼짐). 켜면 내려받은 업데이트를 조용한 때(돌고 있는 턴이나 열린 질문이 없고, 창이 모두 비활성이거나 2분 동안 입력이 없을 때)에 60초 카운트다운과 "지금 / 나중에"를 보여준 뒤 다시 시작하며 설치해요. 중단된 작업 이어가기가 켜져 있으면 30분이 지나면 그냥 진행해요.
- 사이드바: 실행 중·대기 중·오류 상태는 행 안쪽, 자기 들여쓰기 자리의 막대로 표시하고(막대 옆에는 열린 탭 점이 없어요), 행의 동작 버튼은 마우스를 올렸을 때만 보여요. 하위 에이전트 표시는 작은 칩이 됐고, 고정한 프로젝트는 고정 표시를 계속 보여줘요.
- 모드 메뉴가 촘촘해졌어요. 설정마다 한 줄(왼쪽 이름, 오른쪽 조작, 설명은 (i) 툴팁)이고, 계획·목표·자동 모드 스위치도 같은 밀도예요.
- 오토파일럿은 프로젝트마다 `AUTOPILOT.md` 안내서(목표, 우선순위, 건드리지 말 경로, 완료 기준 등)를 매 사이클 시작에 읽어요. 없는 저장소에는 시작 화면에서 초안을 만들어 주고, 시작하면 오토파일럿 브랜치의 첫 커밋으로 남겨요.
- 다시 시작하면 이어지는 작업이 조용해졌어요. "중단된 작업 N개 이어가는 중" 토스트 대신 이어지는 탭마다 차분한 줄 하나와 그 탭만 멈추는 멈춤 버튼이 있고, 보고 있던 탭부터, 그다음 분할 화면의 다른 칸, 그다음 백그라운드 탭 순서로 이어가요. 재시작이 멈춘 백그라운드 작업은 원래 명령 대신 흐린 한 줄(작업 수, 마우스를 올리면 목적)로 보이고, 에이전트는 꼭 필요한 것만 말없이 다시 돌려요.
- 어디서나 지금의 OMPdesk 로고가 보여요: Windows 창·정보 패널·알림 아이콘, DMG 배경과 볼륨 아이콘, Windows 설치·제거 프로그램 아이콘, 푸시 배지와 알림 아이콘, 첫 화면, 업데이트·정보 화면과 새 소식 카드 머리, GitHub 미리보기 이미지. Windows에는 앱 ID(AppUserModelId)가 붙어요.

<!-- en -->

Connecting a phone to Mobile web no longer stops OMPdesk with "A JavaScript error occurred in the main process", which broke 0.34.0.

### Fixed
- The main process died with `bufferUtil.unmask is not a function` on the first WebSocket message a connected phone sent. The bundle carried `ws`'s optional modules (`bufferutil`, `utf-8-validate`), which are not installed, as empty objects; the build now switches that path off, and the bundle check refuses such stand-ins and runs a real round trip through the bundled `ws`.
- The What's new card is a row under the title bar and never covers a composer (wide, narrow, split, and with the side panel open).

### Changed
- Mobile web connects when you open its address (Tailscale sign-in). No pairing code: a device signed in to an allowed Tailscale account connects on its first visit, and the desktop shows a notice with Block. A block stays on that device until Unblock, and an optional switch asks before new devices (off by default). Settings shows the link, a big Copy button and one QR. Mobile web is still beta and off by default.
- OMPdesk can install its own updates (Settings › Updates & about › Install updates automatically, off by default). On, a downloaded update waits for a quiet moment (no running turn or open question; every window unfocused or 2 minutes without input), shows a 60-second countdown with Now and Later, then restarts into it. With Continue interrupted work on, it goes ahead after 30 minutes anyway.
- Sidebar: running, waiting and error show as a bar inside the row at its own indent (no open-tab dot beside it), and row actions appear only on hover; the subagent marker is a compact chip; a pinned project keeps its pin glyph.
- The Mode popover is compact: every setting is one row (label left, control right, the explanation behind an (i) tooltip), and Plan, Goal and the Auto mode switch share the density.
- Autopilot reads a per-project `AUTOPILOT.md` guide (goals, priorities, no-touch paths, done criteria, and more) at the start of every cycle. For a repo without one the start sheet drafts it, and starting commits it as the first commit on the autopilot branch.
- A relaunch continues work quietly: no "Continuing N interrupted tasks" toast; each resuming tab shows one calm row with a Stop for that tab only, and tabs continue in order, the one you look at first, then the other panes of its split, then background tabs. Background jobs the restart stopped show as one muted line (job count, intents on hover) instead of their commands, and the agent re-runs only what the work still needs without narrating it.
- The current OMPdesk logo on every surface: the Windows window, About panel and notification icon, the DMG background and volume icon, the Windows installer and uninstaller icons, the push badge and notification icon, the first paint, the Updates & about header and the What's new card, and the GitHub social preview. Windows gets its AppUserModelId.

## [0.34.0] - 2026-10-17

오토파일럿이 생겼어요. 자기 worktree에서 쉬지 않고 개발을 이어가고, 메인 에이전트가 OMPdesk의 다른 세션을 열고 지켜보고 합칠 수 있어요.

### 새 기능
- 오토파일럿: 새 git worktree 탭(브랜치 `autopilot/<날짜>`)에서 목표 모드를 이어 가며 개발을 계속해요. 사이클 기록, 계정 순환, 멈춤 규칙, 푸시·릴리스 단계, 승인자, git 감사, 출시 대기열, 패널과 작업 현황판 카드, 모드 메뉴 탭이 있어요. 앱이나 omp가 다시 켜져도, 강제 종료 뒤에도 자기 도구와 함께 이어서 달려요.
- OMPdesk 제어 도구(설정 › 도구·확장, 기본 켜짐): 메인 에이전트가 이 창의 세션을 열고, 읽고, 지시하고, 질문에 답하고, 기다리고, 멈출 수 있어요.
- 병렬 작업: 하위 세션마다 worktree와 브랜치(`omp/agent/…`)를 만들어 나눠 맡기고, 결과를 비교해 이긴 쪽만 합쳐요(로컬 병합만, 푸시 없음). 검토 대기열은 작업 현황판에 떠요. 일정을 만들고 위임 교훈을 메모리에 남기는 것도 도구로 해요.
- 컴퓨터 사용은 기본으로 켜졌고, 한 번에 한 세션만 데스크톱을 조작하는 "데스크톱 자리"가 생겼어요. 쥐고 있던 세션이 멈춘 걸 확인한 뒤에만 자리를 넘겨요.
- 모바일 웹(베타, 기본 꺼짐): 내 Tailscale 네트워크 안에서 휴대폰으로 진행 중인 작업을 지켜보고 지시해요. 설정 화면의 한 단계씩 안내, 페어링 코드와 QR, 기기별 권한, 휴대폰용 설정·센터·Preview·터미널·변경 사항 화면이 있어요.
- 모바일 웹 푸시와 앱 설치(PWA): 서비스 워커, 아이콘, 푸시 알림(질문·완료, 켜기는 선택), iOS 설치 안내가 들어갔고, 화면을 보면 이미 본 알림은 스스로 닫아요.
- 앱을 다시 시작하면 끊긴 작업을 묻지 않고 이어 가요(설정 › 일반 › 중단된 작업 이어가기). 처음 답이 세션에 기록되기 전에 끊긴 첫 턴도 자기 탭에서 이어져요.
- 입력창: 붙여넣기는 모드를 고르지 않고, 기록에 붙여넣은 글이 남고, 메뉴가 초점을 지키고, 쓰던 글이 새로고침·재시작 뒤에도 남아요. 대기 중인 메시지는 거둘 수 있어요. `->`가 지워지고, `@`가 한글과 공백 경로를 읽고, 편집을 되돌릴 수 있고, 창 너비가 바뀌면 다시 맞춰요.
- 세션을 지우면 그 탭을 닫기만 하고 새 세션을 만들지 않아요. 사이드바는 stock이 기록한 만든 순서로 정렬하고, "(no messages)" 자리표시는 가려요. 프로젝트마다 "병렬 작업" 묶음이 하나이고, 지워진 worktree는 묶음을 만들지 않아요. worktree 폴더 이름 대신 원래 프로젝트 이름을 보여줘요.
- 하위 에이전트: 패널을 메인 대화와 같은 구성요소로 다시 만들었고, 제목은 `Title:` 첫 줄 덕분에 답변 언어로 나와요.
- 코드 블록, mermaid·svg 그림, Files 뷰어가 상자마다 머리줄 하나(왼쪽 종류, 오른쪽 아이콘 버튼)를 써요. viewBox만 있는 svg도 빈 상자가 되지 않아요.
- 사용량·계정: 사이드바는 제공자마다 한 줄에 마지막으로 쓴 계정을 보여주고, 작업 현황판에는 모든 제공자의 계정이 나와요. 게이지 아래에 초기화 시간이 짧게 붙고(`5H 23% · ↻ 1h 54m`), 이메일은 짧게 보여요. 할당량 모드에서는 턴이 시작될 때 자동 고정을 다시 골라요.
- 자동 모드는 고른 한 요청에만 쓰고 바쁜 세션은 건드리지 않아요. 자동 목표가 프롬프트를 입력창으로 되돌리던 것도 고쳤어요.
- 라이선스는 MIT이고, 저장소는 공개예요. 업데이트 확인과 내려받기는 익명으로 되고 GitHub 토큰은 선택이에요. 서드파티 고지는 앱에 들어 있어요.
- 래칫, 바이브, 루프 모드를 없앴어요. 계획과 목표는 그대로예요.

### 고친 것
- 모델이 UTF-8을 cp1252로 잘못 쓴 깨진 다음 메시지 제안은 버려요.
- 사진만 있는 세션도 이름이 남아요(사진 또는 파일 메시지).
- 대화 앵커와 작업 메모가 에이전트 메시지 포장이 아니라 사용자 본문을 보여줘요.
- 강제 종료된 omp의 백그라운드 bash 작업을 다시 시작할 때 알려줘요.
- 세션 폴더 감시를 파일 하나 놓치지 않는 재귀 감시 하나로 합쳤어요.
- 데스크톱 자리 응답이 `{}`이면 화면이 죽던 것을 고쳤어요.

### 가벼워진 것
- 글꼴은 woff2만 담고, 업데이트 내용(CHANGELOG)은 필요할 때 불러와요. 설치 파일과 첫 화면이 가벼워졌어요.
- 첫 실행은 omp를 기다리지 않고 제공자 단계부터 열려요.

<!-- en -->
Autopilot arrives: it keeps developing on its own in its own worktree, and the main agent can now open, watch and merge other OMPdesk sessions.

### New
- Autopilot: a guarded, unattended Goal loop in a new git worktree tab (branch `autopilot/<date>`), with a cycle ledger, account rotation, stop rules, push and release levels, an approver, a git audit, a ship queue, a panel, a work-board card and a Mode tab. It continues after an app or omp restart and after a SIGKILL, armed with its own tools.
- OMPdesk control tools (Settings › Tools & extensions, on by default): the main agent can open, read, steer, answer, wait for and stop the sessions of its window.
- Parallel work: each child gets its own worktree and branch (`omp/agent/…`), you compare the results and merge only the winner (local merge, never a push), and the review queue sits on the work board. Agents can also create schedules and save delegation lessons to memory.
- Computer use is on by default, and a desktop slot lets one session at a time drive the desktop; it is handed on only once the holder is confirmed stopped.
- Mobile web (beta, off by default): steer and read a running task from a phone over your own Tailscale network, with one-step setup guidance, a pairing code and QR, per-device permissions, and phone layouts for Settings, centers, Preview, Terminal and Changes.
- Mobile web push and install (PWA): service worker, icons, opt-in push notifications for questions and finished work, an iOS install guide, and notifications the page closes itself once you look at it.
- After a restart, interrupted work continues without asking (Settings › General › Continue interrupted work), including a first turn cut off before its session was written.
- Composer: pastes never pick a mode, history keeps pasted text, menus keep focus, drafts survive reload and relaunch, a pending prompt can be withdrawn, `->` deletes, `@` reads Hangul and paths with spaces, edits are undoable, and the field refits when the width changes.
- Deleting a session only closes its tab, never starts a new one. The sidebar orders sessions by stock's created time and hides the "(no messages)" placeholder, shows one Parallel work group per project (none for a discarded worktree) and names a worktree by its origin project instead of its folder.
- Subagents: the panel is rebuilt on the main transcript's components, and titles come in the reply language through a `Title:` first line.
- Code blocks, mermaid/svg figures and the Files viewer wear one header row per box (kind left, icon actions right); a viewBox-only svg no longer collapses.
- Usage and accounts: one sidebar line per provider with its last-used account, every provider's account on the work board, compact reset lines (`5H 23% · ↻ 1h 54m`) and bare emails, and quota mode re-ranks the automatic pin at turn start.
- Auto mode is used for the one request it classified and leaves busy sessions alone; an automatic Goal no longer sends its prompt back to the composer.
- MIT license and a public repository; update checks and downloads are anonymous and a GitHub token is optional; third-party notices ship in the app.
- Ratchet, Vibe and Loop are removed; Plan and Goal stay.

### Fixed
- Next-message suggestions the model wrote as UTF-8-in-cp1252 are dropped.
- An image-only session keeps a label (Image or file message).
- Conversation anchors and work notes show the user's text, not the agent-message wrapper.
- A SIGKILLed omp's background bash jobs are named on relaunch.
- The session watcher is one recursive watch that loses no files.
- A host answering the desktop slot with `{}` no longer crashes the page.

### Lighter
- Fonts ship as woff2 only and the CHANGELOG loads on demand, so the installer and first paint are lighter.
- A true first run opens the provider step before omp boots.

## [0.33.0] - 2026-10-16

메시지를 보내면 계획·목표 모드를 알아서 고르고, 사이드바와 계정 목록에 구독 사용량이 막대로 보여요. 세션 삭제와 Windows 추가 지시 문제를 고쳤고, 앱이 가벼워졌어요.

### 새 기능
- 자동 모드: 메시지를 보면 큰 작업은 계획 모드, "테스트 통과할 때까지" 같은 일은 목표 모드를 알아서 켜요. 입력창의 "자동: 계획" 칩을 누르면 바로 꺼요. 루프·바이브는 자동으로 켜지 않아요.
- 모드 메뉴에 래칫이 생기고, 모델 풀은 없어졌어요.
- 사이드바 아래에 구독 계정마다 한 줄씩 "5H · 7D" 사용량 막대가 기본으로 보여요. 에이전트·통계 항목은 기본으로 숨겼어요(설정에서 다시 켤 수 있어요).
- 설정의 계정 목록도 같은 막대로 바꾸고, 숫자는 어디서나 "쓴 양"으로 맞췄어요.
- 작업 중이면 입력창 테두리에 은은한 빛이 돌아요. 백그라운드에서 에이전트만 일할 때는 더 옅게 돌고, 보내기 버튼에 안내가 떠요.
- + 메뉴를 다섯 가지로 줄이고, 스킬은 검색되는 한 줄 목록에서 골라요.
- 업데이트 안내가 화면을 가리지 않고 오른쪽 아래 카드로 떠요. 누르면 자세한 내용이 열려요.

### 고친 것
- 잠든 탭에서 세션을 지우면 사이드바에 남거나 새 세션이 생기던 것을 고쳤어요.
- Windows에서 Ctrl+Enter로 보낸 추가 지시가 대기열로 가던 것을 고쳤어요. 대기열로 보내기는 Alt+Enter예요.
- omp가 다시 켜질 때 입력 중이던 글이 사라질 수 있던 것을 고쳤어요.
- 처음 로그인 화면이 중간에 다시 그려져 진행이 끊기던 것, 명령 팔레트에 입력한 글자가 지워지던 것을 고쳤어요.
- 다음 메시지 제안이 이미 보낸 말을 다시 내놓던 것을 고치고, 입력 중 이어 쓰기가 내 말투로 자연스럽게 이어지게 했어요.

### 가벼워진 것
- 설치 파일이 작아졌어요(Mac 101 → 약 92 MB). 한국어·영어 외 Electron 언어 파일을 빼고, 다른 언어 사용자의 맞춤법 검사와 미리보기 언어는 시스템 언어를 따라요.
- 작업 현황판의 행 애니메이션을 정리해 답변 중 그래픽 사용량을 v0.31 수준으로 되돌렸고, 같은 정보를 두 번 묻던 요청을 합쳤어요. 창을 숨기면 주기 작업이 멈춰요.
- 세션 폴더는 세션 파일만 감시해요.

<!-- en -->
Sending a message can now switch Plan or Goal mode on by itself, and subscription usage shows as gauges in the sidebar and the account list. Session deletion and Windows steering are fixed, and the app is lighter.

### New
- Auto mode: a large change enters Plan mode and "keep going until tests pass" starts a Goal, chosen per message; the "Auto: Plan" chip undoes it. No other mode is switched on automatically.
- The Ratchet, Vibe and Loop modes are removed; the Mode menu keeps Plan and Goal, and the model pool is gone.
- The sidebar footer shows one "5H · 7D" usage line per subscription account, on by default; Agents and Stats entries are hidden by default (re-enable them in Settings).
- The account list in Settings uses the same gauges, and usage reads as share used everywhere.
- While work runs, a faint light travels around the composer; it is fainter while only background agents run, and Send explains that sending starts right away.
- The + menu has five entries, and skills are picked from a searchable one-line list.
- What's new appears as a card in the bottom-right corner instead of covering the window; open it for the full notes.

### Fixed
- Deleting a session held by a sleeping tab no longer leaves its row behind or spawns a new session.
- On Windows, Ctrl+Enter sends steering instead of queueing a follow-up; queue with Alt+Enter.
- A draft survives omp restarting.
- The first sign-in panel no longer resets mid-flow, and the command palette keeps what you typed when omp connects.
- Next-message suggestions no longer echo messages you already sent, and inline completion continues your own sentence in your register.

### Lighter
- Smaller installers (macOS 101 → about 92 MB) by shipping only English and Korean Electron locales; spellcheck and Preview language follow the system languages for everyone else.
- The work board's rows no longer animate, bringing GPU use while streaming back to v0.31 levels; duplicate polls are merged and periodic work stops while the window is hidden.
- The session watcher only watches session files.

## [0.32.2] - 2026-10-16

Windows에서 최대화한 채로 껐다 켜면 창이 검게 비어 보이던 문제를 고쳤어요.

- Windows: 최대화 상태로 열리는 창이 검은 빈 화면으로 뜨던 것을 고쳤어요. 최대화로 열리는 창에는 Mica 배경을 쓰지 않아요.
- 세션 제목이 더 짧아졌어요. 장식 없이 글자만, 한국어 12자 안팎으로 만들고, 길면 대화 모델로 한 번 더 줄여요.
- 다음 메시지 제안이 평소 말투(반말·존댓말)를 앱이 직접 판단해서 맞춰요.
- 작업 현황판: 맨 위 상태 줄을 없애고, 계정 행을 이메일과 한도 막대 두 개("5H 62%", "7D 41%"), 막대별 초기화 시간으로 바꿨어요.
- Windows 설치 파일을 만드는 시간을 줄였어요(설치 파일은 조금 커져요).

<!-- en -->
Fixes a black, empty window on Windows when the app was last closed maximized.

- Windows: a window that opens maximized no longer shows a blank black window; maximized windows open without the Mica backdrop.
- Session titles are shorter: plain text, about 12 Korean characters, with one retry on the conversation model when too long.
- Next-message suggestions keep your register (반말 or 존댓말), decided in code.
- Work board: the header status line is gone; the account row shows the email, two usage gauges ("5H 62%", "7D 41%") and each window's reset.
- Faster Windows installer packaging (the installer is somewhat larger).

## [0.32.1] - 2026-10-16

세션 제목이 내 언어로 짧게 붙고, 다음 메시지 제안이 내 말투로 짧게 나와요. 작업 현황판에 지금 쓰는 계정의 한도와 토큰 속도가 보여요.

- 세션 제목을 쓰는 언어(한국어 등)로, 2~5단어·20자 안으로 만들어요. 이미 영어로 붙은 제목은 ✨로 다시 만들 수 있어요.
- 다음 메시지 제안이 최근에 보낸 메시지의 말투(반말·존댓말)와 길이를 따라 해요. 에이전트 말투("~해 둘게요")는 걸러 내고, 한국어 40자 안으로 줄여서 칩이 잘리지 않아요.
- 작업 현황판 맨 위에 지금 쓰는 구독 계정의 가장 빡빡한 한도(막대·초기화 시간)를, 이번 턴 줄에 토큰 속도(tok/s)를 보여 줘요. 끝난 할 일은 한 줄로 접히고, 끝난 작업은 부드럽게 사라져요.

<!-- en -->
Session titles come in your language and stay short, and next-message suggestions sound like you. The work board shows the current account's limit and the token speed.

- Session titles are written in the language you write in, 2–5 words (≤ 20 characters in Korean). Titles already named in English can be redone with ✨.
- Next-message suggestions follow the register and length of your recent messages, drop anything in the assistant's voice, and stay within 40 Korean / 60 Latin characters so chips no longer cut off.
- The work board's header shows the account in use with its tightest limit (meter and reset time), and the turn line shows tokens per second. Finished to-dos fold into one line and finished work fades out.

## [0.32.0] - 2026-10-16

넓은 창에 작업 현황판이 생기고, 세션 제목과 플러그인·MCP 업데이트, 미리보기·변경 사항 열기, 오류 재시도까지 앱이 알아서 해요. 설정과 모델 선택 창도 촘촘하게 다시 그렸어요.

### 작업 현황판
- 채팅 칸이 넓으면 오른쪽에 작업 현황판이 붙어요. 답변을 기다리는 질문(⌥B), 이번 턴의 최근 단계, 실행 중인 서브에이전트(모델·단계·토큰·시간), 할 일 진행, 목표 예산을 한눈에 보여 줘요.
- 현황판이 보일 때는 입력창 위의 같은 줄을 숨겨요. 사이드 패널을 열거나 창이 좁으면 저절로 숨고, 설정에서 끌 수 있어요.

### 알아서 하는 일
- 세션 제목이 첫 메시지로 자동으로 붙고, 작업 주제가 바뀌면 새로 정리돼요. 직접 고친 제목은 그대로 두고, 제목 칸의 ✨ 버튼으로 다시 자동 제목으로 돌릴 수 있어요.
- 플러그인·마켓플레이스·스킬·MCP 서버가 알아서 업데이트돼요. 버전을 고정한 것은 "새 버전 있음"만 알려 주고, MCP 설정 파일은 고치지 않아요.
- 에이전트가 개발 서버를 띄우면 미리보기를, 파일을 고치면 턴이 끝난 뒤 변경 사항을 자동으로 열어요. 사이드 패널이 닫혀 있을 때만이고, 직접 닫으면 다시 열지 않아요.
- 일시적인 오류로 턴이 실패하면 30초·2분·10분 뒤 다시 시도해요. 취소하거나 바로 다시 시도할 수 있어요.
- 여러 탭이 거의 동시에 끝나면 알림을 하나로 묶어요.
- 입력창에서 목록(`- `, `1. `, `- [ ] `) 줄을 바꾸면 기호가 자동으로 이어져요.

### 화면
- 설정 화면을 한 줄 행과 아이콘·회사 심볼 중심으로 촘촘하게 바꿨어요. 긴 설명은 ⓘ에 넣었어요.
- 모델 선택 창을 작은 검색창과 한 줄 행(회사 심볼·이름·컨텍스트 크기)으로 줄였어요.
- 다음 메시지 제안이 이미 맡긴 일을 다시 제안하지 않고, 후보를 3개씩 보여 줘요.
- Windows에서 새 창을 열 때 테마 색이 시스템 테마로 잘못 보이던 것을 고쳤어요.

<!-- en -->
A work board for wide windows, and more that runs by itself: session titles, plugin and MCP updates, opening Preview and Changes, and retrying failed turns. Settings and the model picker are denser.

### Work board
- When the chat pane is wide, a board docks on the right: questions waiting on you (⌥B), the turn's latest steps, running subagents (model, step, tokens, time), to-do progress and the goal budget.
- While it shows, the matching strips above the composer step aside. It hides with the side panel or a narrow window, and can be turned off.

### Done for you
- Sessions get a title from the first message, and the title follows the work as its topic changes. A title you typed stays; the ✨ button in the title field makes it automatic again.
- Plugins, marketplaces, skills and MCP servers update themselves. Pinned ones only show "update available", and your MCP config is never rewritten.
- Preview opens when the agent starts a dev server, and Changes opens after a turn that edited files — only while the side panel is closed, and not again once you close it.
- A turn that fails on a transient error retries after 30 s, 2 min and 10 min, with Cancel and Retry now.
- Several tabs finishing at once produce one notification.
- Pressing Shift+Enter on a list line (`- `, `1. `, `- [ ] `) continues the list.

### UI
- Settings is compact: one-line rows with icons and company marks, long descriptions behind ⓘ.
- The model picker is smaller: a compact search and one-line rows (mark, name, context size).
- Next-message suggestions no longer repeat work already handed off, and offer three candidates.
- A new window on Windows no longer starts in the system theme instead of the app's.

## [0.31.0] - 2026-10-16

계정 화면을 새로 그리고, 다음에 보낼 말을 앱이 직접 제안해요. 창을 닫아도 작업은 계속되고, 필요한 CLI는 알아서 설치·업데이트돼요.

### 계정과 프로바이더
- 계정 목록 앞에 Anthropic, OpenAI, Google, xAI, DeepSeek 같은 실제 회사 심볼이 보여요. 모든 계정이 회사 순으로 한 목록에 펼쳐지고, 한 줄에 로그인 상태와 가장 빡빡한 한도가 함께 보여요.
- 프로바이더 추가는 심볼과 이름으로 된 촘촘한 목록이고, 검색과 Enter로 바로 연결해요. 첫 실행 화면도 같은 모양이에요.

### 다음 메시지 제안
- 작업이 끝나면 다음에 보낼 만한 말을 2~3개 제안해요. 첫 번째는 입력창에 회색으로, 나머지는 칩으로 보여요. Tab·→·⌥1~3으로 골라요.
- 입력하다 멈추면 이어질 말을 회색으로 채워 줘요. 한글 조합 중이나 비밀번호처럼 보이는 글에는 띄우지 않아요.
- 실패한 명령, 바뀐 파일, 계획, 목표 같은 앱 상태도 보고 제안하며, 싼 "빠름(smol)" 모델을 써요. 설정 › 에이전트 동작에서 끌 수 있어요.

### 창과 설치
- X를 눌러도 앱이 꺼지지 않아요. Windows는 트레이로, Mac은 Dock으로 들어가고 진행 중인 작업은 계속돼요.
- GitHub 연결에 GitHub CLI가 필요하면 그 자리에서 설치하고 바로 로그인으로 이어가요.
- 계정이 연결된 회사의 CLI(Claude Code, Codex, Gemini CLI, Cursor Agent, Copilot, gh)가 이미 설치돼 있으면 알아서 최신으로 업데이트해요. 다른 앱에 들어 있거나 시스템에 깔린 사본은 건드리지 않아요.
- 설치 화면이 상황(설치 중·업데이트 중·중단됨·오프라인)을 정확히 알려 주고, 설치 중 앱을 꺼도 실패로 세지 않아요.

### omp 기본 설정
- 앱이 띄운 세션에서 어드바이저, 편집 후 LSP 진단, 저장 시 자동 포맷, 구조 검색 도구, 토큰 사용량 표시를 기본으로 켜요. 직접 설정한 값이 있으면 그 값을 따라요.
- 자리를 비웠다 돌아오면 세션 요약 카드가 붙어요.
- omp의 OpenTelemetry 외부 전송을 항상 꺼요.

### 대화와 화면
- 답장 아래 시간·복사 버튼이 마지막 줄을 가리던 것을 고쳤어요.
- 사이드바 서브에이전트 목록에는 실행 중인 것만 남아요.
- 업데이트 안내(What's new)가 영어 화면에서는 영어로 보여요.
- 한국어 문구의 조사 병기와 용어를 정리하고, 키보드·화면 읽기 프로그램 접근성을 점검했어요.

### 안정성과 보안
- 원격 기기에서 로그인 중 연결이 끊기거나 화면을 새로 그려도 로그인 요청이 채팅 카드로 새지 않아요. 재연결 때 알림이 두 번 뜨던 것도 고쳤어요.
- 터미널을 별도 작업 공간으로 분리하고, 변경 사항 패널이 git을 덜 부르게 했어요.
- 시각화 페이지의 외부 유출 경로(DNS 포함)를 막고, 에이전트 브라우저와 실행 파일 열기 규칙을 강화했어요.

<!-- en -->
A redesigned accounts page and built-in next-message suggestions. Closing the window keeps work running, and the CLIs you need install and update themselves.

### Accounts and providers
- Accounts show the real company marks (Anthropic, OpenAI, Google, xAI, DeepSeek, …) in one open list sorted by company, each row with its sign-in state and tightest limit.
- Adding a provider is a compact, searchable list of marks and names; first run uses the same list.

### Next-message suggestions
- After a turn, 2–3 suggested next messages: the first as the composer placeholder, the rest as chips (Tab, →, ⌥1–3).
- Pause while typing and the rest of the line appears as ghost text (never during IME composition or for secret-looking drafts).
- Suggestions use app state (failed commands, changed files, plans, goals) and the cheap smol model; turn them off in Settings › Agent behavior.

### Window and setup
- The close button no longer quits: Windows hides to the tray, macOS to the Dock, and running work continues.
- Connecting GitHub installs the GitHub CLI on the spot when it is missing and continues to sign-in.
- Installed CLIs of connected providers (Claude Code, Codex, Gemini CLI, Cursor Agent, Copilot, gh) update themselves; bundled or system copies are left alone.
- The setup screen states what is happening (installing, updating, stopped, offline), and quitting mid-install no longer counts as a failure.

### omp defaults
- Sessions OMPdesk starts turn on the advisor, LSP diagnostics after edits, format on write, structural search, and token usage display; your own settings win.
- An idle recap card appears when you come back to a session.
- omp's OpenTelemetry export is always off.

### Chat and UI
- Message actions no longer cover the last line of a reply.
- The sidebar lists only running subagents.
- What's new shows English in the English UI.
- Korean wording and accessibility passes.

### Reliability and security
- Sign-in prompts never leak into chat cards after a reload or a lost remote link; duplicate reconnect notifications are gone.
- Terminals run in their own worker, and the Changes panel runs fewer git processes.
- Visual pages are sealed against exfiltration (DNS included); agent browser and launcher rules were tightened.

## [0.30.0] - 2026-10-16

실제 omp로 처음부터 끝까지 써 보며 찾은 문제를 고치고, 작업이 끊겨도 저절로 이어지게 했어요. omp는 이제 알아서 최신으로 유지돼요.

### 끊긴 작업 자동으로 이어가기
- 인터넷이 끊기면 실패 대신 "인터넷 연결을 기다리는 중"으로 조용히 멈췄다가, 연결되면 그 턴을 이어서 해요. 노트북을 덮었다 다른 곳에서 열어도 마찬가지예요.
- 앱을 끄거나, 앱이 갑자기 꺼지거나, OMPdesk를 업데이트하느라 다시 켜도 진행 중이던 턴을 다시 켤 때 이어서 해요. 직접 멈춘 턴은 이어가지 않고, 설정에서 끌 수 있어요.

### omp 자동 업데이트
- 새 omp가 나오면 작업 중에도 알아서 업데이트해요. 실행 중인 작업은 그대로 끝나고, 쉬고 있는 탭은 바로, 작업 중인 탭은 턴이 끝난 뒤 새 omp로 바뀌어요. OMPdesk 자체 업데이트는 지금처럼 직접 해요.
- 최소 omp 버전을 18.11.0으로 올렸어요. omp 18.11에서 메모리 보기가 비어 보이던 문제를 고쳤어요.

### 설치와 설정
- 처음 설치할 때 필요한 도구를 까는 동안에는 설치 화면이 창 전체를 덮고, 다른 기능은 누를 수 없어요.
- 모델과 계정 설정을 정리했어요. 계정 연결과 모델 역할을 나누고, 역할을 대화 / 에이전트 작업 / 입력과 출력으로 묶었어요. 역할마다 언제 쓰이는지, 실제로 쓰이는 모델(비워 두면 무엇으로 대신하는지), 계정의 로그인·한도 상태를 보여 줘요.
- 탐색·리뷰·디버그·문서·테스트·디자인 역할을 새로 넣어 에이전트 종류마다 다른 모델을 쓸 수 있어요. 역할을 직접 만들고 지울 수도 있어요.
- 설정과 도움말 메뉴를 차분하게 정리했어요. 자주 쓰는 항목이 먼저 보이고, 드문 항목은 "고급" 아래로 옮겼어요.

### 분할 화면과 사이드바
- 분할 화면에 올린 세션은 사이드바에서 모두 선택된 모습이에요. 분할 밖 세션을 누르면 그 세션만 보이고, 분할했던 세션을 누르면 그 분할 화면이 그대로 돌아와요. 다시 켜도 유지돼요.
- 작업이 끝났는데 서브에이전트 표시(🤖 숫자)가 남아 있던 것을 고쳤어요.
- 원격 기기 폴더 선택에서 폴더가 너무 많으면 일부가 안 보이던 것을 고쳤어요. 이름으로 거를 수 있어요.

### 입력과 대화
- "방향 조정"을 "추가 지시"로 바꾸고, 입력창 안내문을 짧게 줄였어요.
- 질문에 아무것도 고르지 않고 제출하면 작업 전체가 멈추던 것을 고쳤어요.
- 입력에 쓴 HTML이 말풍선에서 HTML로 그려지던 것을 고쳤어요. 세션 이름이 화면마다 다르던 것도 맞췄어요.
- 컨텍스트 들여다보기에 앱이 붙이는 프롬프트(답변 언어, 프로필, 답변 스타일 등)가 보여요.
- `http://[::]:포트` 같은 개발 서버 주소도 미리보기에 잡혀요. ⌃⇥를 빨리 눌러도 탭이 바뀌어요.

### 속도
- 긴 세션 열기와 설정 열기를 v0.28.1 수준으로 되돌렸고, 서브에이전트 표시 애니메이션과 SSH 포트 감시가 쓰던 CPU를 줄였어요.

<!-- en -->
Fixes for problems found by using the real omp end to end, work that picks itself up after an interruption, and omp that keeps itself current.

### Interrupted work resumes by itself
- When the internet drops, the turn quietly waits ("waiting for the internet") instead of failing and continues when you are back online, even after closing a laptop and opening it elsewhere.
- After you quit, the app crashes, or OMPdesk restarts for an update, a running turn continues the next time you open it. A turn you stopped yourself is never resumed. Turn it off in Settings.

### omp updates itself
- When a new omp is out it updates even while you work: running work finishes as is, idle tabs switch right away, busy tabs after their turn ends. OMPdesk's own update stays manual.
- The minimum omp is now 18.11.0, which also fixes an empty Memory view on omp 18.11.

### Setup and settings
- While the first-time install of required tools runs, the setup screen covers the whole window and nothing else can be clicked.
- Models & accounts was reorganised: connecting accounts is separate from model roles, which are grouped into Conversation / Agent work / Input & output. Each role shows when it is used, the model actually in use (and what stands in while empty), and the account's sign-in and limit state. New roles (explore, review, debug, docs, test, design) let each kind of agent use its own model; you can create and delete roles.
- Settings and the Help menu were calmed down: common items first, rare ones under "Advanced".

### Split view and sidebar
- Sessions in a split all look selected in the sidebar. Clicking a session outside the split shows only it; clicking one that was split brings that split back as it was, and it survives a relaunch.
- Fixed the subagent badge (🤖 count) lingering after work ended, and remote-device folder pickers hiding folders when there were too many (you can filter by name).

### Composer and chat
- The Korean UI now says "추가 지시" for steering and the composer hint is shorter. Submitting a question without choosing anything no longer halts the whole job. HTML typed in a prompt no longer renders as HTML in the bubble. Session names match across screens. The context inspector shows the prompts the app adds (reply language, profile, reply style…).
- Dev-server addresses like `http://[::]:port` are picked up by Preview, and fast ⌃⇥ presses switch tabs.

### Speed
- Opening long sessions and Settings is back to v0.28.1 speed, and the subagent badge animation and SSH port watcher use less CPU.

## [0.29.0] - 2026-10-15

mixdog을 기능 단위로 전부 비교해(514개 항목) 앱만으로 할 수 있는 것을 구현했고, 처음 설치부터 일상 작업까지 크게 넓혔어요.

### 설치와 첫 실행
- 처음 켜면 Bun과 omp를 알아서 설치해요(Windows는 Git Bash도). 버튼을 누를 필요가 없고, 진행률(%, 단계, 경과 시간)과 실패 이유·다시 시도가 보여요. omp가 오래됐으면 `omp update`도 알아서 해요. Git, GitHub CLI, Node.js는 뒤에서 설치해요.
- Windows 설치 프로그램은 더블클릭 한 번으로 묻지 않고 관리자 권한 없이 설치돼요.
- 앱 안에서 GitHub에 로그인해요(코드 복사와 브라우저 열기). git 이름과 이메일이 비어 있으면 채워 줘요.
- 첫 실행 단계는 다시 켜도 이어지고, ⌘/Ctrl+Enter로 넘어가요. 사이드바 시작 체크리스트와 실제 버튼을 비추는 안내, 업데이트 뒤 한 번 보이는 새 기능 안내가 생겼어요.

### 계정과 모델
- 구독 계정 로그인 때 코드 붙여넣기 카드가 채팅에 뜨던 것을 고쳤어요. 로그인 화면 안의 보조 칸으로만 보이고, 브라우저 로그인이 끝나면 사라져요.
- 계정 한도가 실제와 다르게(0% 등) 보이던 것을 고쳤어요. 보이는 동안 30초마다, 턴이 끝날 때와 창으로 돌아올 때 갱신하고 "N초 전 갱신"과 초기화까지 남은 시간을 보여 줘요.
- 위임 강도 칩(단독·보조·분담·스웜), 프로필(부를 이름, 경험 수준), 답변 스타일, 모델 덮어쓰기, 최근 모델, Ultrafast, 모델별 압축 시점 설정이 생겼어요.
- 사용 한도에 걸리면 초기화 시각에 자동으로 이어서 할 수 있어요.

### 입력창과 대화
- PDF·Office를 포함한 모든 파일을 드래그·붙여넣기로 첨부하고, `@파일`은 미리보기 카드로 보여요. 받아쓰기, `$` 스킬 선택, ⌃J/⌃U, Esc 두 번으로 초안 지우기가 돼요.
- 채팅 안에서 영상·음성이 재생되고, PDF 첫 페이지와 HTML 미리보기, 이미지 갤러리와 우클릭 메뉴가 생겼어요.
- 답변 속 파일 경로가 링크가 되고(해당 줄로 열림), 링크 우클릭 메뉴, 셸 코드 "터미널에서 실행"이 생겼어요.
- 마크다운: 각주, 체크리스트, GitHub 알림, 제목 앵커, 코드 줄바꿈, Mermaid 확대, 스트리밍 중에도 깔끔한 표시. 한국어 굵게와 한글이 붙은 URL도 맞게 보여요.
- 도구마다 터미널 omp와 같은 정보를 보여 주는 전용 화면이 늘었어요. 확장 UI(편집기, 여러 요청 대기, 상태 줄 등)와 터미널 전용 명령 처리도 고쳤어요.
- 같은 이벤트가 두 번 오거나 순서가 바뀌어도 단계가 "실행 중"으로 남지 않아요.
- 컨텍스트 들여다보기(무엇이 토큰을 차지하는지), 유휴 자동 압축, 목표 시간 제한이 생겼어요.

### 작업공간
- 변경 사항 패널에서 스테이징·커밋·푸시·풀·스태시·브랜치와 커밋 기록을 다루고, omp로 커밋 메시지를 만들어요. PR 병합·리뷰·편집, 이슈·Actions·릴리스·알림을 다루는 GitHub 탭이 생겼어요.
- 파일 패널에서 만들기·이름 바꾸기·휴지통, git 상태 표시, 내용 검색(⌥⌘F), 바로 편집(⌘S), 미리보기 탭이 생겼어요.
- 미리보기에 주소창, 확대, 기기 크기, 탭, PDF 저장, 콘솔이 생겼고, 에이전트가 미리보기 페이지를 직접 조작하고(지켜보고 넘겨받기 가능) 시각화를 띄워 의견을 받을 수 있어요.
- 터미널: 셸 고르기, 넓히기, 원격 탭 터미널, 에이전트가 터미널을 읽는 도구.
- SSH: 호스트 키 확인, 비밀번호 창, 포트 포워딩과 자동 재연결.

### 탭·세션·설정
- 동시에 여는 세션 수 제한을 없앤 데 이어 ⌘1–9, 최근 탭 전환(⌃⇥), 탭 한눈에 보기(⇧⌘A), 닫은 탭 다시 열기, 앞뒤 이동, 분할 칸 사이 이동이 생겼어요.
- ⌘P 파일 빠른 열기, ⇧⌘F 대화 내용 검색, 세션 보관·프로젝트 이동, 예약 실행, 사이드바 고정 바로가기가 생겼어요.
- 알림에 답변 첫 문장이 보이고 누르면 그 탭이 열려요. 알림음, 작업 중 잠자기 방지, 패널 왼쪽 배치, Windows 트레이로 닫기와 Mica 배경이 생겼어요.
- 지침 파일(AGENTS.md 등) 켜고 끄기, 에이전트 작업 폴더 정리, 플러그인 점검, 위험한 설정 확인 창, 원격 기기별 사용 한도가 생겼어요.

### 기타
- 일부 코드 경로 인식과 한글 마크다운 규칙은 mixdog(Apache-2.0)에서 가져와 NOTICE에 출처를 남겼어요.

<!-- en -->
Compared mixdog feature by feature (514 items) and built what the app alone can do; setup through daily work grew a lot.

### Setup and first run
- On first launch OMPdesk installs Bun and omp by itself (plus Git Bash on Windows) with progress, failure reasons and retry; `omp update` runs if omp is old. Git, GitHub CLI and Node.js install in the background. The Windows installer is one double-click, no admin prompt.
- Sign in to GitHub inside the app; empty git name/email are filled in. First-run steps survive a relaunch; a sidebar checklist, a guided tour of real buttons and a one-time "what's new" after updates were added.

### Accounts and models
- The code-paste card no longer appears in chat during subscription sign-in. Account limits that showed 0% are fixed and refresh every 30 s while visible, after each turn and on focus, with "updated N s ago" and time to reset.
- Added: delegation strength chip (Solo / Assisted / Collaborative / Swarm), profile, reply style, model overrides, recent models, Ultrafast, per-model compaction point. Usage-limit stops can resume automatically at the reset time.

### Composer and chat
- Attach any file (PDF, Office included) by drag or paste, `@file` preview cards, dictation, `$` skill picker, ⌃J/⌃U, double-Esc clears the draft. Video/audio play in chat; PDF first page, HTML preview, image gallery with context menu.
- File paths in replies are links that open at the line; link context menu; "run in terminal" for shell code. Markdown: footnotes, checklists, GitHub alerts, heading anchors, code wrapping, Mermaid zoom, clean streaming, Korean bold and URLs next to Hangul.
- More tools have dedicated views matching terminal omp; extension UI (editor, multi-request waits, status line) works; a duplicated or reordered event never leaves a step "running". Context inspector, idle auto-compaction and goal time limit added.

### Workspace
- The Changes panel stages, commits, pushes, pulls, stashes, branches and shows history, writes commit messages with omp; a GitHub tab covers PR merge/review/edit, issues, Actions, releases and notifications. Files: create, rename, trash, git status, content search (⌥⌘F), edit in place (⌘S), preview tabs.
- Preview gained an address bar, zoom, device sizes, tabs, save as PDF and a console; the agent can drive the preview page (you can watch or take over) and show visualizations. Terminal: shell choice, wider, remote tab terminals, a tool for the agent to read terminals. SSH: host-key check, password prompt, port forwards, auto-reconnect.

### Tabs, sessions, settings
- ⌘1–9, recent-tab switching (⌃⇥), tab overview (⇧⌘A), reopen closed tab, back/forward, moving between split panes. ⌘P quick open, ⇧⌘F chat search, session archive and project move, scheduled runs, pinned sidebar shortcuts.
- Notifications show the reply's first sentence and open that tab; sounds, keep-awake while working, left panel placement, close to tray and Mica on Windows. Toggle instruction files (AGENTS.md…), clean agent worktrees, plugin check, risky-setting confirmations, per-device usage limits.
- Some path recognition and Korean Markdown rules come from mixdog (Apache-2.0), credited in NOTICE.

## [0.28.1] - 2026-10-14

앱 동작은 바뀌지 않았어요. 개발과 검사 속도를 높인 버전이에요.

- 소스가 바뀌지 않았으면 이전 빌드를 다시 써서, 확인할 때마다 걸리던 빌드 약 8초가 사라졌어요.
- 여러 작업이 빌드 잠금을 얼마나 기다렸는지 기록하고 `bun run lock-stats`로 볼 수 있어요.
- 화면 테스트를 다듬어 전체 검사가 약 10초 빨라졌어요. 탭 수명 테스트는 프로세스 누수를 직접 세도록 바꿔 더 확실하게 잡아요.
- 0.28.0 기록에 빠졌던 내용: 탭으로 돌아오는 순간 이벤트 순서가 뒤바뀌면 작업 단계 하나가 계속 "실행 중"으로 남아 결과 줄이 나오지 않던 문제를 0.28.0에서 고쳤어요.

<!-- en -->
Nothing changes in the app. This release speeds up development and checks.

- An unchanged source tree reuses the previous build (about 8 s saved per check). `bun run lock-stats` shows how long jobs waited on the build lock. The full check is about 10 s faster.
- Missing from the 0.28.0 notes: a step left "running" forever when events reordered on returning to a tab was fixed in 0.28.0.

## [0.28.0] - 2026-10-14

앱 전체를 실제 사용 흐름(여러 단계를 이어서 쓰는 경우) 기준으로 한 번 더 점검하고 고쳤어요.

### 세션과 탭
- 동시에 열 수 있는 세션이 10개로 막혀 있던 제한을 없앴어요. 탭을 몇 개든 열 수 있고, 다시 켤 때 모든 탭이 복원돼요. 보이지 않는 탭은 열어 볼 때까지 omp를 띄우지 않아요.
- 실행 중이던 탭으로 돌아올 때 이전 단계가 한 프레임 보이던 것을 없앴어요.
- "새 탭으로 분기"가 "세션을 열 수 없어요"로 실패하던 것을 고쳤어요.
- 에이전트가 질문하는 중에는 제목 표시줄·사이드바·트레이가 "승인 필요" 대신 "입력 필요"로 보여요.

### 속도
- 세션 열기 약 185ms → 약 130ms, 설정 열기 약 315ms → 약 20ms로 빨라졌어요.
- 바뀐 파일이 많은 diff(800개 파일, 2만 줄)를 열 때의 끊김(최대 약 200ms 프레임)을 없앴어요.
- 세션이 500개일 때 사이드바 필터 입력이 가벼워지고, 스트리밍 중 화면 CPU가 약 100%에서 약 40%로 줄었어요.
- 단계가 수백 개인 끝난 작업 상자를 펼칠 때 끊기지 않아요. 터미널을 열지 않으면 터미널 코드를 불러오지 않아요.

### 작업 상자와 대화
- 계획을 제안하며 멈춘 턴이 "중단됐어요"로 보이던 것을 고쳤어요. 질문에 답을 기다릴 때는 "답변을 기다리고 있어요"로 보여요.
- 명령과 에이전트가 동시에 돌 때 실행 중인 명령 출력이 가려지지 않아요. 앱을 다시 켠 뒤 끊긴 작업의 시간이 맞게 보여요.
- 어드바이저·스킬·핸드오프 카드를 색 없는 테두리 카드로 바꿨어요. 분기 요약 카드에 요약 내용이 보여요.
- 아랍어·히브리어 문단이 오른쪽 정렬되고, 표 안의 단어가 중간에서 끊기지 않아요. 수식을 복사하면 기호가 두 번씩 붙지 않아요. 메시지를 복사할 때 시간이 같이 복사되지 않아요.
- 계획 승인 버튼이 한 번만 눌려요.

### 앱 화면
- 한국어 화면에서 편집·보기·창 메뉴와 입력칸 오른쪽 클릭 메뉴가 한국어로 보여요. 메뉴 이름을 화면 이름과 맞췄어요.
- 명령 팔레트에 빠져 있던 명령(프로젝트 열기, 탭 닫기, 사이드바·패널 토글 등)을 넣었고, 단축키를 바꾸면 팔레트에도 바뀐 단축키가 보여요.
- 알림에 마우스를 올려 두면 사라지지 않아요. 단축키로 연 설정·에이전트·통계에서 돌아오면 입력창으로 포커스가 돌아와요. 첫 실행 설정을 마치면 바로 입력할 수 있어요.
- 세션 이름 변경·삭제 뒤 포커스가 사라지지 않고, 새 세션을 열면 이전 제목이 남지 않아요. 페어링을 해제한 기기의 탭은 "페어링 해제됨"으로 보여요.

### 설정·패널
- 앱의 모든 탭에 영향을 주던 문제로, 세션을 지운 직후 통계·설정·패널에 "원래 세션이 교체됐어요" 오류가 뜨던 것을 고쳤어요.
- 파일 목록을 file-2, file-10 순서로 정렬해요. diff의 네 자리 줄 번호가 두 줄로 쪼개지지 않아요. 좁은 창에서도 PR 상세가 읽혀요.
- 백그라운드 작업을 취소해도 목록이 비지 않고, 이름을 "작업"으로 통일했어요.
- 기기 제거는 확인을 받아요. 페어링 코드 남은 시간이 맞게 보여요. 엔드포인트를 저장하면 저장한 항목으로 이동해요. 터미널 오류는 원문 대신 안내와 다시 시도 버튼으로 보여요.

<!-- en -->
The whole app was checked again against real multi-step workflows.

### Sessions and tabs
- The 10-open-session limit is gone: open any number of tabs and all of them are restored on relaunch. Tabs you have not looked at do not start omp until opened.
- No more flash of the previous step when returning to a running tab. "Branch into new tab" no longer fails with "can't open session". While the agent asks a question, the title bar, sidebar and tray say "input needed" rather than "approval needed".

### Speed
- Opening a session ~185 → ~130 ms, Settings ~315 → ~20 ms. Opening a diff of 800 files / 20k lines no longer hitches. With 500 sessions the sidebar filter is light, and streaming CPU fell from ~100% to ~40%.

### Work card and chat
- A turn that stopped to propose a plan no longer reads "interrupted"; waiting on an answer reads "waiting for your answer". A running command's output is no longer hidden while agents run. Advisor, skill and handoff cards became colorless bordered cards. RTL paragraphs align right, table words do not break mid-word, copied math no longer doubles, copied messages no longer include the time. Plan approval fires once.

### App
- Edit/View/Window menus and the text-field context menu are Korean in the Korean UI. The palette gained the missing commands (open project, close tab, toggle sidebar/panel) and shows rebound shortcuts. Toasts stay while hovered. Focus returns to the composer after Settings/Agents/Stats opened by shortcut, and after renaming/deleting a session.

### Settings and panels
- After deleting a session, Stats/Settings/panels no longer show "the original session was replaced". File lists sort naturally (file-2 before file-10), four-digit diff line numbers stay on one line, PR detail reads in narrow windows. Cancelling a background job no longer empties the list. Removing a device asks first; pairing code time left is correct; terminal errors show guidance and a Retry button.

## [0.27.0] - 2026-10-13

앱 전체를 영역별로 여러 번 점검하고 고쳤어요. 긴 대화와 실행 중 화면이 훨씬 가벼워졌고, 작업 상자가 실행 중과 다시 열었을 때 똑같이 보여요. README도 새로 썼어요.

### 스크롤과 성능
- 긴 대화를 위로 스크롤할 때 버벅임이 사라졌어요. 36MB짜리 세션 기준으로 가장 긴 프레임이 약 120ms에서 50ms 아래(약 25~42ms)로, 화면 CPU 사용량이 약 58%에서 약 36%로 내려갔어요. 위쪽 기록이 붙을 때 화면이 튀던 것도 없어졌어요.
- 원인 중 하나는 분할 화면 틀이 매 프레임 높이를 다시 재면서 모든 작업 상자의 스타일을 두 번씩 다시 계산하던 것이었어요. 끝난 작업 상자는 스크롤로 나타날 때 등장 애니메이션을 하지 않아요.
- 에이전트가 여럿 도는 동안 입력창 타이핑, 탭 전환, 패널 열기에서 생기던 끊김(50~79ms 프레임)을 없앴어요. 탭 전환은 약 85ms에서 약 50ms로 빨라졌어요.

### 작업 상자
- 모델의 다음 응답을 기다리는 사이에 멈추면 "작업을 완료했어요"로 나오던 것을 "중단됐어요"로 고쳤어요.
- 첫 도구 호출 때 작업 상자가 새로 그려지면서 머리 문구가 깜빡이던 것을 없앴어요. 처음 생각할 때부터 끝날 때까지 같은 상자로 이어져요.
- 실행 중에는 안 보이고 다시 열었을 때만 보이던 할 일 알림과 백그라운드 작업 완료 줄이 이제 실행 중과 다시 연 뒤에 똑같이 보여요.
- 머리 아래 줄이 에이전트 이름을 두 번 말하지 않고, 생각만 하는 단계에도 시계가 돌아요. "N단계 진행" 안내는 실행 중일 때만 보여요. 코드 단계는 "JavaScript 실행"처럼 읽혀요.
- 출력이 있었던 명령에 "출력 없이 N초째"라고 잘못 알리던 것, 읽기 단계 아래에 파일 마지막 줄이 보이던 것, 도구를 아직 안 쓴 레인에 "도구 0개"가 보이던 것을 고쳤어요.
- omp의 "Backgrounded as job …" 안내가 옆으로 긴 한 줄로 보이던 것을 "백그라운드 작업 bg_1" 메모로 바꿨어요. 백그라운드 작업 줄은 종류를 말로 보여 주고 이름을 한 번만 써요.
- 어드바이저 등급(사소함·우려·블로커)을 한국어로 보여 주고, IRC 노트에 시간이 두 번 나오지 않아요. 화면 캡처 썸네일 아래에 페이지 주소가 짧게 보여요.
- 화면 읽기 프로그램이 지켜보던 작업이 어떻게 끝났는지 알려 주고, 레인 버튼이 펼침 상태를 알려 줘요.

### 앱 화면
- 좁은 칸(2×2 분할 등)에서 모델 선택 버튼이 사라지던 것을 고쳤어요. 이름이 안 들어가면 아이콘으로 보여요.
- 앱을 다시 켰을 때 입력창이 가끔 "모델 선택 / 끔"으로 나오던 것을 고쳤어요.
- 메뉴와 팝오버가 창 밖으로 나가거나 자기 버튼을 가리던 것을 고쳤어요.
- 명령 팔레트, 테마·분기·세션 선택, 가져오기 창의 검색창을 같은 모양으로 맞췄어요. 긴 프로젝트 경로는 가운데를 줄여서 끝부분이 보여요. 도움말의 변경 기록 창 이름을 "새로운 기능"으로 맞췄어요.
- 세션 이름을 바꿀 때 아래 행이 밀리지 않아요. 입력칸 이름에 도움말 문장이 섞여 읽히지 않아요.

### 설정·통계·패널
- 앱 최소 크기에서도 설정 메뉴 이름, 탭 줄, 버튼, 경로가 잘리거나 옆으로 넘치지 않아요.
- 한국어 화면에서 모델 역할 이름이 한국어로 보여요. 검색에서 "rea"로 기본 REA 줄을 찾을 수 있어요.
- 메모리를 끈 상태는 빨간 오류 대신 "메모리 백엔드: 꺼짐" 한 줄로 보여요.
- 통계 서버가 응답하지 않으면 1분 반 동안 로딩만 돌던 것을 몇 초 안에 알려 주고, 늦게 뜨면 새로고침 없이 채워져요. 상단 탭 이름을 "활동"으로 바꿨어요. 요청 상태를 말로, 숫자와 금액을 자릿수 구분해서, 모델 이름을 한 줄로 보여 줘요.
- SSH 호스트·MCP 서버·스킬·플러그인이 비었을 때 추가 버튼이 두 번 나오거나 "0 / 0"이 보이던 것을 고쳤어요. 업데이트 실패 문장과 페어링 오류에서 코드 원문이 보이지 않아요.
- 파일·로그 패널의 숫자에 단위가 붙고, 세션 트리의 도구만 쓴 턴이 빈 카드로 보이지 않아요. 잘린 경로는 마우스를 올리면 전체가 보여요.
- "미리 보기"와 "미리보기"가 섞여 있던 한국어 표기를 통일했어요.

### 문서
- README를 사용자 기준으로 새로 썼어요.

<!-- en -->
- Two reasons a long chat stuttered while scrolling up are gone: the split frame re-measured height every frame, and finished cards animated in on scroll. On a 36 MB session the longest frame fell from ~120 ms to under 50 ms and CPU from ~58% to ~36%.
- Typing, tab switches and opening panels no longer hitch while several agents run; tab switches went from ~85 ms to ~50 ms.

### Work card
- A turn stopped while waiting for the model's next response reads "interrupted", not "completed". The card no longer redraws on the first tool call, so the header no longer flickers.
- Todo reminders and background-job results now look the same while running and after reopening. Header lines no longer repeat the agent name, thinking-only steps keep a clock, code steps read like "Run JavaScript".
- Fixed: "no output for N s" on commands that had output, a last file line under read steps, "0 tools" on idle lanes. omp's "Backgrounded as job …" becomes a "background job bg_1" note. Advisor severity shows in Korean; screenshot thumbnails show a short page URL.
- Screen readers hear how a watched job ended; lane buttons announce their expanded state.

### App
- The model picker no longer vanishes in narrow panes (2×2 splits); it shows an icon when the name does not fit. The composer no longer sometimes shows "Model: off" after relaunch.
- Menus and popovers no longer leave the window or cover their button. Search fields across the palette and pickers match; long project paths shorten in the middle.

### Settings, stats, panels
- At the minimum window size nothing in Settings is cut off or scrolls sideways. Model role names are Korean in the Korean UI. A stopped memory backend is one line, not a red error.
- A stats server that does not answer is reported within seconds (not after 90 s) and fills in when it starts late. The top tab is "Activity". Empty SSH/MCP/skill/plugin lists no longer show two add buttons or "0 / 0".
- README rewritten for users.

## [0.26.3] - 2026-10-13

- 서브에이전트가 읽은 스크린샷이 작업 상자 결과에서 깨진 그림과 파일 경로로 보이던 것을 고쳤어요. omp가 이미지 데이터를 따로 보관해 두는데 앱이 그 참조를 풀지 못하고 있었어요. 이제 실제 그림이 보이고, 데이터가 지워진 이미지는 파일 이름 칩으로 보여요. 원격 탭은 그 컴퓨터에 보관된 이미지를 읽어요.
- 대화의 첨부 이미지와 도구 카드 이미지도 데이터가 없으면 깨진 그림 대신 칩으로 보여요.

<!-- en -->
- A subagent's screenshots no longer show as broken images in work card results; the app now resolves omp's separately stored image data. Images whose data is gone show a file-name chip. Remote tabs read images stored on that computer.

## [0.26.2] - 2026-10-13

- 세션을 다시 열면 omp의 할 일 안내("You stopped with N incomplete todo item(s)…")가 답변 사이에 글자 그대로 보이던 것을 고쳤어요. 실행 중과 같이 "할 일 알림" 줄로 보여요. omp가 모델에게만 보내는 다른 안내(체크포인트 경고 등)는 화면에 보이지 않아요.
- 백그라운드로 넘어간 명령이 나중에 실패하면(예: 종료 코드 3) 초록 체크 대신 실패로 표시하고, 그 명령을 시작한 작업 상자도 "1개 실패"가 돼요.
- 작업 상자 머리에 "Subagent CiSpeed" 같은 도구 이름 대신 "CiSpeed 실행 중"처럼 읽을 수 있는 문장이 보여요. 머리 아래 빈 줄에는 지금 단계의 명령이나 마지막 출력 줄이 보여요.
- 입력창 ↑는 비어 있거나 커서가 맨 앞일 때, ↓는 커서가 맨 끝일 때만 이전·다음 입력을 불러와요. 불러온 뒤에는 같은 방향으로 계속 넘길 수 있어요.
- 앱을 켤 때 상태 정보가 가끔 빠져서 계획 승인 버튼 등이 다음 턴까지 비활성으로 남던 것을 고쳤어요.
- 긴 대화를 위로 스크롤할 때 덜 끊겨요(가장 긴 멈춤 약 140ms → 약 100ms, 다시 그리는 행 9~10개 → 2개). 맨 위에서 이전 기록이 더 불러와지지 않고 멈추던 것도 고쳤어요.

<!-- en -->
- Reopened sessions show omp's todo reminder as a "todo reminder" row instead of raw text; other model-only notices stay hidden.
- A background command that fails later (e.g. exit code 3) shows as failed, and the card that started it counts "1 failed".
- Work card headers read "CiSpeed running" instead of "Subagent CiSpeed"; the line under the header shows the current command or last output line.
- Composer ↑ recalls history only when empty or the caret is at the start, ↓ only at the end; once recalling, keep going the same way.
- A startup state race that left plan approval buttons disabled until the next turn is fixed.
- Scrolling long chats up stutters less (longest pause ~140 ms → ~100 ms), and loading earlier history no longer stalls at the top.

## [0.26.1] - 2026-10-13

- 사이드바에 "(no messages)" 행이 남아 지워지지 않던 것을 고쳤어요. 마지막 채팅을 지우면 omp가 다음 세션 파일을 미리 만들어 두는데, 이 빈 파일이 대화처럼 목록에 올라와서 지울 때마다 다시 생겼어요. 이제 메시지가 하나도 없는 세션은 목록에 보이지 않아요(이미지만 보낸 대화는 그대로 보여요).
- 작업 중에 방향 조정을 보내도 작업 상자가 둘로 갈라지지 않아요. 방향 조정은 그 상자 안에 "방향 조정" 줄로 남고, 서브에이전트 레인과 단계가 한 상자에서 이어져요. 새로 불러온 세션도 똑같이 보여요. 진행 중으로 보이는 상자는 항상 맨 아래 하나뿐이에요.
- 단계 줄이 두 줄로 넘치지 않고 한 줄에서 가로로 스크롤돼요. 단계가 바뀔 때 이전 화면이 새 화면 뒤로 비쳐 보이던 것을 고쳤어요.
- 파일을 고치는 중에 편집 명령 원문(`[파일#태그] …`)이 그대로 보이던 것을 고쳤어요. 파일 이름과 작업만 보여 줘요.
- **작업 상자를 다시 다듬었어요** (실제 omp로 39가지 문제를 찾아 고쳤어요).
  - 단계마다 화면이 한 번만 바뀌어요. 도구 이름과 빈 화면이 먼저 끼어들던 것을 없앴어요. 머리 높이가 오르내리지 않고, 끝날 때 한 번의 전환으로 접히며 스크롤 위치도 유지돼요.
  - 무대는 출력이 있는 에이전트만 따라가고 2초 이상 머물러요. 내가 연 레인은 빼앗지 않아요.
  - 끝난 레인에 에이전트의 실제 결론이 보여요(omp 18.10.2의 평문 결과 포함). 결론 노트가 레인과 중복되지 않아요. 다시 열어도 레인·할 일·결과 숫자가 실행 중과 같아요.
  - 요약 숫자는 메인과 서브에이전트를 합쳐 한 가지 기준으로 세요. 실패한 항목이 결과 맨 위에 오고, 경로는 프로젝트 기준으로 보여요. 사용자가 멈춘 것은 어디서나 "중단"이에요.
  - 머리 시계는 실행 전체 시간이에요. 대기 중에는 빈 스피너 대신 상자 머리가 먼저 나와요.
  - 터미널의 명령 줄이 위에 고정되고, `[Wall: … | Timeout: …]` 원문 대신 배지로 보여요. 좁은 창과 2×2 분할 화면에서도 잘리지 않아요.
  - 파일을 고치거나 쓰는 동안 무대가 바뀌는 줄로 자동으로 스크롤돼요. 직접 스크롤하면 그 단계에서는 따라가지 않아요.
  - 단계 줄은 Tab 한 번으로 들어가 화살표로 움직여요.
- 토큰 속도를 "50/초" 대신 "50 tok/s"로 표기해요(한국어도 같아요).
- 입력창에서 ↑는 비어 있거나 커서가 맨 앞일 때만 이전 입력을 불러와요. 여러 줄을 쓰는 중에는 커서만 움직여요.
- 사이드바의 세션 들여쓰기를 줄였어요.
- 서브에이전트가 일할 때 앱이 덜 무거워요. 서브에이전트 이벤트를 모아서 보내고(초당 123번 → 21번), 계속 도는 애니메이션을 가볍게 바꿔 실행 중 CPU 사용량을 줄였어요.
- 노트 시간은 "3분 전"처럼, "방금"은 1분이 될 때까지 보여요.

<!-- en -->
- The sidebar no longer keeps a "(no messages)" row: sessions with no messages (the empty file omp pre-creates) are hidden; image-only chats still show.
- A steer sent mid-run no longer splits the work card in two; it stays inside as a "steer" row, and only the bottom card ever looks in progress. Reloaded sessions look the same.
- The work card was reworked after 39 problems found with the real omp: one screen change per step, stable header height, one fold at the end, lanes show agents' real conclusions, one counting rule, failed items first, a pinned command line, badges instead of `[Wall: … | Timeout: …]`, auto-scroll while files are edited, Tab to enter the steps and arrows to move.
- Token rates read "50 tok/s". Sidebar session indentation is tighter. Subagents are lighter on CPU (events batched 123/s → 21/s). Note times read "3 min ago".

## [0.26.0] - 2026-10-13

작업 상자가 고정된 무대 안에서 흐르듯 이어지고, 오른쪽 패널이 터미널·미리보기까지 갖춘 작업 공간이 됐어요. 리버스 엔지니어링 도구 REA가 기본으로 들어가고, 쓰지 않는 코드를 크게 걷어냈어요.

### 작업 상자
- **높이가 고정된 무대**: 첫 출력이 나오면 상자 안에 일정한 높이의 무대가 열리고, 턴이 끝날 때까지 그 높이가 바뀌지 않아요. 단계가 바뀌면 같은 자리에서 이전 화면이 서서히 사라지고 새 화면이 나타나요. 제목 문장도 같은 방식으로 바뀌어요. 출력이 나오기 전에는 빈 상자를 띄우지 않아요.
- 동시에 도는 호출은 무대 위쪽 한 줄에 작은 버튼으로 나란히 보여요. 서브에이전트 레인은 무대 위에 있고, 레인을 누르면 그 에이전트의 화면이 무대에 떠요. 고르지 않으면 가장 최근에 움직인 에이전트를 따라가되, 깜빡이지 않도록 3초보다 자주 바꾸지 않아요. 에이전트가 많으면 레인 목록 안에서 스크롤돼요.
- 작업 중에 도착한 에이전트 메시지(IRC), 어드바이저 노트, 백그라운드 작업 결과가 대화 사이에 따로 끼지 않고 그 작업 상자 안에 조용한 노트로 들어가요. 최근 두 개만 보이고, 누르면 펼쳐져요.
- 끝난 작업도 모두 같은 모양의 작은 작업 상자로 보여요.
- 모델이 도구를 부르는 중일 때(서브에이전트 레인 포함) 터미널에 명령 없이 `$`만 보이던 것을 고쳤어요. 받은 조각을 omp와 같은 방식으로 읽어서 명령이 들어오는 대로 보여요. 덜 받은 작업 설명이 제목에 반쪽 단어로 나오던 것도 고쳤어요.
- 실행 중인 시계는 1초가 지나면 "1s", "2s"처럼 초 단위로 보여요. "0ms", "810ms"처럼 보이던 것을 없앴어요. "방금"은 1분이 될 때까지 유지돼요.
- 다음 턴의 할 일 기록이 이전 작업 상자에 붙던 것을 고쳤어요.

### 오른쪽 패널
- Claude 데스크톱처럼 위쪽에 터미널·변경 사항·미리보기·파일 아이콘이 있고, ⋮ "보기 옵션"에서 백그라운드 작업·계획·로그·대기열·트리를 골라요. 각 화면의 버튼은 그 화면의 도구 줄에 있어요.
- **터미널**: 프로젝트 폴더에서 로그인 셸이 열리는 진짜 터미널이에요. 여러 개를 탭으로 열 수 있고, 복사·붙여넣기·지우기, 끝난 뒤 다시 시작을 지원해요. omp에 들어 있는 터미널 엔진을 그대로 써서 앱에 따로 추가한 네이티브 모듈이 없어요. 원격 기기 탭에서는 쓸 수 없다고 안내해요.
- **미리보기**: 개발 서버 페이지를 패널 안 브라우저로 열어요. 주소 입력, 뒤로·앞으로·새로고침·중지, 외부 브라우저로 열기를 지원하고, 명령 출력의 localhost 주소를 누르면 바로 열려요. 페이지는 앱과 완전히 분리된 공간에서 열려요.
- **계획**: 지금 세션의 계획을 단계와 함께 패널에서 보고 승인·의견을 보낼 수 있어요.
- **백그라운드 작업**: 실행 중인 작업의 출력이 실시간으로 보이고, 취소할 수 있어요.
- 아홉 화면 모두 도구 줄, 빈 상태, 좁은 폭, 밝음·어두움을 같은 기준으로 다듬었어요.

### 기본 탑재 REA
- 리버스 엔지니어링 도구 [REA](https://github.com/morluto/rea)가 OMPdesk 세션에 기본으로 붙어요(설정 › 도구와 확장 › MCP에서 끌 수 있어요). 앱과 웹사이트, 바이너리를 분석해야 할 때 모델이 알아서 써요. 사용자의 omp 설정은 건드리지 않고, 터미널에서 쓰는 omp에는 붙지 않아요.
- 모델에게는 REA 도구 170개를 다 보여 주지 않아요. 자주 쓰는 도구 15개와 "REA 도구 찾기"·"REA 도구 실행" 두 개만 보여 주고, 나머지는 필요할 때 찾아서 써요. 그래서 세션마다 늘어나는 내용이 약 45KB에서 4KB 남짓(약 1k 토큰)으로 줄었어요.
- Node.js 22.19 이상(또는 24.11 이상)이 있어야 해요. 없으면 설정에 그렇게 보여 줘요. 처음 쓸 때 패키지를 내려받느라 몇 초 걸려요.

### 고친 것
- 할 일이 남아 omp가 턴을 이어서 실행하면, 턴이 끝난 뒤 그 턴의 내 메시지와 앞부분 작업이 대화에서 사라지던 것을 고쳤어요. omp가 마지막 실행분만 보내도 앞서 받은 메시지를 함께 확정해요.
- 앱이 막 켜지는 중에 에이전트·통계·설정 페이지를 열면 첫 세션 정보가 도착하는 순간 대화 화면으로 튕기던 것을 고쳤어요.
- 세션 앞부분이 큰 세션도 사이드바에 제목이 보여요. 지금까지는 "(no messages)"로 보였어요.
- 대화 왼쪽 목차의 "이전 대화 불러오기" 화살표를 없앴어요. 위로 스크롤하면 알아서 불러와요.
- 설정 화면에서 영어로 남아 있던 설정 21개와 선택지 문구 126개를 한국어로 옮겼어요. 시트 안의 드롭다운에서 Esc를 누르면 드롭다운만 닫혀요.
- omp 연결이 실패하거나 연결 중에 닫힐 때 처리되지 않은 오류가 남던 것을 고쳤어요. 같은 기능을 여러 번 쓰면 내부 이벤트 처리기가 계속 쌓이던 것도 고쳤어요.

### 정리
- 쓰이지 않는 코드, 중복 구현, 남은 설정·번역 키를 걷어냈어요. omp에 이미 있는 기능을 다시 구현하던 곳은 omp를 직접 쓰거나 omp와 같은지 확인하는 테스트를 붙였어요. 화면에 보이는 동작은 바뀌지 않아요.

<!-- en -->
The work card now flows inside a fixed-height stage, the right panel became a full workspace (terminal and preview included), the reverse-engineering toolkit REA ships built in, and a lot of unused code is gone.

### Work card
- A fixed-height stage opens once the first output arrives and keeps its height until the turn ends; the previous view fades out in place when the step changes. No empty card before there is output.
- Parallel calls sit as small buttons on one row above the stage; subagent lanes sit above it and a click puts that agent on stage. Unpicked, it follows the most recently active agent, at most every 3 s.
- Agent messages (IRC), advisor notes and background job results that arrive mid-run become quiet notes inside the card instead of separate rows; the last two show, a click expands.
- A tool call still streaming no longer shows a bare `$` in the terminal. Running clocks read "1s", "2s" instead of "810ms".

### Right panel
- Terminal, Changes, Preview and Files icons on top; the ⋮ "View options" menu holds Background tasks, Plan, Logs, Queue and Tree. A real login-shell terminal (tabs, copy/paste, restart) built on omp's own engine, no extra native module. Preview opens dev servers in an isolated in-panel browser. Plan and background tasks (live output, cancel) show in the panel.

### Built-in REA
- REA, a reverse-engineering toolkit, is attached to OMPdesk sessions by default (turn it off under Settings › Tools & extensions › MCP). The model sees 15 common tools plus "find REA tool" and "run REA tool" instead of all 170 (about 4 KB instead of 45 KB per session). Needs Node.js 22.19+ (or 24.11+).

### Fixes
- A turn omp continued for leftover todos no longer drops your message and earlier work after it ends.
- Opening Agents, Stats or Settings while the app is starting no longer bounces you back to the chat.
- Sessions with a large head show their title in the sidebar; 21 settings and 126 option labels are translated to Korean; Esc in a sheet dropdown closes only the dropdown.
- Unhandled errors on a failed or closing omp connection and a leak of internal event handlers are fixed. Unused code and duplicate implementations were removed; nothing visible changes.

## [0.25.1] - 2026-10-12

- 작업 상자에서 파일을 지우거나 옮기는 단계의 화면이 비어 보이던 것을 고쳤어요. 이제 "삭제"나 "이동"과 파일 이름, 옮긴 곳(`old.ts → new.ts`)이 보여요. diff가 있는 편집은 지금처럼 diff만 보여 줘요.

## [0.25.0] - 2026-10-12

작업 상자 하나에 한 번의 작업이 모두 담기고, 단계 사이가 끊기지 않고 이어져요.

- **작업 상자가 한곳이 됐어요**: 할 일 진행률(막대와 지금 할 일), 목표, 서브에이전트 레인, "N단계 · 토큰 · 속도" 요약 줄이 모두 작업 상자 안에 있어요. 작업 중에는 입력창 위의 할 일·목표 카드가 비켜 주고, 에이전트 칩은 없앴어요. 할 일 줄을 누르면 그 자리에서 목록이 펼쳐지고, `/todo edit`도 그 줄을 열어 줘요. omp가 남은 할 일을 상기시키면 접힌 줄에도 보여요.
- **동시에 하는 일이 한눈에 보여요**: 명령이나 도구가 동시에 돌면 "N개 동시 진행 중"과 함께 한 줄씩 나란히 보여요. 줄을 눌러 그 화면으로 바꿔도 목록과 시계는 그대로 살아 있어요.
- **단계가 자연스럽게 넘어가요**: 모델이 다음 단계를 생각하는 동안 방금 끝난 단계의 화면이 흐리게 남아 있다가 다음 단계로 바뀌어요. 바뀔 때는 높이가 부드럽게 늘고 줄며, 새 화면과 제목이 미끄러지듯 들어와요. 출력이 흐르는 동안에는 높이가 출렁이지 않아요. 레인도 부드럽게 펼쳐지고 닫히며, 지금 하는 일이 바뀌면 그 글자만 바뀌어요. 동작 줄이기 설정을 켜면 움직임이 모두 꺼져요.
- **명령·파일 화면을 다듬었어요**: 터미널은 명령 한 줄과 종료 상태 하나만 보여 주고 같은 명령을 다시 찍지 않아요. 편집·읽기·검색·웹 검색·eval 화면에서 상자 제목과 겹치던 머리글을 없앴고, 큰 diff는 가장 최근에 바뀐 곳을 보여 줘요. 브라우저·화면 캡처는 상자 안에 다 들어오게 맞췄어요.
- **실패, 중단, 완료를 섞지 않아요**: 요약 줄, 상자 머리, 레인, 결과가 같은 규칙으로 상태를 정해요. 사용자가 멈춰서 끊긴 명령은 실패가 아니라 "중단"으로 보이고, 멈추기 전에 이미 실패한 명령은 그대로 실패로 남아요. 따로 돌던 서브에이전트가 실패하거나 취소되거나 프로세스가 사라지면 묶음이 "완료"로 보이지 않아요.
- 서브에이전트 레인의 경과 시간과 "출력 없이 N초째" 경고가 돌아왔어요. 차례를 기다리는 에이전트는 실행 중이 아니라 빈 고리로 보이고, 레인에서는 `yield` 단계를 숨겨요. 화면 읽기 프로그램은 경과 시간을 매초 읽지 않고, 오래 멈췄을 때만 한 번 알려 줘요.
- 할 일을 바꿀 때마다 작업 묶음이 둘로 갈라지던 것을 고쳤어요. 작업이 끝날 때 할 일 카드가 답변 위로 끼어들며 답변을 밀어내던 것도 없앴어요.
- 결과에서 같은 파일을 쓰고 고친 경우 한 번만 세고, 줄 수에 마지막 줄바꿈을 더하지 않아요. 같은 작업 안에서 새로 만들었다고 확인된 파일을 지우면 결과에서 빠지고, 그 밖의 파일을 지우면 "삭제됐어요"로 남아요. 작업이 만들거나 읽은 이미지는 결과에 썸네일로 보여요(4장까지, 나머지는 눌러서).
- 분할 화면의 작은 칸에서도 레인이 상태·이름·지금 하는 일·시간을 한 줄로 보여 줘요.
- 빈 세션 안내 문구의 줄바꿈, 아주 좁은 분할 칸의 시작 카드를 다듬었고, 한국어 화면의 "Vibe"를 "바이브"로 바꿨어요.

## [0.24.1] - 2026-10-12

실제 omp로 서브에이전트 두 개를 돌려 보고 어색했던 부분을 고쳤어요.

- 서브에이전트가 막 시작할 때 레인에 모델에게 준 지시문 원문("Complete assignment thoroughly: # Target …")이 보이던 것을 "시작하는 중…"으로 바꿨어요.
- 서브에이전트 레인 아래에 같은 내용("AlphaCounter 실행 중")을 한 번 더 보여 주던 목록을 없앴어요. 레인은 항상 omp가 정한 순서대로 나와요.
- 에이전트만 일하는 동안 묶음 제목이 "기타 1단계"로 보이던 것을 "에이전트 2개 작업 중"으로 고쳤어요.
- 끝난 작업 상자의 제목은 최종 답변의 첫 문장을 마크다운 기호 없이 보여 줘요. 지금까지는 마지막 문장(보통 덧붙인 주의 사항)이 `백틱`째로 보였어요.
- 레인을 펼친 채로 작업이 끝나도 결과(바뀐 파일, 명령)가 보여요.
- 중단된 작업이 "작업을 완료했어요"와 체크 표시로 보이던 것을 "작업이 중단됐어요"로, 실패한 작업은 "작업이 실패했어요"로 고쳤어요. 취소된 서브에이전트 레인도 같아요.
- 작업 상자 머리에 시간이 두 번 나오던 것을 하나로 합쳤어요. 지금 단계의 경과 시간을 보여 주고, 출력 없이 오래 걸리는 명령은 그 자리에 "출력 없이 N초째 실행 중"이 떠요.

## [0.24.0] - 2026-10-12

- **작업 상자를 새로 만들었어요**: 빈 큰 상자, 번호 붙은 칩, "실시간" 표시를 모두 없앴어요.
  - 맨 위 한 줄에 상태 점과 지금 하는 일, 경과 시간이 보여요. 생각 중이거나 기다리는 중이면 그 아래에 마지막 생각 문장이나 "누구를 기다리는지"가 한 줄로 나와요. 출력이 없는 단계는 빈 상자를 그리지 않아요.
  - 서브에이전트는 한 줄짜리 레인으로 나란히 보여요: 상태, 이름, 지금 하는 일(끝나면 결론), 도구·토큰·시간. 레인을 누르면 그 바로 아래에 해당 에이전트의 터미널·파일 화면이 펼쳐져요.
  - 명령·파일 화면은 내용만큼만 커지고, 아래 단계 줄은 아이콘만 조용히 보여요. 지난 단계를 눌러 다시 볼 때만 "지금 단계로" 버튼이 나타나요.
  - 끝나면 "결과" 줄에 바뀐 파일(+n −n), 명령 개수, 실패 개수만 보여 주고, 펼치면 파일과 명령을 성공/실패 표시와 함께 보여 줘요. 에이전트 결론은 레인에 있어서 결과에 다시 적지 않아요.
  - 분할 화면의 작은 칸에서는 레인이 이름 알약으로 줄어들어 칸의 절반 안에 들어가요.
- 모든 단계가 중단된 묶음이 "0단계 완료"로 보이던 것을 "N개 중단 · N단계"로 고쳤어요.
- 새 세션 시작 카드, 분할 창 머리글, 대화 상자 제목의 간격과 크기를 다듬었어요.

## [0.23.2] - 2026-10-11

- 예전 입력 기록을 omp 기록으로 옮길 때, omp에 이미 있는 입력은 다시 기록하지 않아요. 지금까지는 옮길 때마다 그 입력의 시각이 "지금"으로 바뀌어서 오래된 입력이 ↑ 목록 맨 위로 올라오고 사용 횟수도 부풀었어요. 이제 omp에 없던 입력만 옮겨요.

## [0.23.1] - 2026-10-11

- 입력창에서 ↑로 이전 입력을 불러오지 못하고 "명령 실패"가 뜨던 문제를 고쳤어요. 예전 입력 기록을 omp 기록으로 옮긴 뒤 설정에서 지우는 단계가 매번 실패해서, 앱을 켤 때마다 옮기기를 처음부터 다시 하고 오래된 입력이 최근 입력보다 위로 올라왔어요. 이제 한 번만 옮기고 끝나요.

## [0.23.0] - 2026-10-11

- **작업 상자가 메인과 서브에이전트를 함께 보여 줘요**: 맨 위에 지금 하는 일이 한 줄로 크게 보이고(omp가 알려 주는 의도 그대로), 그 아래 메인과 서브에이전트가 카드로 나란히 놓여요. 카드마다 지금 하는 일, 도구 수, 토큰, 경과 시간이 실시간으로 바뀌고, 누르면 그 에이전트의 터미널·파일·검색 화면이 상자 안에 펼쳐져요. 끝난 뒤에도 지난 단계를 다시 볼 수 있어요.
- **작업 결과 요약**: 끝나면 고친 파일(`+n −n`), 실행한 명령과 성공 여부·걸린 시간, 서브에이전트별 결론을 한눈에 보여 줘요. 모두 성공했는데 "1개 실패"로 보이던 문제도 고쳤어요.
- **멈춘 것처럼 보이지 않게**: 생각 중에는 생각의 마지막 문장이 흐리게 흐르고, 오래 걸리는 명령은 경과 시간과 "출력 없이 N초째 실행 중"이, 서브에이전트를 기다릴 때는 누구를 기다리는지가 보여요.
- **의미 있는 움직임만**: 실행 중인 줄의 커서, 새로 들어온 줄의 짧은 강조, 단계 전환, 진행 중 카드의 은은한 표시만 넣었어요. 움직임 줄이기 설정을 켜면 모두 꺼져요.
- **따라잡기**: 다른 칸이나 탭을 보다 돌아오면 "자리를 비운 동안 N단계 진행"이 뜨고, 누르면 그 단계들을 빠르게 다시 보여 줘요.
- 서브에이전트 세부 화면은 omp가 실시간으로 보내는 이벤트를 그대로 써요. 펼친 카드만 받고, 접으면 요약만 받아요.

## [0.22.0] - 2026-10-10

- **채팅 안에서 작업을 실시간으로 보여 줘요**: 실행 중인 단계 상자가 한 줄짜리 목록 대신, 에이전트가 지금 하는 일을 그 자리에서 보여 줘요.
  - 명령 실행은 터미널처럼 출력이 흘러나오고, 파일 쓰기·수정은 편집기처럼 내용과 바뀐 부분이, 브라우저·컴퓨터 제어는 최신 스크린샷이, 검색·읽기는 대상과 첫 결과가 보여요. 서브에이전트는 각자 지금 하는 일이, 반복되던 "대기" 줄은 경과 시간이 있는 한 줄로 합쳐져요.
  - 아래 단계 줄에서 지난 단계를 눌러 다시 보고, "실시간"으로 현재 단계로 돌아와요. 분할 화면의 작은 칸에서도 내용과 버튼이 잘리지 않아요.
- 위로 스크롤해 이전 메시지를 불러오는 사이 새 메시지가 오면, 경계에 걸린 이전 메시지 몇 개가 화면 기록에서 빠질 수 있던 문제를 고쳤어요.

## [0.21.0] - 2026-10-10

- **긴 세션이 빨리 열려요**: 세션을 열 때 대화 전체를 받지 않고 최근 메시지(약 200개, 대화 턴 단위)만 먼저 보여 줘요. 위로 스크롤하면 이전 메시지를 이어서 불러오고, 보던 위치는 그대로 유지돼요. 대화 목차나 세션 트리에서 오래된 메시지로 이동해도 필요한 만큼 불러와요.
  - 약 3,300개 메시지 세션 기준: 열리는 시간 약 0.84초 → 0.42초, 주고받는 데이터 약 18.7MB → 3.5MB, 화면 메모리 약 37MB → 16MB.
- 배포 중 가끔 앱 창이 뜨지 않아 테스트가 멈추던 문제와, 모델 설정 도우미 테스트가 가끔 시간 초과되던 문제를 고쳤어요(앱 동작은 같아요). 테스트로 띄운 앱이 메뉴 막대 아이콘이나 `omp://` 링크 처리기를 건드리지 않게 했어요.

## [0.20.3] - 2026-10-10

- **메시지를 보낼 때 뜨던 "명령 실패" 알림 정리**: 보낸 메시지를 입력 기록(↑로 다시 불러오는 목록)에 저장하는 일은 사용자가 시킨 명령이 아닌데, 저장이 실패하면 "명령 실패"로 알렸어요. 이제 알리지 않고 기록 파일에 남겨요. 메시지 전송에는 영향이 없었고, 저장에 실패한 메시지도 이번 실행 동안은 ↑로 다시 불러올 수 있어요.
- **실패 알림을 기록으로 남겨요**: 화면에 뜬 오류 알림의 제목과 실제 원인을 `~/Library/Application Support/ompdesk/logs/gui-runtime.jsonl`(Windows는 `%APPDATA%\ompdesk\logs`)에 남겨, 알림이 사라진 뒤에도 원인을 확인할 수 있어요.

## [0.20.2] - 2026-10-10

- **입력창에 긴 초안이나 이미지가 있을 때도 질문 카드가 칸 안에 보여요**: 0.20.1은 입력창이 비어 있을 때만 맞았어요. 이제 질문·승인 카드는 입력창의 현재 크기(여러 줄 초안, 첨부 이미지)를 실제로 재서 남은 공간에 맞춰 줄어들어요. 카드가 떠 있는 동안에는 초안 입력칸이 두 줄로 줄고 스크롤돼요(초안은 그대로 남아 있고, 카드가 닫히면 다시 커져요).
- 배포를 가끔 멈추게 하던 모델 설정 도우미 테스트의 시간 제한을 고쳤어요(앱 동작은 같아요).

## [0.20.1] - 2026-10-10

- **4분할에서 긴 질문이 잘리던 문제 수정**: 화면을 2×2로 나눈 상태에서 선택지가 많은 질문이나 긴 승인·계획 카드가 뜨면, 칸 높이를 넘어 답변 버튼과 입력창이 칸 밖으로 잘렸어요. 이제 카드가 칸 높이에 맞춰 줄어들고 안쪽만 스크롤돼서, 답변 버튼과 입력창이 항상 보여요.

## [0.20.0] - 2026-10-10

- **"RPC timeout (8000ms): history_record" 오류 수정**: 긴 세션의 대화 기록을 불러오는 동안 OMPdesk와 omp 사이의 연결이 수 초씩 막혀서, 그 뒤에 기다리던 입력 기록 저장이 시간 초과로 실패하던 문제를 고쳤어요. 대화 기록은 이제 작은 단위로 나눠 주고받고, 받는 쪽 처리도 길이에 비례하도록 바꿨어요. 긴 세션(약 3,300개 메시지)에서 기록 저장이 약 0.9초에서 수십 ms로, 대화 기록 불러오기도 빨라졌어요.
- **화면 분할 최대 4개**: 세션을 끌어다 놓아 2개, 3개, 4개(2×2 등)까지 나란히 볼 수 있어요. 4개일 때 놓으면 그 칸의 세션이 바뀌어요.
- **분할 칸 제목에 프로젝트 이름**: 각 칸 위에 `프로젝트 › 세션 제목`으로 보여요. 전체 경로는 프로젝트 이름에 마우스를 올리면 보여요.
- **분할 화면의 모든 칸이 완전히 동작**: 선택하지 않은 칸의 세션이 묻는 질문, 승인 요청, 계획 승인이 그 칸에 바로 보이고 그 자리에서 답할 수 있어요. 오류·재시작 안내도 칸마다 따로 보여요.
- **앱 전반 다듬기**: 사이드바(행 정렬, 긴 이름, 선택·배지), 대화(코드·diff 가독성, 인라인 코드, 간격, 키보드 포커스, 움직임 줄이기), 창·메뉴·검색 창(같은 구조와 간격, 포커스 표시), 에이전트·통계·사용량·첫 실행 화면(정렬, 좁은 화면, 차트 색)을 Claude 앱처럼 차분하게 정리했어요.

## [0.19.0] - 2026-10-10

- **omp 18.8.7 이상이 필요해요**: OMPdesk가 직접 흉내 내던 기능을 omp 자체 구현으로 바꾸면서 최소 버전을 올렸어요. 그보다 낮으면 `omp update` 후 앱을 다시 켜 주세요.
- **오른쪽 사이드 패널을 Claude 앱처럼 정리**: "사이드 패널" 제목 줄과 탭 두 줄 대신 보기 전환 메뉴와 동작 버튼이 있는 헤더 한 줄이에요.
  - 변경 사항: 파일마다 아이콘·상태·`+n −n` 줄 수가 보여요. diff는 줄바꿈된 깔끔한 화면에 이전/다음 파일 이동이 있고, 패널을 넓히면 목록과 diff가 나란히 보여요.
  - 파일·로그·대기열·트리·백그라운드 화면도 같은 모양으로 맞췄어요.
- **설정 재구성**: 13개 섹션을 11개(일반, 화면 및 입력, 단축키, 모델과 계정, 에이전트 동작, 도구와 확장, 권한 및 보안, 프로젝트 및 실행, 기기 및 연결, 업데이트 및 정보, 기타 설정)로 다시 묶었어요.
  - 같은 설정이 여러 곳에서 따로 편집되던 문제를 없애고, 설정마다 편집하는 곳을 한 곳으로 정했어요. 검색하면 바로 그곳으로 가요.
  - 이 기기 설정과 호스트 설정을 구분해서 보여 줘요.
  - 프로바이더 한도 추가 메뉴가 열리자마자 닫히던 문제를 고쳤어요.
- **omp와 같은 동작으로 통일**: OMPdesk가 따로 만들어 쓰던 부분을 omp의 실제 구현을 그대로 쓰도록 바꿨어요.
  - 세션 목록의 상태 표시가 정확해졌어요. 오류·중단된 응답이나 응답 없는 도구 호출을 더 이상 "완료"로 보이지 않아요.
  - 대화 기록, 세션 트리, 분기, 세션 삭제, worktree 위치, PR 체크아웃, 세션 이동 경로, 프로바이더 목록, models.yml 검사, 계정 매칭, 초기화권 판정, 로그아웃, 스킬·플러그인·에이전트·MCP 목록, 읽기 묶음, 토큰 속도도 omp 구현을 따라요.
  - 입력 기록을 터미널 omp와 함께 써요. 원격 탭은 호스트의 기록을 써요.
  - 초기화권은 omp가 허용하면 한도에 닿기 전에도 쓸 수 있어요.
  - `/명령:인자` 형식과 대소문자를 omp와 같게 처리해요.

## [0.18.2] - 2026-10-10

- **macOS 업데이트 후 권한 요청이 다시 뜨지 않아요**: 지금까지는 빌드마다 서명이 달라서 macOS가 업데이트된 OMPdesk를 다른 앱으로 보고, 폴더 접근·로컬 네트워크 같은 권한을 업데이트할 때마다 다시 물었어요. 이제 모든 릴리스를 OMPdesk 전용 인증서 하나로 서명해서 한 번 허용한 권한이 다음 업데이트에도 그대로 유지돼요. 이 버전으로 처음 업데이트할 때만 마지막으로 한 번 더 물어봐요.

## [0.18.1] - 2026-10-10

- **릴리스 파일을 정확히 두 개로**: v0.17.x에서 넘어오기 위한 예전 업데이트 파일(`latest*.yml`, zip, 버전이 붙은 설치 파일)을 더 이상 올리지 않아요. 릴리스에는 `ompdesk-mac-arm64.dmg`와 `ompdesk-windows-setup.exe`만 있어요.
- **worktree를 안전하게 정리**: 세션을 닫거나 앱을 끌 때 omp가 제때 종료되지 않으면, 아직 쓰고 있을 수 있는 worktree를 지우지 않고 남긴 뒤 알려 줘요.

## [0.18.0] - 2026-10-10

- **새 π 로고**: 앱 아이콘, 메뉴바 아이콘, 앱 안 로고, 워드마크를 omp와 같은 π 모양으로 바꿨어요. 왼쪽 다리 끝의 보라색 발이 OMPdesk 표시예요.
- **릴리스 파일이 Mac·Windows 두 개로**: GitHub 릴리스에는 `ompdesk-mac-arm64.dmg`와 `ompdesk-windows-setup.exe`만 올라가요(이번 한 번은 이전 버전이 업데이트할 수 있도록 예전 업데이트 파일도 함께 올라가요). 앱 업데이트는 릴리스 노트에 숨겨 둔 정보로 파일을 확인하고, macOS는 DMG를 받아 확인한 뒤 교체해요. 포터블 exe는 더 이상 만들지 않아요.
- **README 개편**: 맨 위에 macOS·Windows 다운로드 버튼을 넣고, 지금 기능에 맞게 전부 다시 썼어요.
- **계정 초기화권**: 설정의 계정 목록과 사용량 화면에 계정별 초기화권 개수와 만료일이 보이고, "초기화권 사용"으로 확인한 뒤 한 장을 쓸 수 있어요. 지금 쓸 수 없으면 이유와 함께 버튼이 꺼져 있어요. 원격 탭에서는 그 기기의 계정에 적용돼요.
- **omp 18.8.x 최신 기능 지원** (최신 omp에서만 보이고, 18.8.0에서는 아무것도 바뀌지 않아요):
  - 새 세션마다 worktree 자동 생성·정리(`worktree.onStart`/`onExit`): 터미널 omp와 같은 규칙으로 동작하고, 수정 중이거나 푸시하지 않은 작업은 묻지 않고 지우지 않아요.
  - 모델별 압축 시점: 모델 및 프로바이더에 편집기가 생기고, 모델 선택과 모델 역할에 "압축 시점"이 보여요.
  - 서브에이전트 계정 제한: 에이전트별로 쓸 수 있는 계정을 체크로 고르고, 계정마다 식별 키를 복사할 수 있어요.
- **SVG·Mermaid 미리보기**: 답변의 SVG 코드 블록과 .svg 파일 작성은 그림으로(스크립트·외부 참조는 제거), .mmd/.mermaid 파일 작성과 파일 패널은 다이어그램으로 보여요. 코드 보기로 바꿀 수 있어요.
- **대기열 조작**: 대기 중인 메시지를 하나씩 빼거나 "지금 보내기"로 바로 끼워 넣을 수 있고, 중단하면 대기 중이던 메시지가 입력창으로 돌아와요(터미널 omp의 Esc와 같아요).
- **분할 미리보기**: 세션을 끌어 화면을 나눌 때, 라벨 상자 대신 새 창이 들어갈 자리가 반투명하게 미리 보이고 커서 옆에 세션 이름이 따라와요.
- **입력창 개선**: 포커스 때 보라색 테두리 대신 차분한 그림자, 원형 보내기·중단 버튼, 항상 보이는 첨부 삭제 버튼, 이미지를 끌어 놓을 때 반투명 안내가 생겼어요.
- 테스트로 띄운 앱이 로그인 키체인을 쓰지 않아요(배포용 러너에서 멈추던 문제).

## [0.17.4] - 2026-10-09

- **macOS 배포 작업을 개발 Mac에서 실행**: 앱 동작은 바뀌지 않아요. 배포할 때 macOS 패키징과 점검을 GitHub의 macOS 서버(분당 요금이 가장 비싼) 대신 개발 Mac에서 돌려서, 배포 한 번의 GitHub Actions 비용이 절반 아래로 줄어요. 개발 Mac이 꺼져 있을 때는 GitHub의 macOS 서버로 배포할 수 있어요. 워크플로가 쓰는 외부 액션은 모두 특정 커밋으로 고정했어요.

## [0.17.3] - 2026-10-09

- **배포 비용 추가 절감**: 앱 동작은 바뀌지 않아요. 배포 한 번에 쓰는 GitHub Actions 시간을 약 3분의 1로 줄였어요. 운영체제마다 작업을 하나로 합쳐 설치·빌드를 한 번만 하고, 운영체제와 무관한 검사는 가장 싼 Linux에서 돌려요. macOS에서는 빠른 핵심 점검과 실제 omp 연동 점검만 하고, 전체 화면 테스트는 배포 전에 개발 Mac에서 돌려요. 일반 push 검사는 Linux 한 곳에서만 돌고, 문서만 바뀐 push는 검사하지 않아요.

## [0.17.2] - 2026-10-09

- **채팅의 마지막 세션을 지우면 "제목 없음"이 계속 생기던 문제를 고쳤어요**: omp가 첫 메시지 전에 새 세션 파일을 만드는데, 사이드바가 이것을 저장된 대화로 보고 "제목 없음"으로 보여 줬어요. 그걸 지우면 또 새 세션이 생겨 끝없이 반복됐어요. 이제 메시지가 없는 세션은 열려 있으면 "새 세션"으로(삭제 버튼 없음) 보이고, 열려 있지 않으면 목록에 나오지 않아요. 원격 기기 목록도 같아요.

## [0.17.1] - 2026-10-09

- **배포 파이프라인 비용 절감**: 앱 동작은 바뀌지 않아요. 일반 push·PR 검사는 Linux와 Windows에서 돌고, macOS 검사는 배포할 때만 돌아요. 배포 커밋은 배포 워크플로에서 한 번만 검사하고, 빌드 패키지 임시 보관은 1일(시험 배포는 7일)로 줄였어요. 받는 파일은 GitHub Release에 그대로 남아요.

## [0.17.0] - 2026-10-09

- **채팅에서도 모든 도구 사용**: 채팅 세션도 에이전트 세션처럼 omp의 모든 도구(파일 읽기·수정, 명령 실행, 웹 검색, 서브에이전트 등)를 써요. 프로젝트 폴더만 정해지지 않은 상태라서, OMPdesk 기본 작업 폴더에서 실행돼요. 입력창의 모드(계획 등)와 승인 방식, 할 일 카드, 사이드 패널의 모든 탭, 모든 명령도 채팅에서 똑같이 쓸 수 있어요. 채팅은 계속 사이드바의 채팅 목록에 따로 보여요.
- 새 채팅이 그때 보고 있던 프로젝트 폴더에서 열리던 문제를 고쳤어요. 이제 항상 기본 작업 폴더에서 열려요.

## [0.16.1] - 2026-10-09

- **AUTO 추론이 모델의 최대 단계까지**: OMPdesk에서 여는 세션은 AUTO가 고를 수 있는 추론 강도의 상한을 omp 기본(xhigh)에서 모델이 지원하는 최대(max)까지 넓혔어요. 설정에서 직접 상한을 정했다면 그 값을 따르고, 터미널의 omp는 그대로예요.
- **어드바이저도 AUTO 추론**: 어드바이저 모델을 고르면 메인 에이전트가 턴마다 고른 추론 강도를 따라가도록 저장해요. 예전에는 omp 기본 동작대로 항상 '보통'으로 돌았어요.
- **모델 구성 도우미가 직접 만든 역할을 덮지 않아요**: 자동 구성은 omp의 기본 역할(기본·빠른·생각·계획·어드바이저 등)만 제안하고, 직접 만든 역할(예: 서브에이전트용 역할)은 그대로 둬요.

## [0.16.0] - 2026-10-09

- **모델 구성 도우미**: 설정 › 모델 및 프로바이더의 "자동으로 구성"에서 연결된 계정의 모델 중 여러 개를 고르면, 고른 조사 모델이 최신 벤치마크를 웹에서 찾아보고 역할별(기본·빠른·생각·계획·어드바이저 등) 배치와 어드바이저 켜기 여부를 이유·출처와 함께 제안해요. 표에서 고친 뒤 "적용"을 눌러야 바뀌고, 바뀐 역할만 저장해요. 조사는 그 모델의 사용량과 웹 검색을 써요(웹 검색·읽기만 허용, 파일 수정 없음). 마지막 제안은 기기별로 남아서 다시 열면 바로 볼 수 있어요. 원격 탭에서는 그 기기에서 조사하고 적용해요.
- **어드바이저 설정이 한 화면에서**: 설정 › 기능 › 어드바이저 행에서 켜면 바로 아래에서 어드바이저 모델을 고를 수 있고, 모델이 없어 실행되지 않으면 그 자리에서 알려 줘요. `/advisor on`에서 모델이 없다는 알림에도 "자동으로 구성" 버튼이 붙어요.
- **추론 강도 기본값 AUTO**: 직접 정하지 않았다면 OMPdesk에서 여는 세션은 omp의 AUTO 추론(작업 난이도에 맞춰 강도 자동 조절)으로 시작해요. 설정 파일은 바꾸지 않아서 터미널의 omp는 그대로이고, 설정에서 직접 고른 값이 있으면 그 값을 따라요.

## [0.15.0] - 2026-10-09

- **오피스 문서 미리보기**: 사이드 패널 파일 탭에서 Word(.docx), Excel(.xlsx), PowerPoint(.pptx)를 열 수 있어요.
  - Word: 패널 폭에 맞춰 읽기 좋게 보여 주고, "페이지 레이아웃"으로 바꾸면 실제 페이지 모양과 확대·축소를 써요. 문서 안의 외부 링크·이미지는 불러오지 않아요.
  - Excel: 시트 탭으로 시트를 바꿔 보고, 숫자·날짜·퍼센트 형식대로 보여 줘요(최대 1000행·50열).
  - PowerPoint: 슬라이드마다 제목·본문·이미지와 발표자 노트를 카드로 보여 주는 간단 미리보기예요(레이아웃은 그대로 재현하지 않아요).
  - 예전 형식(.doc·.xls·.ppt)은 아직 "기본 앱으로 열기"만 돼요.
- **업데이트 확인이 제자리에서**: 앱 메뉴의 "업데이트 확인…"을 누르면 설정으로 넘어가지 않고, 사이드바 아래 카드에 "업데이트 확인 중…" → "최신 버전이에요"(몇 초 뒤 사라짐) 또는 받는 진행률·"재시작해서 업데이트"·실패(다시 확인)가 바로 나와요. GitHub 접근이 없을 때만 업데이트 설정으로 가는 버튼이 나와요.
- **설정 › 모델 및 프로바이더 개편**: 연결된 프로바이더만 한 줄씩 보이고, 눌러서 펼치면 계정별 남은 한도가 막대로 보여요. 연결 안 된 프로바이더는 "프로바이더 추가" 아래로 접었고, models.yml 엔드포인트는 따로 섹션이 생겼어요. 모델 비교는 기본으로 접혀 있고, 불러오기 실패는 큰 경고 상자 대신 한 줄 안내와 다시 시도로 바뀌었어요.
- **계정 순환 방식 2가지**: 모델 및 프로바이더에서 고를 수 있어요.
  - 한도 순환(기본): 남은 한도가 많은 계정을 먼저 쓰고, 초기화가 가까운 계정부터 소진해요.
  - 균등 순환: 새 세션마다 계정을 번갈아 써서 사용량을 고르게 나눠요. 한도에 닿은 계정은 건너뛰고, 한 세션 안에서는 계정을 바꾸지 않아요.
  - 원격 탭에서는 그 기기의 설정을 바꿔요.

## [0.14.0] - 2026-10-08

- **사이드 패널 파일 뷰어**: 파일 탭에서 여는 파일을 종류에 맞게 보여 줘요.
  - 코드: 문법 강조, 줄 번호, 줄 바꿈 전환. 큰 파일은 "더 불러오기"로 2MB까지 읽어요.
  - 마크다운·HTML: 렌더링/원문 전환. HTML은 스크립트가 막힌 샌드박스에서 보여 줘요.
  - PDF: 페이지를 바로 보여 주고 확대·축소할 수 있어요.
  - 이미지: 크기 표시와 확대 보기. 오디오·비디오는 바로 재생돼요.
  - CSV·TSV는 표로, JSON·JSONL은 보기 좋게 정리해서, Jupyter 노트북은 셀과 출력까지 보여 줘요.
  - 그 밖의 바이너리 파일은 16진수 미리보기와 "기본 앱으로 열기"를 보여 줘요. Office 문서(docx·xlsx·pptx)도 아직 여기에 해당해요.
  - 파일 트리에 종류별 아이콘이 붙고, 미리보기 위의 넓히기 버튼으로 패널을 크게 볼 수 있어요. 원격 탭에서는 그 기기의 파일을 보여 줘요.
- **채팅 이미지 확대가 채팅 영역 안에서 열려요**: 이미지를 누르면 창 전체가 아니라 그 채팅 영역만 덮어서, 사이드바와 사이드 패널이 그대로 보여요.
- **사이드바 상태가 실시간으로 바뀌어요**: 보고 있지 않은 세션의 "승인 필요"(플랜 승인 요청)와 서브에이전트 수가 그 세션을 눌러야만 갱신되던 문제를 고쳤어요.

## [0.13.0] - 2026-10-08

- **원격 탭에서는 그 기기의 설정**: 원격 기기에서 돌아가는 탭을 보고 있을 때 설정을 열면, 맨 위에 "Host B의 설정이에요" 안내와 함께 그 기기의 설정이 나와요. 제공자·계정, 모델과 models.yml 사용자 제공자, 권한, 기능, 확장, 플러그인, 프로젝트 폴더, SSH 호스트, omp 버전·업데이트, 사용량, 통계, 벤치마크가 모두 그 기기 기준이에요. 모양·단축키·언어·앱 업데이트·원격 기기처럼 이 기기에 속한 설정은 메뉴에 모니터 아이콘으로 표시돼요. 그 기기가 꺼져 있으면 예전 값 대신 "오프라인" 안내가 나와요. 로컬 탭으로 돌아가면 이 기기 설정이 다시 보여요.
- **원격 기기에 로그인**: 원격 탭에서도 Claude 등에 로그인할 수 있어요. 브라우저는 이 기기에서 열리고, 로그인이 끝난 뒤 주소창의 주소(`http://localhost…?code=…`)를 붙여 넣으면 그 기기에 로그인돼요. 화면에 안내가 나와요.
- 원격 탭에서 로그인·bash·플랜 승인·PR 체크아웃처럼 오래 걸리는 명령이 거부되던 문제를 고쳤어요.
- 브라우저 로그인 중에 로그인 버튼이 "키 페이지 열기"로 잘못 바뀌던 문제를 고쳤어요.

## [0.12.0] - 2026-10-08

- **남은 팝업도 카드로**: 짧은 입력, 긴 글 편집, 링크 열기, 플랜 승인 창도 이제 화면을 가리는 팝업이 아니라 입력창 위 카드로 나와요. 플랜은 카드 안에서 스크롤해서 읽고, 실행·압축 후 실행·현재 맥락 유지·저장·수정 요청·닫기를 숫자 키로 고를 수 있어요. 긴 글은 ⌘↵로 보내고 ↵는 줄바꿈이에요. 승인 버튼에 처음부터 초점이 가지 않아요.
- **대화 언어 직접 선택**: 설정 › 일반 › 대화 언어에서 자동(기기 언어), 한국어·영어·일본어·중국어(간체/번체)·스페인어·프랑스어·독일어·포르투갈어·베트남어, 또는 "지정 안 함"을 고를 수 있어요. 바꾸면 열려 있는 세션의 다음 답변부터 바로 적용돼요.
- **원격 사용 중 잠자기 방지**: 다른 기기가 이 컴퓨터를 쓰는 동안(연결돼 있거나 작업이 돌고 있는 동안) 잠자기를 막아요. 설정 › 원격 기기에서 끌 수 있고, 지금 누가 쓰고 있는지도 보여요. 사용이 끝나면 1분 뒤 풀려요.
- **업데이트 화면이 더 빨리 떠요**: 앱 업데이트 결과가 omp 업데이트 확인(느린 네트워크에서 최대 1분)을 기다리지 않고 바로 나와요.

## [0.11.0] - 2026-10-08

- **원격 기기**: 다른 컴퓨터에서 작업을 돌릴 수 있어요. 양쪽에 OMPdesk를 설치하고, 작업할 컴퓨터에서 설정 › 원격 기기의 "다른 기기에서 이 컴퓨터 사용 허용"을 켜면 연결 코드(`XXXX-XXXX`, 10분 유효)가 나와요. 이 컴퓨터에서 "기기 연결"을 누르면 같은 네트워크의 기기가 자동으로 보이고(Tailscale 등은 주소를 직접 입력), 코드를 넣으면 연결돼요. 사이드바에 그 기기의 프로젝트와 세션이 따로 보이고, 거기서 연 세션은 그 컴퓨터의 omp·파일·git·로그인으로 돌아가요. 탭에는 기기 이름이 표시되고, 연결이 끊기면 "다시 연결 중"을 보여 준 뒤 돌아오면 이어서 써요(그쪽 세션은 10분 동안 유지). 연결은 기기별 키로 암호화·인증되고, 연결한 기기는 언제든 해제할 수 있어요.
- **계정 여러 개와 자동 순환**: 설정 › 제공자에서 Claude·ChatGPT 계정을 여러 개 추가할 수 있어요. 계정마다 남은 한도(5시간·주간), 지금 쓰는 계정, "HH:MM까지 제한" 상태가 보이고, omp가 남은 한도에 맞춰 계정을 번갈아 써요. 계정을 하나씩 뺄 수 있고, 사용량 화면도 계정별로 나뉘어요.
- **대화 기본 언어 자동 설정**: 기기 언어를 읽어서 에이전트가 기본으로 그 언어로 답해요. 다른 언어로 말을 걸면 그 언어로 답하고, 코드·커밋 메시지는 프로젝트 언어를 따라요. 영어 기기에서는 아무것도 바뀌지 않아요.
- **"모델 응답을 기다리는 중… N초" 경고 줄 제거**: 오래 기다려도 경고 문구와 버튼 없이 작은 스피너만 보여요.

## [0.10.0] - 2026-10-08

- **질문이 한 번에 하나씩**: 에이전트가 여러 질문을 하면, 모든 질문을 한 화면에 늘어놓고 스크롤하던 방식 대신 Claude 앱처럼 한 질문씩 보여 줘요. 위에 단계 표시(답한 질문은 ✓, 눌러서 다시 가기)와 "2/3" 같은 진행이 나오고, 하나를 고르면 바로 다음 질문으로 넘어가요. 마지막 질문에서 "제출"을 누르면 모든 답이 함께 가요. 여러 개 고르는 질문은 고른 뒤 "다음"을 눌러요.
- **숫자 키로 바로 고르기**: 선택지마다 번호가 붙어 있고, 1~9 키로 바로 고를 수 있어요. ↑/↓로 이동, Esc는 취소예요. 직접 입력은 그대로 있고, 메모는 "메모 추가"를 눌렀을 때만 나와요.
- **확인·선택·도구 승인도 같은 카드로**: 화면을 가리던 팝업 대신, 입력창 바로 위에 같은 모양의 카드로 나와요. 대화 내용을 보면서 답할 수 있어요. 도구 승인은 1=허용, 2=거부이고, 실수로 허용되지 않도록 처음 초점은 허용 버튼에 가지 않아요.

## [0.9.3] - 2026-10-08

- **업데이트를 건너뛰면 더 이상 받을 수 없던 문제 수정**: 받아 둔 업데이트(예: 0.9.1)를 설치하지 않은 채 다음 버전(0.9.2)을 받으려 하면, 받아 둔 업데이트를 지우는 단계에서 실패해 오류만 뜨고 어떤 업데이트도 받을 수 없었어요. 앱 묶음 안의 `app.asar` 파일 때문에 정리가 중간에 멈췄던 거예요. 이제 남은 파일을 끝까지 지우고, 혹시 하나를 못 지워도 새 업데이트 받기는 계속 진행돼요.

## [0.9.2] - 2026-10-07

- **ChatGPT 계정을 연결하는 즉시 이미지 생성 켜짐**: 0.9.1은 탭을 새로 열거나 모델 목록을 다시 불러올 때만 이미지 생성 도구를 켰어요. 이제 설정이나 `/login`으로 계정을 연결하는 순간, 열려 있는 모든 탭에서 바로 켜져요. 로그아웃하면 바로 꺼지고, 다시 시작할 필요가 없어요.

## [0.9.1] - 2026-10-07

- **연결된 계정으로 이미지 생성 자동 사용**: omp의 이미지 생성 도구는 기본으로 꺼져 있어서, ChatGPT 계정이 연결돼 있어도 "이미지 만들어 줘"라고 하면 쓸 수 없었어요. 이제 이미지를 만들 수 있는 계정(예: ChatGPT 로그인의 gpt-image-2)이 연결돼 있으면 OMPdesk가 이미지 생성 도구를 자동으로 켜요. Claude로 대화하는 중에도 이미지 생성은 그 계정으로 해요. 로그인하거나 로그아웃하면 바로 반영되고, omp 설정 파일(config.yml)은 바꾸지 않아요. 설정 › 도구에서 직접 끄면 그 선택을 따라요.

## [0.9.0] - 2026-10-07

- **대화 속 이미지 확대**: 대화 기록의 이미지(첨부 이미지, 답변 속 그림, 스크린샷, 생성 이미지, 도구 결과 이미지)를 누르면 창 크기로 크게 보여요. 한 번 더 누르면 원래 크기로 보고 스크롤할 수 있어요. Esc나 바깥을 누르면 닫혀요.
- **업데이트를 더 빨리 확인**: 새 버전 확인 주기를 4시간에서 5분으로 줄였어요.
- **사이드바 업데이트 알림을 한 줄로**: 아이콘, "0.9.0 업데이트 준비됨", 재시작 버튼, 닫기만 남긴 한 줄로 바꿨어요. 자세한 설명은 마우스를 올리면 보여요. 설치 프로그램을 받는 중이면 줄 아래에 진행 막대가 나와요.

## [0.8.1] - 2026-10-07

- **설정 검색 입력이 엉뚱한 칸으로 가던 문제 수정**: 검색 결과를 누른 직후 바로 다시 검색어를 치면, 늦게 옮겨 간 포커스 때문에 글자가 방금 연 설정 칸(시스템 프롬프트 등)에 들어갈 수 있었어요. 이제 이미 다른 곳에 입력 중이면 포커스를 옮기지 않아요.
- **계획 넘기기(prewalk) 취소 수정**: 한 번 취소하면 앱을 다시 켤 때까지 모든 세션에서 prewalk가 꺼져 있던 문제를 고쳤어요. 이제 그 세션의 대기 중인 넘기기만 취소해요.
- **남은 오류 문구도 한국어로**: 통계, 설정 저장, 외부 편집기, 모델 비교, 사용자 프로바이더, 업데이트 토큰 저장 등에서 나오던 영어 오류가 이유를 알려 주는 한국어 문장으로 나와요. 토큰 저장이나 omp 재시작 실패처럼 아무 표시 없이 지나가던 실패도 이제 알려 줘요.
- **긴 세션에서 더 가볍게**: 도구 기록이 쌓여도 도구 이벤트 하나를 처리하는 비용이 늘지 않도록 바꿨어요(5만 개 기준 약 90µs → 1µs 미만). 끝난 도구 결과를 두 벌씩 들고 있지 않아 메모리도 줄었어요.
- **다른 탭 시나리오 자동 검사 추가**: 질문 창, 계획 승인, 완료 알림, 추천 프롬프트, 서브에이전트 목록을 실제 앱으로 검사하는 테스트를 추가했어요.

## [0.8.0] - 2026-10-07

**omp 18.7 이상이 필요해요.** 18.7 미만이면 `omp update`를 실행하세요.

### 다른 탭에서 작업 중인 세션
- **질문·확인 창이 사라지지 않아요**: 화면에 없는 탭의 에이전트가 질문이나 확인을 요청하면 그 요청이 버려져서, 에이전트가 계속 "실행 중"으로 멈춰 있던 문제를 고쳤어요. 이제 그 탭으로 가면 창이 그대로 떠 있고, 사이드바에는 그 세션에 확인 필요 표시가 나와요.
- **계획 승인 카드 복구**: 계획 모드 탭이 뒤에서 계획을 끝내도, 돌아오면 승인 카드가 나타나요.
- **도구 카드가 계속 돌던 문제 수정**: 작업 중인 탭으로 돌아왔을 때, 그 사이 끝난 도구 단계가 결과 없이 회전 상태로 남던 문제를 고쳤어요.
- **"재시도 중…", "자동 정리 중…" 표시 정리**: 뒤에서 끝난 재시도·정리 표시가 돌아온 뒤에도 남아 있지 않아요.
- **작업 완료 알림**: 다른 탭의 작업이 끝나거나 실패하면 데스크톱 알림이 와요. 알림 제목에는 그 세션의 이름이 나와요.

### 사이드바·입력창
- **서브에이전트 목록은 기본으로 접혀요**: 세션 줄 오른쪽의 서브에이전트 개수 표시를 누르거나, 지금 열린 세션을 한 번 더 누르면 펼쳐지고 접혀요. →/← 키도 돼요. 펼친 목록은 왼쪽 여백을 줄이고, 세션에서 이어지는 선으로 연결돼 보여요. 경과 시간은 "10m"처럼 짧게 보여요.
- **입력창 위 서브에이전트 표시**: "서브에이전트" 글자를 빼고 아이콘과 개수만 보여요.
- **추천 프롬프트가 사라지지 않아요**: 추천을 받아 쓰다가 지우거나, 글자를 입력했다가 지우거나, 다른 세션에 갔다가 돌아와도 추천이 다시 나타나요. 메시지를 보내거나 새 작업이 시작될 때만 사라져요.

### 업데이트·안정성
- **Windows 자동 업데이트도 실행 중인 작업을 확인**: 설치 전에 종료 확인을 받고, 탭 구성을 저장한 뒤 다시 시작해요.
- **업데이트 다운로드 수정**: 다운로드 중에 업데이트 화면을 열면 두 번 동시에 받아져 파일이 깨지던 문제와, 받다가 멈추면 앱을 다시 켤 때까지 재시도하지 않던 문제를 고쳤어요.
- **워크트리 탭 닫기 수정**: 탭을 닫을 때 그 탭이 만든 워크트리만 지워요. 지금 열린 세션의 폴더를 잘못 지우는 일이 없어요.
- **omp 연결 회복**: 시작할 때 상태 확인이 한 번 실패해도 탭이 계속 "오류"로 남지 않고 다시 연결돼요. omp가 갑자기 꺼져도 앱 오류 창이 뜨지 않아요.

### 속도
- 서브에이전트를 여럿 돌릴 때와 답변이 길 때 화면이 버벅이던 문제를 줄였어요. 앱이 omp와 주고받는 데이터와 화면을 다시 그리는 횟수를 크게 줄였어요.
- 세션 목록은 변경 한 번에 한 번만 다시 불러와요. 변경 사항 패널과 제목 표시줄도 필요할 때만 계산해요.
- 예전에 중단된 도구 호출 때문에 실행 시간이 몇 시간씩으로 보이던 문제를 고쳤어요.

### 문구
- 오류 알림과 화면 안 오류가 영어 원문 대신 한국어 설명으로 나와요. 원문은 아래에 작게 보여요. "세션이 실행 중이에요"처럼 이유가 분명한 오류는 그 이유를 바로 알려 줘요.
- 외부 편집기 안내, bash 출력 잘림 안내, 입력 대기 알림을 한국어로 보여 줘요. 날짜와 숫자는 앱 언어 형식으로 나와요.
- 남아 있던 중국어 문구와 쓰이지 않는 번역 135개를 정리했어요.

## [0.7.0] - 2026-10-07

- **중국어 UI 제거**: 화면 언어는 English와 한국어 두 가지만 남았어요. 언어 버튼은 두 언어 사이를 오가고, 중국어로 설정해 두었다면 시스템 언어(한국어 또는 English)로 바뀌어요. 모델이 쓴 중국어 글자는 그대로 잘 보여요.
- **다른 탭에서 작업 중인 세션의 회전 표시 복구**: 선택하지 않은 세션이 작업 중일 때 사이드바의 회전 애니메이션이 사라지고, 눌러야 다시 나오던 문제를 고쳤어요. 그 세션 아래 서브에이전트 줄도 함께 보여요.
- **"모델 응답을 기다리는 중…" 오표시 수정**: 다른 탭에서 작업 중인 세션으로 돌아왔을 때, 모델이 이미 답변이나 긴 도구 호출(큰 파일 작성 등)을 쓰고 있는데도 "아직 응답이 없어요. 네트워크 문제일 가능성이 높아요" 경고가 몇 분씩 떠 있던 문제를 고쳤어요. 이제 진행 중인 답변을 바로 이어서 보여 줘요.

## [0.6.0] - 2026-10-07

- **앱 이름 표기를 OMPdesk로**: 메뉴 막대, 앱 메뉴, 창 제목, 사이드바, 트레이, 설치된 앱 이름(OMPdesk.app)과 안내 문구가 모두 OMPdesk로 바뀌어요. 설정·로그인 정보·업데이트는 그대로 이어져요.
- **앱 메뉴에 "업데이트 확인…"**: macOS 앱 메뉴(Windows는 도움말 메뉴)에서 바로 업데이트를 확인할 수 있어요. 누르면 설정 › 업데이트가 열리고 확인을 시작해요. 앱 메뉴의 영어 항목(정보, 서비스, 가리기, 종료 등)도 한국어·중국어로 나와요.
- **서브에이전트가 세션 바로 아래에**: 사이드바의 "서브에이전트" 묶음 대신, 실행 중인 서브에이전트가 그 세션 아래 줄로 바로 붙어요. 누르면 그 서브에이전트의 실시간 기록이 열려요. 끝난 서브에이전트는 목록에서 바로 사라져요.
- **입력창 위 서브에이전트 표시를 작게**: 넓은 배너 대신 할 일 카드 옆에 "서브에이전트 N" 작은 칩만 보여요. 마우스를 올리면 실행·완료·실패 개수가 나오고, 누르면 사이드바의 목록으로 이동해요.
- **작업 중에도 세션 제목 변경**: 실행 중인 세션도 사이드바(버튼, 메뉴, F2)와 제목 표시줄에서 이름을 바꿀 수 있고 바로 반영돼요. 삭제는 여전히 작업이 끝난 뒤에만 돼요.
- **IRC 알림 제거**: 서브에이전트끼리 주고받는 IRC 메시지가 화면 아래에 잠깐 떴다 사라지던 알림을 없앴어요.

## [0.5.2] - 2026-10-07

- **세션을 눌러도 순서가 바뀌지 않아요**: 사이드바에서 세션을 열 때마다 그 세션과 프로젝트가 맨 위로 올라가던 문제를 고쳤어요. 이제 세션 순서는 실제로 대화가 오간 시각을 따르고, 여는 것만으로는 자리가 바뀌지 않아요(고정과 드래그한 프로젝트 순서는 그대로예요).
- **채팅 왼쪽 턴 표시 수정**: 맨 아래 최신 내용을 보고 있을 때 왼쪽 `-` 턴 표시에서 현재 위치가 중간 턴에 머물던 문제를 고쳤어요. 맨 아래에 있으면 마지막 턴이 현재 턴으로 표시돼요.
- **설정 번역 보강**: 최신 omp에 새로 생긴 설정(SVG 그림 렌더링, 표 자동 차트, 제목 아이콘, 제목 생성 방식)과 섹션 제목, 선택지 설명 140여 개가 영어로 나오던 것을 한국어·중국어로 옮겼어요.

## [0.5.1] - 2026-10-07

- **사이드바에서 프로젝트를 지울 수 없던 문제 수정**: 프로젝트 메뉴(⋯ 또는 우클릭)의 "삭제"가 세션 파일만 지우고, 그 프로젝트에 열려 있던 탭 때문에 프로젝트가 목록에 그대로 남던 문제를 고쳤어요. 이제 삭제하면 그 프로젝트의 열린 탭도 닫히고 프로젝트가 목록에서 사라져요. 열린 탭이 그 프로젝트뿐이면 다른 프로젝트(없으면 채팅)에서 새 탭이 먼저 열려요. 아직 저장된 세션 없이 탭만 열린 프로젝트도 삭제할 수 있어요.

## [0.5.0] - 2026-10-07

- **사이드바 "코드 | 채팅"**: "업무" 칸이 "채팅"으로 바뀌었어요. 코드에는 프로젝트별 세션만, 채팅에는 도구 없는 채팅과 프로젝트 폴더 없이 시작한 세션이 한 목록으로 모여요. 채팅 칸의 버튼은 "새 채팅"이에요.
- **프로젝트 순서를 드래그로 바꾸기**: 코드 칸의 프로젝트를 끌어서 원하는 위치로 옮길 수 있고, 순서는 저장돼요. 새로 연 프로젝트는 맨 위에 나타나요. 키보드로는 프로젝트 메뉴의 "위로 이동/아래로 이동"을 쓰면 돼요.
- **프로젝트에 + 버튼**: 프로젝트 이름 옆의 세션 개수 대신 + 버튼이 항상 보여서, 누르면 그 프로젝트에서 바로 새 세션이 열려요.

## [0.4.2] - 2026-10-07

- **업데이트 화면에서 키체인 암호 창이 뜨던 문제 수정**: 설정 › 업데이트를 열 때마다 "ompdesk Safe Storage" 키체인 암호를 묻고, 응답할 때까지 버전 확인이 멈춰 있던 문제를 고쳤어요. 이제 GitHub 토큰을 직접 붙여 넣어 저장한 경우에만 키체인을 사용해요(gh 로그인이나 GH_TOKEN을 쓰면 묻지 않아요).

## [0.4.1] - 2026-10-07

- **작업 중 채팅 아래에 빈 공간이 생기던 문제 수정**: 긴 작업이 이어지면 실행 중인 작업 요약 아래로 내용 없는 빈 공간이 점점 커지고 "최신으로 이동"이 뜨던 문제를 고쳤어요. 작업 미리보기 창 안의 화면 낭독용 숨은 글자(수정한 줄 수 등)가 창 밖으로 새어 나와 채팅 높이를 늘리고 있었어요.

## [0.4.0] - 2026-10-07

- **서브에이전트를 사이드바에서**: 서브에이전트를 쓰는 세션 아래에 서브에이전트 목록이 붙어요. 실행 중이면 도는 아이콘과 경과 시간, 끝나면 체크, 실패하면 빨간 표시가 보이고, 서브에이전트가 띄운 서브에이전트는 한 단계 더 들여써져요. 누르면 그 서브에이전트가 하는 일을 실시간 기록으로 볼 수 있고, 우클릭으로 중지할 수 있어요. 실행 중일 땐 자동으로 펼쳐지고, 끝난 게 많으면 "완료 N"으로 접혀요.
- **입력창 위 서브에이전트 표시 축소**: 한 줄 요약(실행 중·완료 개수와 최근 작업)만 남기고, 실행 중인 게 없으면 사라져요. 누르면 사이드바의 해당 목록으로 이동해요.
- **할 일 카드가 사라지지 않던 문제 수정**: 모든 할 일이 끝나면 그 턴이 끝날 때 카드가 사라지고, 새로 열린 할 일이 생기면 다시 나타나요. 세션을 바꾸거나 다시 열어도 끝난 목록이 되살아나지 않아요.
- **같은 프로젝트가 사이드바에 두 번 나오던 문제 수정**: 같은 폴더를 다른 경로 표기(심볼릭 링크 등)로 열면 프로젝트 그룹이 둘로 갈라지던 문제를 고쳤어요.
- **입력창 주변 다듬기**: 대기 중인 메시지 목록이 입력창과 한 덩어리로 붙고, 실행 설정·모드·컨텍스트 팝오버와 모델 선택 창의 정리와 한국어 줄바꿈을 손봤어요. 팝오버가 내용이 늘어나도 창 밖으로 넘치지 않아요.
- **채팅 화면 다듬기**: 토큰 표시를 "약 8 토큰 · 4.7/초", "8.5k 토큰 · 평균 63/초"처럼 읽기 쉽게 바꿨어요. 작업 미리보기 창은 위에서부터 채워지고, 명령 실행 결과는 하나의 터미널 블록으로 보여요. 대화 사이 간격과 새 세션 시작 화면도 정리했어요.
- **설정·에이전트·통계 정리**: 설정 › 일반에서 "자동 압축"이 엉뚱한 제목 아래 있던 걸 "긴 세션"으로 옮기고, 해당 항목이 없는 빈 섹션은 숨겨요. 서브에이전트가 없을 땐 "모든 에이전트 일시정지" 버튼을 숨겨요. 통계 서버를 쓸 수 없을 때 영어 오류 대신 차분한 안내와 다시 시도 버튼을 보여 줘요. ⌘K 팔레트는 검색어와 맞는 부분을 강조해요.
- **오류 표시 정리**: 영어 원문 오류가 그대로 뜨던 곳을 한국어 제목으로 바꾸고, 원문은 작은 글씨로만 남겼어요. 업데이트 실패 안내는 빨간 줄 대신 차분한 알림으로 바뀌었어요. 사이드 패널 탭과 세션 우클릭 메뉴도 묶음별로 정리했어요.
- **응답 중 위로 스크롤하면 맨 아래로 끌려가던 문제 수정**: 응답이 흘러나오는 동안 지난 내용을 보려고 위로 올리면 한 번 맨 아래로 튕겨 내려가던 문제를 고쳤어요. 대화 탐색 막대로 이동한 직후 스크롤해도 다시 끌려가지 않아요.

## [0.3.0] - 2026-10-07

- **Claude·Codex 방식 업데이트**: 새 버전을 찾으면 백그라운드에서 받아 검증해 두고, 준비되면 사이드바 아래쪽에 작은 업데이트 카드가 떠요. "재시작해서 업데이트"를 누르면 몇 초 만에 새 버전으로 다시 열리고, 그냥 앱을 꺼도 다음 실행부터 새 버전이에요. 설치 파일을 열어 앱을 직접 바꿔 넣을 필요가 없어요(앱이 쓰기 가능한 위치에 있을 때. 디스크 이미지에서 바로 실행 중이면 카드에서 설치 파일을 받아 열어요). 실행 중인 작업이 있으면 재시작 전에 한 번 물어봐요. "나중에"로 그 버전 카드를 숨길 수 있고, 업데이트 실패만 위쪽 배너에 남아요.
- **작업 창 깜빡임 수정**: 여러 단계로 나뉜 작업이 진행될 때 단계마다 작업 요약과 미리보기 창이 새로 생겼다 사라지며 깜빡이던 문제를 고쳤어요. 한 턴의 작업은 끝날 때까지 하나의 요약과 하나의 미리보기 창에서 이어져요.
- 이번 업데이트는 한 번만 예전 방식(설치 파일)으로 받아야 해요. 그다음 버전부터 카드에서 재시작만 하면 돼요.

## [0.2.1] - 2026-10-07

- 실행 중인 작업 아래의 미리보기가 높이가 고정된 작은 창으로 바뀌었어요. 단계, 명령 출력, 생각 내용이 로그처럼 아래로 쌓이고 위로 스크롤해서 지난 내용을 볼 수 있어서, 내용이 바뀌어도 채팅 화면이 위아래로 흔들리지 않아요.
- 전송 버튼을 눌러 보낸 뒤에도 입력창에 포커스가 남아서, 바로 이어서 입력하거나 ⌘, 같은 단축키를 쓸 수 있어요.

## [0.2.0] - 2026-10-07

**ompdesk의 첫 공개 릴리스예요.** 설치된 omp를 그대로 쓰는 비공식 데스크톱 앱이에요(0.1.0은 출시하지 않고 건너뛰었어요).

- **이름과 데이터**: 앱 이름이 seucode에서 ompdesk로 바뀌었고, 첫 실행 때 이전 설정 폴더를 자동으로 옮겨요.
- **사이드바 중심 탐색**: 상단 탭 줄 대신 사이드바에서 세션을 열고 전환해요(⌃⇥로 순환). 코드/업무 전환 토글, 프로젝트 폴더 열기·만들기 버튼, 저절로 접히지 않는 사이드바(최소 220px).
- **채팅 화면**: 실행 중인 단계를 접힌 상태로도 보여 주고, 토큰 사용량과 속도(↓ 12.4k · 86 tok/s)를 작게 표시해요. 응답을 기다릴 땐 마지막 작업 줄의 도는 아이콘만 남겨요.
- **입력창**: 다음 프롬프트 제안을 회색 글자로 보여 주고 Tab이나 →로 받아요. 대기 중인 메시지는 입력창 위 한곳에서 편집·이동·삭제해요. 에이전트 질문은 화면을 가리지 않는 카드로 떠요.
- **할 일·서브에이전트 카드**: 접힌 채로 진행률과 현재 항목을 한 줄로 보여 줘요. 카드가 생겨도 자동 스크롤이 풀리지 않아요.
- **그 밖에**: "인사이트"를 "통계"로 바꾸고, 제목 표시줄·설정·통계·⌘K 팔레트·알림의 디자인을 다듬었어요. 모델 풀, 에이전트 편집기, 한국어 UI 등 아래의 전체 목록을 참고하세요.

Developed as seucode (formerly omp GUI) and shipped as its own project, an unofficial desktop app for omp, running on the user's stock omp.

### Identity

- New name and mark: the app is **ompdesk** (bundle id `com.seuput.ompdesk`, installers `ompdesk-<version>-…`, stable download names `ompdesk-mac-arm64.dmg`, `ompdesk-windows-setup.exe`, `ompdesk-windows-portable.exe`). The agent it drives is still omp. One mark, an interlaced knot (two congruent strands, you and the agent, woven into an S), renders the app icon (platinum and gold on an ink tile), the menu-bar/tray icon and the in-app logo (ink and the theme accent); 48px and smaller use a simplified, heavier knot.
- Renamed from seucode, its pre-release name, to ompdesk: app and bundle names, installers, the wordmark, the release repository (`SeuPut0705/ompdesk`) and every in-app mention. The first ompdesk launch moves a pre-release profile (`~/Library/Application Support/seucode`, `%APPDATA%\seucode`) into the new data directory, so window layout and GUI preferences carry over (skipped when `--user-data-dir` is given). On macOS a GitHub token saved in Settings › Updates has to be pasted again (its keychain key follows the app name), and model pools set in pre-release sessions are not read back.
- The app's data directory follows the new name (`~/Library/Application Support/ompdesk`, `%APPDATA%\ompdesk`), so window layout and GUI preferences from omp GUI start fresh; omp's own settings, logins and sessions in `~/.omp` are unaffected.

### Runtime

- Drives the **system-installed omp** (`omp --mode rpc-ui`); `omp update` updates the agent the GUI uses. Requires omp **18.6.0** or newer; a missing or outdated omp shows an install/update hint.
- GUI features stock omp's RPC does not cover run in the Electron main process (git/gh, files, `~/.omp` config, `omp` CLI) or through `gui-bridge`, an omp extension the GUI loads with `-e` for live-session state. No omp fork, no bundled agent binary.
- Stats run the user's omp-stats server without opening a browser and add the paginated request list the Requests page needs.
- macOS on Apple Silicon and Windows only; Intel Macs and Linux are not supported.
- Distributed privately: releases live in the private `SeuPut0705/ompdesk` repository for invited collaborators. In-app updates (Settings › Updates) authenticate as the user — `GH_TOKEN`/`GITHUB_TOKEN`, then the GitHub CLI login (`gh auth token`), then a token pasted in Settings › Updates › GitHub access (encrypted on the device with the OS keychain, with Test access and Remove) — never a bundled token. Update checks, `latest*.yml` reads and installer downloads (the macOS DMG through the authenticated GitHub API asset endpoint, still SHA-512 verified) all carry it. No token or no access shows a localized "sign in with gh or paste a token" state instead of a raw 404, and never a banner from the background check.
- Releases are built by CI: pushing a version bump to `main` with a dated changelog section runs the checks, the macOS e2e suite and the Windows smoke tests, packages macOS and Windows, and publishes the tagged release only if all of it passed.

### Added

- Korean UI: renderer, settings, menus, tray, dialogs. The language switcher cycles EN → 中文 → 한국어; with no saved choice the UI follows the OS locale.
- **Model pool** (composer mode chip › Model pool): pick several models from your connected providers, give each a role hint (fast exploration, hard reasoning, writing code, review, or your own words) and switch the pool on for the session. The main agent then splits each request into independent subtasks, runs them in parallel on the best-fitting pool models through the task tool's per-item model selector, and integrates and cross-checks the results, preferably with a different pool model. The pool is stored in the session itself, so it survives tab switches, restarts and resume; pools save as presets for reuse. A chip shows while it is on, Agents › Live labels each subagent with its pool model and role, and Insights › This session adds a usage-by-model split. Each model added to a pool gets one 16-token test request (the first-run "Test connection" bench), and a model your account can't serve (e.g. a provider 404) is flagged with the provider's error and a "Check again" button; if a pool model still fails mid-request, the main agent reassigns that subtask to another pool model and tells you which one failed. Works with stock omp: the GUI bridge appends the orchestration instruction through omp's `before_agent_start` extension hook; no agent files are written.
- **Agent editor and templates** (Agents › Definitions): create, edit, duplicate and delete omp task agents without touching files. **New agent** opens an editor with a field for every frontmatter key omp reads — name (checked against omp's reserved `main`/`sub`, the folder's existing files and first-wins precedence, with a note when the name overrides a bundled, user or plugin agent or is shadowed by a project one), description, instructions in a markdown editor, tools picked from omp's own tool list with a read-only preset, which agents it may start, an ordered model list of roles (`@slow`, with what each resolves to) and models, thinking level, prewalk, advisor, blocking, summarized reads, skills to preload and a validated JSON output schema — and saves to *All projects* (`~/.omp/agent/agents`) or *This project* (`.omp/agents`), showing the exact file path. Saving edits the file in place, keeping unknown frontmatter keys, comments and key spellings; writes are atomic, never replace another agent's file and refuse paths outside the two agent folders. Each row's menu edits, duplicates (a bundled or plugin agent becomes an overriding copy under the same name), opens the file in your editor, shows it in its folder or deletes it. **Templates** offers 12 ready specialists (frontend, backend/API, test writer, refactorer, debugger, docs writer, deep code reviewer, performance, migration/upgrade, UI/UX polish, database/SQL, DevOps/CI) with Korean, English and Chinese descriptions and recommended tools, model roles and thinking level: customize one before adding it, or add every one that isn't installed yet.
- Composer redesign: one calm field with a single toolbar at every width — a **+** menu (attach images, prompt history ⌃R, expand ⌃G), a **mode chip** (Plan · Goal · Loop · Vibe with inline config in one popover; replaces the Modes window), **Run settings** (thinking level, fast mode, tool approval and the advanced behavior toggles in one popover), the model chip showing the model's display name, a context ring with the share used, and send / stop. ⌃G now expands the composer in place over the session instead of opening a full-screen editor dialog (external-editor round-trip kept). Image files can be dropped on the composer. The field has an accessible name and new or empty sessions focus it.
- Queued messages live in one place: a tray attached to the top of the composer lists every queued steer and follow-up, with edit in place (Enter saves, Esc cancels), send a follow-up now as a steer (or hold a steer until the turn ends), remove and clear all. The transcript no longer repeats them as dashed bubbles and the dock no longer shows a separate queue chip. While a turn runs with nothing typed, Stop takes the Send button's place; a next-prompt suggestion shows a **Tab** chip; the composer's focus ring follows the text field only; toolbar labels collapse to icons at narrow widths instead of overflowing. Collapsed todo and subagent cards above the composer are one line (progress bar, count, current item) and span the composer's full width. The docked `ask` card uses real radio/checkbox semantics with arrow-key navigation, a Recommended badge and theme-aware colors.
- omp compatibility self-check: when a sidecar's `gui-bridge` connects, the GUI asks once per omp version which bridge features this omp's internals can no longer serve (plan mode, MCP, settings, …) and shows a dismissible warning naming them, with an `omp update` / report-an-issue hint. A bridge that fails to connect at all gets the same warning instead of only a log line. The affected commands fail with a coded `unsupported_omp` (or `bridge_unavailable`) error naming the feature instead of a raw TypeError, and one broken bridge module no longer takes the others down.
- Transcript redesign: the answer reads at body size, your prompt is a compact bubble whose actions appear on hover without reserving space, and finished work collapses into a plain summary ("Read 2 files · Edited 1 file · Ran 1 command · 16s"). Each step shows a human label, the file name first, and a `+N −M` diff stat for edits; thinking is one quiet row. Failed responses say what happened in your language with Try again / Change model / Open providers / Compact context; a stopped response is a neutral "Stopped" note, and slow or retrying waits offer Change model and Stop response.
- First run is an inline setup in the empty session instead of a dialog: pick a provider (search, recommended first), sign in or paste an API key right in the list (the key field is masked), or add an OpenAI/Anthropic-compatible endpoint with an inline form; then choose the default model, optionally verified with one short test request. "Set up later" leaves it for Settings › Models & providers.
- Providers & login moved to Settings › Models & providers (`/providers`, `/login`, `/logout`, `/add-provider` and the menu open it): one searchable list with connected providers first, a short recommended set, and the long tail collapsed; "Connect" is a quiet row action instead of 80 primary buttons. Custom endpoints are added and edited inline (no stacked dialogs), with human protocol names and the rarely used options under "Advanced".
- Model picker: connected providers first with their display names, each model's context window (small ones flagged), and a link to manage providers. The pick also becomes the default for new sessions, as omp's own `/model` picker does.
- Command palette (⌘K): sections follow the app's layout (Session, Agents, Insights, Models, … Settings, Help) with one icon per section, shortcuts shown for the platform, and a key hint footer. Search ranks exact, then prefix, then word-start, then substring matches, understands Korean typed mid-syllable or as initial consonants ("트리", "틀", "ㅌㄹ" all find 세션 트리), and lifts recently used commands. Enter never runs a turn-starting or destructive command (retry, resend, clear, delete, compact, quit, a slash command sent to the agent, …) off a partial match: it asks for a second Enter unless the query names the command exactly or you picked it with the arrow keys.
- One name per concept across English, Korean and Chinese (session, project, side panel, command palette, plan mode, steer, follow-up, subagent, background job, Insights, …), sentence-case labels without baked-in shortcuts, and error messages that say what to do next. Korean messages use 해요체; leftover English in Korean and Chinese is translated.
- Next-prompt suggestions from the `next-prompt` omp extension show as gray placeholder text in the empty composer; Tab takes it, typing dismisses it. Previously the widget floated as a panel over the composer and Tab did nothing (the extension listens for terminal input, which never reaches it over RPC).
- The sidebar never folds on its own: it keeps its width (minimum 220px, drag-resizable up to 420px) at every window size and only hides when you collapse it. The icon rail and the narrow-window sidebar sheet are gone; below 1000px only the side panel becomes a sheet.
- Code / Work is a segmented toggle at the top of the sidebar instead of two items at the bottom of the project menu.
- The todo and subagent cards above the composer start collapsed and show a one-line glance: todo progress (a thin bar and done/total) with the task in progress (or the next one), and subagent counts (running · done · failed) with the most recently active agent. Click the card header to expand it as before.
- A folder button next to **New session** opens the native folder picker (with its New Folder button) to open or create a project folder and start a session there.
- Waiting on the model no longer prints a "Waiting for model response… Ns · Esc to stop" line: the turn's last work row keeps its spinner (reading "Working · N steps" between steps), or a bare spinner stands where the reply will appear. Past 30s the slow/stalled hints and recovery buttons still show.

### Fixed

- New sessions could start on Apple's on-device model (8k context) even with a configured provider, and the model changed between launches: with no saved default, omp prefers a known provider's catalog default and Apple only becomes available once its discovery is cached (launch 2+). The GUI now saves the default model (from first-run setup and the model picker) and, when none is saved, starts on a connected model that can hold a coding session, never a keyless or too-small one.
- Windows: omp installed under a path with a space (e.g. `C:\Users\First Last\…\omp.cmd`) failed to launch; the shim path is now quoted for every omp spawn.
- With no provider credentials (and no on-device model), stock omp exits at startup ("No models available" on 18.6, "No default model selected" on 18.7), so the GUI crash-looped and the first-run onboarding that connects a provider never opened. The GUI now boots omp once on a model from the installed omp's own catalog so onboarding appears; it recognizes both messages and the API-key hint stock prints under them.
- Windows: new tab, chat tab, and close tab had no working shortcut (their defaults were ⌘-only). Every ⌘ shortcut now uses Ctrl on Windows (new tab Ctrl+T, chat tab Ctrl+Shift+T, close tab Ctrl+W; thinking toggle moves to Ctrl+Alt+T there), and shortcut labels show Windows key names.
- Opening a tab or switching to a session hydrated the transcript up to three times concurrently; it now loads once per tab and session.
- Opening a session with a long history re-fetched and re-projected the whole history for every transcript page.
- A packaged app ignored the project folder passed on the command line.
- A missing or too-old omp left the window at "Connecting…" with no explanation; the reason and the install/update command now show in the UI language.
- "Remove global override" in settings failed for settings without a default.
- Typed GUI commands stock omp does not advertise (`/plan`, `/loop`, `/goal`, `/vibe`, `/tan`, `/omfg`, `/pause`, `/settings`, …) were sent to the model as text, and slash completion offered a skill instead (`/plan` + Enter → `/skill:…-plan`). They are now listed in completion and run natively; completion ranks exact, then prefix, then substring matches.
- At the minimum window width with 200% zoom (400 CSS px), the session sidebar left the conversation too narrow and the composer's Send button was laid out off-screen. The sidebar now takes at most 40% of a narrow window and the composer toolbar wraps, keeping Send on its own row.
- A transcript following a streaming reply could paint newly streamed text below the fold for a frame or more on a slow renderer before scrolling to it; the follower now pins in the same frame the row is measured.
- A transcript following a run left its newest lines hidden whenever the layout around it took height — a todo or subagent card appearing or expanding above the composer, or the composer growing — until more text happened to arrive. A view that was following the tail now re-pins to the bottom after any such resize; only scrolling away yourself stops following.
- With omp 18.6.3, opening a session whose saved model is unavailable still failed after choosing a replacement model in the restore prompt: the GUI switched first and set the model afterwards, but omp now refuses that switch. The chosen model is now passed with the switch (older omp still gets it set afterwards).
- Stats could show "Stats unavailable — This operation was aborted" right after opening on a slow machine (seen on Windows): the GUI gave each stats request 5 s, no more than the stats server's own database lock wait. Requests now get 15 s.
- Windows: a setting changed in the GUI could silently snap back to its previous value right after another setting was saved: omp's save took its own just-written config.yml for an external edit and dropped the change. The GUI now checks that the change was kept and applies it once more if not.
- Startup parsed about 11 MB of JavaScript, including all of mermaid, because the bundler had placed its dynamic-import helper in the mermaid chunk. Mermaid, KaTeX (and its stylesheet), the raw-HTML markdown step, CodeMirror and the todo list's drag-and-drop now load the first time they are needed; startup loads about 3.2 MB. Content that needs one of them shows plain text (TeX source, no embedded HTML, a spinner in the editor) for the moment the chunk takes to load.

### Removed or narrowed compared to the fork-based GUI

- Live session sharing (collab host/join/leave) from the GUI. `omp` in a terminal still offers it.
- Re-answering a past `ask` from the session tree.
- Reordering queued messages within a lane. Editing a queued message or moving a steer to follow-up re-queues it at the lane's end, text only.
- Job result previews in the jobs dialog; the shake summary arrives as command output; share uploads are not trimmed before upload.
- `abort_subagent` cancels only running subagents stock omp lists for the session.

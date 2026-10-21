# 문제 해결

[English](troubleshooting.md) · [README로 돌아가기](../README.ko.md)

| 증상 | 확인할 것 |
|---|---|
| macOS가 "확인되지 않은 개발자" 경고를 띄워요 | 정상이에요. 빌드는 자체 서명 인증서로 서명했고 Apple 공증은 받지 않았어요. Finder에서 앱을 **우클릭 → 열기**로 한 번 실행하세요. 계속 막히면 **시스템 설정 › 개인정보 보호 및 보안**에서 허용하세요. |
| Windows SmartScreen이 막아요 | **추가 정보 → 실행**을 누르세요. 회사 정책으로 막히면 관리자에게 문의하세요. |
| 창을 닫았는데 앱이 꺼지지 않아요 | 의도한 동작이에요. 마지막 창을 닫으면 창만 숨겨지고 진행 중인 작업은 계속돼요. macOS는 Dock 아이콘, Windows는 트레이 아이콘이나 앱을 다시 실행해 창을 되살려요. 종료는 ⌘Q, 메뉴 종료, 트레이 종료로 해요. **다시 열 때 중단된 작업 이어서 하기**(기본값 켜짐)가 켜져 있으면 묻지 않고 종료하고, 작업은 다음 실행에서 이어져요. 꺼져 있으면 진행 중인 작업이 있을 때 먼저 물어봐요. Windows에서 창을 닫을 때 종료하려면 **설정 › 일반**의 트레이 스위치를 끄세요. 여러 창 중 마지막이 아닌 창은 그대로 닫혀요. |
| omp를 찾을 수 없어요 | 설치 화면이나 **설정 › 업데이트 및 정보 › 이 컴퓨터**에서 실패 이유를 확인하고 **다시 시도**를 누르세요. 직접 설치했다면 터미널에서 `omp --version`을 확인하세요. 다른 경로에 설치했다면 `OMP_GUI_OMP` 환경 변수에 실행 파일 경로를 지정하세요. |
| omp 버전이 낮다고 나와요 | OMPdesk가 `omp update`를 알아서 실행해요. 실패했다면 터미널에서 `omp update` 후 **다시 시작**을 누르세요. 18.12.3 이상이 필요해요. |
| 앱 업데이트가 "요청 한도 초과"로 실패해요 | 잠시 뒤 다시 시도하세요. 선택 사항인 GitHub 토큰(`GH_TOKEN`, `gh auth login`, **설정 › 업데이트 및 정보**의 **GitHub 토큰(선택)**)을 쓰면 한도가 늘어나요. [업데이트](updates.ko.md)를 참고하세요. |
| PR 기능이 동작하지 않아요 | Git 저장소를 연 뒤 **설정 › 일반 › GitHub 계정**에서 로그인하세요(또는 `gh auth status`가 로그인 상태인지 확인하세요). |
| 노트북이 잠들었다 깨거나 인터넷이 끊긴 뒤 작업이 멈췄어요 | OMPdesk가 연결을 기다렸다가 스스로 이어가요. 기다리기 싫으면 **취소**를 누르세요. |
| macOS에서 컴퓨터 사용 권한을 물어요 | 컴퓨터 사용은 기본으로 켜져 있어요. 시스템 설정에서 OMPdesk에 **화면 기록**과 **손쉬운 사용** 권한을 주세요. 세션에서 `/computer off`로 끌 수 있어요. |

## 직접 설치하기

OMPdesk는 첫 실행 때 Bun, omp, (Windows는) Git을 알아서 설치해요. 직접 하려면 터미널에서 이렇게 하세요.

```bash
curl -fsSL https://bun.sh/install | bash        # Windows: powershell -c "irm bun.sh/install.ps1 | iex"
bun install -g @oh-my-pi/pi-coding-agent
omp --version
```

## 첫 실행이 설치하는 것

| 항목 | 설치 방법 |
|---|---|
| Bun (필수) | Bun 공식 설치 스크립트로 사용자 폴더(`~/.bun`)에 설치해요. 관리자 권한이 필요 없어요. |
| omp (필수) | `bun install -g @oh-my-pi/pi-coding-agent`. 18.12.3보다 낮으면 `omp update`를 실행해요. |
| Git for Windows (Windows 필수) | 이미 설치돼 있으면 그대로 쓰고, 없으면 고정된 PortableGit 릴리스를 SHA-256으로 확인한 뒤 `%LOCALAPPDATA%\ompdesk\tools\git`에 풀어요. 관리자 권한이 필요 없어요. |
| Git (macOS, 선택) | `xcode-select --install`. |
| GitHub CLI, Node.js (선택) | macOS는 Homebrew가 있으면 `brew install`, 없으면 공식 압축 파일을 체크섬으로 확인해 OMPdesk 도구 폴더에 풀어요. Windows는 `winget`을 쓰고, 이때 Windows가 권한을 물어볼 수 있어요. |

필수 항목이 먼저 끝나고, 선택 항목은 백그라운드에서 설치돼요. 상태와 **다시 시도**는 **설정 › 업데이트 및 정보 › 이 컴퓨터**에 있어요.

## 로그

| 로그 | 위치 |
|---|---|
| OMPdesk 자체 오류와 재시작 판단 | `~/Library/Application Support/ompdesk/logs/gui-runtime.jsonl` (Windows: `%APPDATA%\ompdesk\logs\gui-runtime.jsonl`) |
| omp 로그 | `~/.omp/logs/` (Windows: `%USERPROFILE%\.omp\logs\`) |

사이드바의 **도움말 › 피드백 보내기**는 GitHub 이슈 초안을 만들고, 최근 OMPdesk 오류를 붙일 수 있어요(세션 내용은 절대 포함되지 않아요). 작성하는 동안에는 아무것도 전송되지 않아요. **GitHub에서 계속**을 누르면 브라우저에서 초안이 열리고, 이때 그 내용이 페이지 주소에 담겨 GitHub로 전달되니 게시하기 전에 거기서 확인하세요.

**설정 › 업데이트 및 정보 › 진단 정보 복사**는 버전, 설치 상태, OMPdesk 로그의 최근 100개 항목(반복된 줄은 횟수와 함께 한 번만)을 비밀값, 주소, 사용자 폴더를 가린 채 클립보드에 담아요(**미리보기**로 복사될 내용을 그대로 볼 수 있고, 아무것도 업로드하지 않아요). 로그 파일에는 파일 경로, 주소 같은 이 컴퓨터의 정보가 들어 있을 수 있으니 파일을 직접 붙여 넣기보다 이걸 쓰고, 줄을 붙여 넣을 때는 공개하면 안 되는 내용을 지워 주세요.

## 그래도 안 되면

재현 방법, `omp --version`, **진단 정보 복사** 내용(또는 OMPdesk 버전, 운영체제, [로그](#로그)의 관련 줄)과 함께 [이슈](https://github.com/SeuPut0705/ompdesk/issues)를 남겨 주세요.

<div align="center">

[English](README.md) · **한국어**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="resources/brand/wordmark-dark.svg">
  <img src="resources/brand/wordmark-light.svg" alt="OMPdesk" height="64">
</picture>

**omp 코딩 에이전트를 위한 데스크톱 앱: 병렬 세션, 오토파일럿, 그리고 내 휴대폰까지.**

<a href="https://github.com/SeuPut0705/ompdesk/releases/latest/download/ompdesk-mac-arm64.dmg"><img src="resources/brand/download-macos.svg" alt="macOS(Apple Silicon)용 다운로드" width="280" height="64"></a>
<a href="https://github.com/SeuPut0705/ompdesk/releases/latest/download/ompdesk-windows-setup.exe"><img src="resources/brand/download-windows.svg" alt="Windows(x64)용 다운로드" width="280" height="64"></a>

[![최신 릴리스](https://img.shields.io/github/v/release/SeuPut0705/ompdesk?style=flat-square&color=5B5BD6)](https://github.com/SeuPut0705/ompdesk/releases/latest)
![macOS와 Windows](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows-5B5BD6?style=flat-square)
[![MIT 라이선스](https://img.shields.io/badge/license-MIT-5B5BD6?style=flat-square)](LICENSE)

<sub>[omp](https://github.com/can1357/oh-my-pi)의 비공식 앱이에요. omp 제작자와 관계가 없어요. 앱 화면은 한국어와 영어를 지원해요.</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/hero-dark.webp">
  <img src="docs/media/hero.webp" alt="다크 테마 토글을 추가해 달라는 프롬프트: 에이전트가 도구 단계, 서브에이전트 둘, 작업 현황의 할 일 목록으로 일하고 결과를 보고해요" width="860">
</picture>

<sub>테스트용 omp와 예제 파일로 녹화했어요. 실제 계정이나 작업 데이터가 아니에요.</sub>

</div>

## 왜 OMPdesk인가요

- **순정 omp, 포크 없음.** 컴퓨터에 설치된 omp를 그대로 실행해요. 터미널에서 쓰던 설정, 로그인, 세션 기록을 함께 써요.
- **여러 세션을 병렬로.** 분할 화면, Git 워크트리, 일을 나눠 맡기고 비교해 가장 좋은 결과를 병합하는 에이전트까지 지원해요.
- **어디서든 이어서 작업.** 오토파일럿은 계속 돌고, 재시작해도 작업이 이어지고, 휴대폰에서 실행 중인 작업을 조종할 수 있어요.

## 주요 기능

<table>
<tr>
<td width="50%" valign="top"><b>오토파일럿</b><br>자기 Git 워크트리에서 감사 → 구현 → 검증 → 커밋을 사이클마다 이어서 반복해요. 기본은 로컬만이고, 더 하려면 직접 골라요. 프로젝트별 <code>AUTOPILOT.md</code> 가이드(초안을 만들어 줘요)로 방향을 정해요.<br><a href="docs/media/autopilot.webp"><img src="docs/media/autopilot.webp" alt="오토파일럿 사이클 1, 2, 3이 사이드 패널 타임라인에 쌓이고, 같은 실행이 작업 현황에 보이는 모습" width="100%"></a></td>
<td width="50%" valign="top"><b>병렬 세션과 조율</b><br>에이전트가 일을 각자 워크트리의 세션으로 나눠 맡기고, 브랜치를 비교하고, 승인하면 하나를 병합해요. 푸시는 하지 않아요.<br><a href="docs/media/fan-out.webp"><img src="docs/media/fan-out.webp" alt="워크트리 세션 셋을 비교하고, 검토 대기열에서 하나는 승인해 병합하고 하나는 버리는 모습" width="100%"></a></td>
</tr>
<tr>
<td width="50%" valign="top"><b>분할 화면과 작업 현황</b><br>세션을 최대 4개까지 나란히 열어요. 칸마다 서브에이전트, 할 일, 기다리는 질문이 실시간 보드에 보여요.<br><a href="docs/media/split-board.webp"><img src="docs/media/split-board.webp" alt="실행 중인 세션과 작업 현황, 이어서 세션 둘을 끌어 와 세 칸으로 나누는 모습" width="100%"></a></td>
<td width="50%" valign="top"><b>모바일 웹 (베타, 기본값 꺼짐)</b><br>내 Tailscale 네트워크로 휴대폰에서 실행 중인 작업에 추가 지시를 보내요. 링크를 복사해 같은 Tailscale 계정으로 로그인한 기기에서 열면 끝이에요. 코드도 QR도 필요 없고, 원하면 푸시 알림도 받아요. <a href="docs/mobile-web.ko.md">설정 방법</a>.<br><a href="docs/media/phone.webp"><img src="docs/media/phone.webp" alt="폭 390px 휴대폰 화면: 실행 중인 세션에 추가 지시를 보내고, 설정에서 알림 켜기를 고르는 모습" width="45%"></a></td>
</tr>
<tr>
<td width="50%" valign="top"><b>재시작 뒤 이어서 하기</b><br>작업 도중에 종료하거나, 비정상 종료하거나, 업데이트로 다시 시작해도 다음 실행에서 멈춘 곳부터 이어가요.<br><a href="docs/media/resume.webp"><img src="docs/media/resume.webp" alt="작업 중 OMPdesk를 종료하고 다시 열면 알림과 함께 작업이 이어지는 모습" width="100%"></a></td>
<td width="50%" valign="top"><b>계정과 사용량</b><br>프로바이더마다 여러 계정과 실시간 한도 막대, 용도별 모델 역할을 볼 수 있어요.<br><picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/models-dark.webp"><img src="docs/media/models.webp" alt="설정의 모델 및 계정: 구독 계정과 5시간·7일 사용량 막대" width="100%"></picture></td>
</tr>
<tr>
<td width="50%" valign="top"><b>파일, 변경 사항, 미리보기, 터미널</b><br>코드, Markdown, PDF, Office 문서, diff, 실시간 미리보기와 터미널을 대화 옆에서 열어요.<br><picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/files-dark.webp"><img src="docs/media/files.webp" alt="오른쪽 패널의 파일 보기에서 TypeScript 파일을 대화 옆에 연 모습" width="100%"></picture></td>
<td width="50%" valign="top"><b>원격 기기</b><br>다른 컴퓨터의 omp, 파일, 계정으로 탭을 돌리고 여기서 지시해요. <a href="docs/remote-devices.ko.md">연결 방법</a>.<br><picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/devices-dark.webp"><img src="docs/media/devices.webp" alt="설정의 기기 및 연결: 이 컴퓨터 공유, 기기 연결, SSH 호스트, 모바일 웹" width="100%"></picture></td>
</tr>
</table>

그 밖에: 컴퓨터 사용(기본 켜짐, 한 번에 한 세션만 화면을 써요, `/computer off`로 끄기), 서브에이전트 사이드 패널, 코드 블록과 그림의 간결한 헤더가 있어요.

## 설치

1. **다운로드**는 위 버튼으로 받으세요. macOS는 DMG를 열고 **OMPdesk**를 응용 프로그램 폴더로 옮기세요. Windows는 설치 파일을 실행하세요.
2. **실행**하면 첫 실행 때 OMPdesk가 omp, Bun, (Windows는) Git을 알아서 설치해요. 터미널은 필요 없어요.
3. **모델에 로그인**하세요(프로바이더 로그인 또는 API 키). 터미널 omp에서 로그인했다면 그대로 써요.

macOS 첫 실행: 빌드는 서명했지만 공증은 받지 않아서, 앱을 우클릭하고 **열기**를 한 번 선택하세요.

Apple Silicon Mac 또는 Windows 10/11 x64가 필요해요. omp 18.11.0 이상은 알아서 설치돼요.

## 업데이트

OMPdesk, omp, 연결한 계정의 도구 CLI, omp의 플러그인·스킬·MCP 서버가 앱이 켜져 있는 동안 스스로 업데이트해요. 실행 중인 작업은 끊기지 않고, 앱 업데이트로 재시작해도 다시 열면 이어져요. GitHub 계정이나 토큰은 필요 없어요. [자세히](docs/updates.ko.md).

## 자주 묻는 질문

- **omp 공식 앱인가요?** 아니에요. 설치된 omp를 구동하는 비공식 앱이고, omp 자체는 고치지 않아요.
- **비용이 드나요?** 아니요. MIT 라이선스이고 계정이 필요 없어요. 모델 비용은 터미널에서처럼 프로바이더가 청구해요.
- **에이전트가 내 컴퓨터를 조작하나요?** 컴퓨터 사용은 기본으로 켜져 있고, 한 번에 한 세션만 화면을 써요. macOS에서는 OMPdesk에 화면 기록과 손쉬운 사용 권한을 줘야 동작해요. omp 기본 도구 승인에서는 묻지 않고 조작하니, 설정 › 권한 및 보안의 **도구 승인**을 "항상 묻기"로 바꾸거나 `/computer off`로 끄세요.
- **창을 닫았는데 앱이 꺼지지 않아요.** 의도한 동작이에요. 종료(⌘Q, 트레이 메뉴)하기 전까지 작업은 계속돼요.
- **다른 문제가 생겼어요.** [문제 해결](docs/troubleshooting.ko.md)을 보거나 [이슈](https://github.com/SeuPut0705/ompdesk/issues)를 남겨 주세요.

## 개인정보

- **로컬.** 설정, 세션, 계정은 omp를 실행하는 컴퓨터에 저장돼요. 모델 호출은 내 프로바이더로 가요.
- **텔레메트리 없음.** OMPdesk는 사용 통계를 수집하지 않고, omp의 OTLP 내보내기도 꺼 둬요.
- **모바일 웹은 내 tailnet 안에서만.** 기본값은 꺼짐이고, 내 Tailscale 네트워크로만 접속돼요.

## 소스에서 실행하기

Bun, Git, omp 18.11.0 이상이 필요해요.

```bash
git clone https://github.com/SeuPut0705/ompdesk.git
cd ompdesk
bun install
bun run dev
```

개발·검사·배포 규칙은 [AGENTS.md](AGENTS.md), 버전별 변경 내역은 [CHANGELOG.md](CHANGELOG.md)에 있어요. 위 미디어를 다시 녹화하려면 `bun run readme:media`를 실행하세요.

## 기여 · 보안 · 라이선스

[기여하기](CONTRIBUTING.md) · [보안](SECURITY.md) · [MIT 라이선스](LICENSE) · [서드파티 고지](THIRD_PARTY_NOTICES.txt)

만든 사람: [@SeuPut0705](https://github.com/SeuPut0705)

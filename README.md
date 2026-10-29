# CLIProxyAPI Sample

## Homebrew 로컬 설치

Homebrew로 설치한 CLIProxyAPI는 `$(brew --prefix)/etc/cliproxyapi.conf`에서 설정을 읽는다.
Apple Silicon의 기본 경로는 `/opt/homebrew/etc/cliproxyapi.conf`이고 Intel Mac의 기본 경로는 `/usr/local/etc/cliproxyapi.conf`다.

`config.example.yaml`은 CLIProxyAPI v8 설정 예시다.
CLIProxyAPI v8 이상을 설치한다.
`__ZAI_API_KEY__`를 Z.ai API 키로 바꾼다.
`access.api-keys`는 주석 처리되어 로컬 client 인증을 사용하지 않는다.
GLM 두 모델의 effort는 `minimal → low`, `medium → high`, `xhigh → max`로 변환한다.
GLM 두 모델을 `api-keys.codex`에 등록하고 `base-url`을 `https://api.z.ai/api/v1`로 지정한다.
이 구성으로 Z.AI의 `/responses` endpoint를 호출한다.
Payload 규칙에는 `protocol: codex`와 `reasoning.effort` 경로를 지정한다.
Effort 목록과 매핑 규칙은 높은 값부터 나열한다.
GLM의 `display-name`, `is-compat: true`, context 한도를 유지한다.
Codex provider에는 `support-prompt-cache-key`를 지정하지 않는다.
`input-modalities`, `output-modalities`도 지정하지 않는다.
GPT 모델을 사용하려면 Codex OAuth로 로그인한다.

```bash
brew install cliproxyapi
vi "$(brew --prefix)/etc/cliproxyapi.conf"
```

```bash
brew services start cliproxyapi
brew services stop cliproxyapi
```

자동으로 다시 읽는 설정만 수정했다면 서비스를 재시작하지 않는다.
`server.trusted-proxies`처럼 `config.example.yaml`에서 재시작을 요구하는 설정을 수정했다면 서비스를 재시작한다.

```bash
brew services restart cliproxyapi
```

### Claude Code

`.claude/settings.json`은 `model` 키를 지정하지 않는다.

| 선택자 | 대상 |
| --- | --- |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | `gpt-6-astra` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `gpt-6-luna` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `gpt-6.1-sol` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `gpt-6.1-terra` |

`ANTHROPIC_CUSTOM_MODEL_OPTION`은 `glm-5.3`을 모델 선택기에 추가한다.
모델별 `modelSettings.autoCompactWindow` 설정에는 Claude Code v2.1.288 이상이 필요하다.

### Model pricing

`.claude/settings.json`의 `modelPricing.overrides`는 모델별 백만 토큰당 USD 가격을 담는다.
Claude Code 2.1.302는 사용자, 프로젝트, 로컬 설정과 `--settings`에서 `modelPricing`을 무시한다.
따라서 이 값은 이 범위에서 효과가 없는 구성 데이터다.
가격을 적용하려면 지원되는 관리형 설정 범위에 배포해야 한다.
macOS 시스템 관리형 설정 파일 경로는 `/Library/Application Support/ClaudeCode/managed-settings.json`이다.
네이티브 네 가격 필드는 GPT의 272K 초과 컨텍스트 계층을 표현하거나 공급자 청구액을 증명하지 않는다.
자세한 내용은 [Claude Code settings reference][managed-pricing]를 참조한다.

Gemini 두 모델의 현재 프로모션 표시 가격은 다음과 같다.
`gemini-3.8-flash`는 입력 0.75, 캐시 입력 0.075, 출력 3.75이고 2026-12-31까지 프로모션이다.
`gemini-4-argon`은 입력 2.00, 캐시 입력 0.10, 출력 10.00이고 2026-12-01까지 프로모션이다.
이 가격은 이후 기간의 보장 가격이나 Google 직접 API 가격이 아니다.
두 모델의 `cacheWrite` 0은 별도 캐시 쓰기 과금 항목이 없음을 나타낸다.
이 0은 공개된 Google 캐시 쓰기 가격이나 실제 게이트웨이 과금 측정값이 아니다.

[managed-pricing]:
  https://code.claude.com/docs/en/settings-reference#modelpricing

### Gemini effort and compaction

Gemini 두 모델의 `modelSettings`는 `effortLevel` `medium`과 `maxEffortLevel` `high`를 사용한다.
공식 지원 사고 수준은 low, medium, high이고 기본값은 medium이다.
자세한 내용은 [Gemini thinking reference][gemini-thinking]를 참조한다.
이 설정은 기본값과 상한이지 측정된 최적값이 아니다.
`autoCompactWindow` 305000은 인식된 모델 용량으로 클램프된 뒤 안전 버퍼가 적용된다.
Claude Code 2.1.302는 인식되지 않는 커스텀 모델 ID의 용량을 순서대로 가정한다.
먼저 검증된 내장 카탈로그 매핑이 있으면 그 용량을 사용한다.
매핑이 없으면 양수 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 400000을 가정 용량으로 쓴다.
이 값이 없어야 기본 용량 200000 폴백이 적용된다.
가정 용량은 공급자가 실제로 제공하는 용량을 증명하지 않는다.
임의의 공급자 응답 메타데이터가 이 순서를 덮어쓰지 않는다.
따라서 305000 토큰 컴팩션 트리거는 보장되지 않는다.

[gemini-thinking]:
  https://ai.google.dev/gemini-api/docs/thinking

### Agent guidance ownership

[Shared engineering guidance](.agents/engineering.md) owns common rules.
Repository rules live in `AGENTS.md`.
The Claude and Codex instruction files link to the shared guidance.
Place user-level instruction files under one parent:

- `.agents/engineering.md`
- `.claude/CLAUDE.md`
- `.codex/AGENTS.md`

Instruction reads do not import config or activate plugins.
The Sample preserves conservative capability declarations.
Omitted overrides use native host behavior.
OpenAI model and API settings remain workload-specific, not shared rules.
Write clear guidance.
xAI guidance applies only to speech-to-speech prompting.
Do not generalize its voice format, all-caps rules, or tool-confirmation policy.
See [Claude][claude-prompting], [OpenAI][openai-latest], [xAI][xai-s2s], and [Meta][meta-prompting].

[claude-prompting]: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview.md
[openai-latest]: https://developers.openai.com/api/docs/guides/latest-model.md
[xai-s2s]: https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech/prompting-guide
[meta-prompting]: https://dev.meta.ai/llama/docs/how-to-guides/prompting

### 로컬 Codex 로그인

```bash
cliproxyapi --codex-device-login
```

## Docker Compose

### 설정

`config.example.yaml`을 `config.yaml`로 복사하고 `__ZAI_API_KEY__`를 Z.ai API 키로 바꾼다.
Docker의 기본 bridge network를 사용한다면 `config.yaml`의 `server.host`를 `"0.0.0.0"`으로 바꾼다.
Compose는 컨테이너 포트를 호스트의 `127.0.0.1:8317`에 연결한다.
Host network를 사용하려면 Compose 서비스에 `network_mode: host`를 설정하고 `ports` 항목을 제거한다.
이때 `config.yaml`의 `server.host: "127.0.0.1"`을 유지할 수 있다.
Linux Docker Engine은 host network를 지원한다.
Docker Desktop에서는 지원 버전의 host networking 기능을 활성화해야 한다.

```bash
cp "config.example.yaml" "config.yaml"
$EDITOR "config.yaml"
```

### 실행

```bash
docker compose up -d
```

### 컨테이너 Codex 로그인

```bash
docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI -no-browser --codex-device-login
```

CLIProxyAPI는 로그인 정보를 `${CLI_PROXY_AUTH_PATH:-./auths}`에 저장한다.

## Status line

저장소 루트에서 다음 명령을 실행한다.

```sh
dest="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$dest/statusline"
cp ".claude/statusline.mjs" "$dest/statusline.mjs"
for module in ".claude/statusline/"*.mjs; do
  case "$module" in
    *.test.mjs) continue ;;
  esac
  cp "$module" "$dest/statusline/$(basename "$module")"
done
```

런타임은 진입점과 `.claude/statusline/`의 여섯 실행 모듈이다.
테스트 파일과 `README.md`는 설치 대상이 아니다.
사용량 캐시와 수집기 동작은 [statusline README](.claude/statusline/README.md)를 참고한다.

statusline 명령은 비어 있지 않은 `CLAUDE_CONFIG_DIR`를 사용한다.
설정되지 않으면 `$HOME/.claude`를 사용한다.
프로젝트 `.claude/settings.json`에 배열형 `statusLineAddon`이 있으면 프로젝트 설정이 우선한다.
이때 자격 증명 파일 참조는 프로젝트 `.claude` 디렉터리를 기준으로 해석한다.
그 외에는 선택된 설정 디렉터리를 기준으로 해석한다.

`statusline.mjs`는 애드온 스크립트 경로를 다음 기준으로 해석한다.

- 절대 경로는 그대로 사용한다.
- `~`와 `~/...`는 홈 디렉터리로 확장한다.
- 상대 경로는 실행 중인 `statusline.mjs` 위치를 기준으로 해석한다.

## 환경 변수

경로나 이미지를 바꾸려면 다음 환경 변수를 설정한다.

- `CLI_PROXY_IMAGE` (기본값 `eceasy/cli-proxy-api`)
- `CLI_PROXY_CONFIG_PATH`
- `CLI_PROXY_AUTH_PATH`
- `CLI_PROXY_LOG_PATH`
- `CLI_PROXY_PLUGIN_PATH`

## Development checks

Use Node.js 24 LTS and the pnpm version declared in `.tool-versions`.
Run `pnpm install --frozen-lockfile` from the repository root.
Installation activates Husky's Git hooks.
The hooks run `pnpm run pre-commit` and `pnpm run pre-push` respectively.
Both scripts run Markdownlint, Ultracite and the offline regression tests.
The pnpm override selects a patched math parser dependency.
Run `pnpm run fix` to apply Markdownlint and Ultracite fixes.
Run `pnpm run pre-push` to repeat the complete local gate.
The Checks workflow uses the same gate on Node.js 24.
It also validates Docker Compose without starting services.
Tests use isolated temporary directories and local fixtures.
They do not require provider credentials or service requests.
Provider fixtures verify local normalization and failure handling.
They do not establish live service compatibility.

### Change lifecycle

Define the expected behavior and acceptance command before editing.
For statusline defects, reproduce the failure with an offline fixture first.
Preserve behavior with the existing regression tests during refactoring.
Keep the diff focused and remove obsolete paths with their consumers.
Run the complete local gate before review and publication.
Review the full proposed diff and record actual checks and untested behavior.
Confirm the merged change on `main` and clean up owned temporary resources.
Keep live CLIProxyAPI services, settings and authentication assets untouched.

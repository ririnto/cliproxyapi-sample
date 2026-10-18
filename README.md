# CLIProxyAPI Sample

## Homebrew 로컬 설치

Homebrew로 설치한 CLIProxyAPI는 `$(brew --prefix)/etc/cliproxyapi.conf`에서 설정을 읽는다.
Apple Silicon의 기본 경로는 `/opt/homebrew/etc/cliproxyapi.conf`이고 Intel Mac의 기본 경로는 `/usr/local/etc/cliproxyapi.conf`다.

`config.example.yaml`은 공식 CLIProxyAPI v8 예시의 주석을 유지한 설정이다.
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

`.claude/settings.json`에서 기본 모델은 `opus`로 선택한다.

| 선택자 | 대상 |
| --- | --- |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | `gpt-6-astra` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `glm-5.3-flash` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `gpt-6.1-sol` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `gpt-6-luna` |

`ANTHROPIC_CUSTOM_MODEL_OPTION`은 `glm-5.3`을 모델 선택기에 추가한다.
기본 모델은 `opus`로 유지한다.
모델별 `modelSettings.autoCompactWindow` 설정에는 Claude Code v2.1.288 이상이 필요하다.

### Model pricing

`.claude/settings.json`의 `modelPricing.overrides`는 모델별 백만 토큰당 USD 가격을 담는다.
가격 데이터는 기존 `.claude/managed-settings.json` 템플릿에서 일반 프로젝트 설정으로 통합되었고 템플릿 파일은 삭제되었다.
Claude Code 2.1.302는 사용자, 프로젝트, 로컬 설정과 `--settings`에서 `modelPricing`을 무시한다.
따라서 이 값은 요청된 표시용 데이터이고 실제 비용 계산을 활성화하지 않는다.
가격을 적용하려면 지원되는 관리형 설정 범위에 배포해야 한다.
macOS 시스템 관리형 설정 파일 경로는 `/Library/Application Support/ClaudeCode/managed-settings.json`이다.
네이티브 네 가격 필드는 GPT의 272K 초과 컨텍스트 계층을 표현하거나 공급자 청구액을 증명하지 않는다.
자세한 내용은 [Claude Code settings reference][managed-pricing]를 참조한다.

[managed-pricing]:
  https://code.claude.com/docs/en/settings-reference#modelpricing

### Agent guidance

Use the installed Workgraph Main Agent Contract in main sessions.
In Codex, read its bundled `references/codex.md`.
In Claude Code, read its bundled `references/claude.md`.
Skip reads only when the complete selected instructions are already loaded.
Instruction reads do not import config or activate plugins.
Keep model choices, workload tiers, roles, and effort policy in that reference.
The Sample preserves product selectors and provider mappings.
Supported-capability metadata uses the explicitly requested conservative declarations.
Omitted operational overrides use native host behavior.
Explicit user choices still apply.

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
  cp "$module" "$dest/statusline/$(basename "$module")"
done
```

The statusline command and global settings use a nonempty `CLAUDE_CONFIG_DIR`.
Otherwise, they use `$HOME/.claude`.
Project `.claude/settings.json` addon settings still take precedence.
Credential file references resolve relative to the selected settings directory.

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

Use Node.js 24 LTS and the pnpm version declared in `package.json`.
Run `pnpm install --frozen-lockfile` from the repository root.
Installation activates Husky's Git hooks.
The hooks run `pnpm run pre-commit` and `pnpm run pre-push` respectively.
Both scripts run Markdownlint, Ultracite and the offline regression tests.
The pnpm overrides select patched TOML and math parser dependencies.
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

These practices follow [pstack's lifecycle guide][pstack-lifecycle].
The check scripts align with [Sinon's harness tooling][sinon-tooling].

[pstack-lifecycle]: https://github.com/cursor/plugins/blob/main/pstack/docs/guide/06-verify-and-ship.md
[sinon-tooling]: https://github.com/ririnto/sinon/tree/main/plugins/harness/tooling/pnpm

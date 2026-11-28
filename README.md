# CLIProxyAPI Sample

로컬 프록시 하나로 Codex OAuth 모델과 Z.ai의 GLM 모델을 사용할 수 있다.
Homebrew와 Docker Compose 중 하나를 선택하고 저장소 루트에서 시작한다.
두 설치 방식 모두 기본 접속 주소는 `http://127.0.0.1:8317`이다.

## Homebrew로 실행

CLIProxyAPI v8 이상을 설치한다.

```sh
brew install cliproxyapi
cp -i config.example.yaml "$(brew --prefix)/etc/cliproxyapi.conf"
```

Homebrew는 설치할 때 기본 설정 파일도 만든다.
기존에 사용하던 설정이 있다면 복사 확인에 `n`을 입력하고 필요한 항목을 병합한다.
GLM을 사용하려면 복사한 설정의 `__ZAI_API_KEY__`를 Z.ai 키로 교체한다.
`server.host`는 `127.0.0.1`로 유지한다.

```sh
brew services start cliproxyapi
brew services info cliproxyapi
```

GPT를 사용하려면 같은 사용자로 로그인한다.

```sh
cliproxyapi --codex-device-login
```

`server.trusted-proxies`처럼 재시작이 필요한 값을 바꾸면
`brew services restart cliproxyapi`를 실행한다.
서비스를 종료할 때는 `brew services stop cliproxyapi`를 사용한다.

## Docker Compose로 실행

```sh
cp -i config.example.yaml config.yaml
```

기본 bridge 네트워크에서는 `config.yaml`의 `server.host`를 `"0.0.0.0"`으로 바꾼다.
[Compose 설정](compose.yaml)은 호스트의 `127.0.0.1:8317`만 컨테이너에 연결한다.
GLM을 사용하려면 이 파일에서 `__ZAI_API_KEY__`를 Z.ai 키로 교체한다.

```sh
docker compose up -d
docker compose ps
```

GPT를 사용하려면 컨테이너에서 로그인한다.
계정 파일은 호스트의 `./auths`에 남는다.

```sh
docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI -no-browser --codex-device-login
```

Linux에서 host 네트워크를 선택하면 서비스에 `network_mode: host`를 설정하고
`ports`를 제거한 뒤 `server.host`를 `"127.0.0.1"`로 유지한다.
Docker Desktop에서는 host networking을 먼저 활성화해야 한다.

| Compose 환경 변수 | 기본값 |
| --- | --- |
| `CLI_PROXY_IMAGE` | `eceasy/cli-proxy-api` |
| `CLI_PROXY_CONFIG_PATH` | `./config.yaml` |
| `CLI_PROXY_AUTH_PATH` | `./auths` |
| `CLI_PROXY_LOG_PATH` | `./logs` |
| `CLI_PROXY_PLUGIN_PATH` | `./plugins` |

## 모델 목록 확인

```sh
curl --fail --silent --show-error http://127.0.0.1:8317/v1/models
```

응답의 `data[].id`에서 프록시가 공개한 모델 ID를 확인한다.

GPT가 보이지 않으면 서비스를 실행한 환경에서 Codex 로그인을 마쳤는지 확인한다.
실제 모델 접근 권한은 해당 계정으로 추론 요청을 보냈을 때 확인할 수 있다.

샘플의 `access.api-keys` 목록은 비어 있다.
여기에 클라이언트 키를 추가했다면 요청에 `Authorization: Bearer <클라이언트 키>` 헤더를 보낸다.
프록시는 모델 ID에 해당하는 공급자의 키를 사용한다.

이 샘플의 클라이언트 컨텍스트 한도는 292,000토큰이다.
프록시는 Z.AI의 [Anthropic Messages API](https://docs.z.ai/devpack/tool/claude)로 GLM 요청을 보낸다.
GLM-5.4 경로는 텍스트와 이미지 입력, 함수 호출, 스트리밍을 지원한다.
GLM-5.4와 GLM-5.3-Flash의 `low`, `high`, `max` 요청은 그대로 전달한다.
`medium`은 `high`로, `xhigh`는 `max`로 변환한다.

| 요청 | 프록시 동작 |
| --- | --- |
| 이전 GPT 모델 ID | 같은 계열에서 카탈로그에 공개된 최신 Astra, Sol, Terra 또는 Luna 모델로 연결한다. |
| `chatgpt/` 접두사 | OAuth 계정 파일에 `"prefix": "chatgpt"`를 지정하면 접두사로도 요청할 수 있다. |

## Codex 모델 선택기 연결

[Codex 설정](.codex/config.toml)은 로컬 프록시를 사용하며 기본 모델은 `gpt-6.2-sol`이다.
사용자 설정으로 적용하려면 먼저 카탈로그를 복사한다.

```sh
codex_dir="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$codex_dir"
cp -i .codex/model_catalog.json "$codex_dir/model_catalog.json"
```

같은 디렉터리의 `config.toml`에 아래 항목을 병합한다.
앞의 세 줄은 첫 번째 테이블 위에 둔다.
이미 있는 키나 테이블은 한 번만 선언한다.

```toml
model_provider = "openai"
model_catalog_json = "model_catalog.json"
openai_base_url = "http://localhost:8317/v1"

[model_providers.openai]

[shell_environment_policy.set]
NODE_USE_SYSTEM_CA = "1"
```

`model_providers.openai` 테이블은 비워 둔다.
`shell_environment_policy.set`의 `NODE_USE_SYSTEM_CA`는 Codex가 실행한 셸 명령에서 Node.js가 시스템 CA 인증서를 사용하도록 설정한다.
새 Codex 세션에서 `/model`을 열어 `gpt-6.2-sol`, GLM-5.4, GLM-5.3-Flash가 표시되는지 확인한다.

전체 파일을 적용하면 `approval_policy = "on-request"`와
`sandbox_mode = "danger-full-access"`도 적용된다.
Codex는 승인을 요청할 수 있고, 실행한 명령은 사용자 권한으로 파일과 네트워크에 접근한다.
[OpenCode V2 설정](opencode.json)은 모든 작업과 리소스에 `allow`를 지정한다.
두 클라이언트의 유효 권한은 프로젝트 신뢰 및 조직 정책의 영향도 받는다.

- [Codex 설정 참조](https://developers.openai.com/codex/config-reference/)
- [OpenCode 권한](https://opencode.ai/docs/permissions/)

## 사용자 지침과 Cursor 규칙 설치

저장소 루트에서 실행한다.
대상에 로컬 지침이나 심볼릭 링크가 있다면 복사 전에 내용을 확인하고 보존할 항목을 병합한다.

```sh
claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
codex_dir="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$claude_dir" "$codex_dir" "$HOME/.cursor/rules"
cp -i .claude/AGENTS.md "$claude_dir/CLAUDE.md"
cp -i .codex/AGENTS.md "$codex_dir/AGENTS.md"
cp -i .cursor/rules/pstack-models.mdc "$HOME/.cursor/rules/pstack-models.mdc"
```

새 세션을 시작하면 각 클라이언트가 사용자 지침을 읽는다.
Codex 사용자 디렉터리에 비어 있지 않은 `AGENTS.override.md`가 있으면 그 파일이 우선한다.

## Claude Code 상태줄 설치

```sh
dest="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$dest/statusline"
cp .claude/statusline.ts .claude/subagent-statusline.ts "$dest/"
cp .claude/statusline/*.ts .claude/statusline/providers.json "$dest/statusline/"
```

다음 항목을 사용자 [`settings.json`](.claude/settings.json)에 병합한다.

- `statusLine`
- `subagentStatusLine`

Claude Code를 재시작한다.

## Codex CLI 상태줄 설치

```sh
codex_dir="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$codex_dir/statusline"
cp -i .codex/statusline.ts "$codex_dir/statusline.ts"
cp -i .codex/statusline/*.ts .codex/statusline/providers.json "$codex_dir/statusline/"
```

저장소의 `.codex/statusline`은 `.claude/statusline`을 가리키는 심볼릭 링크다.
설치 명령은 공급자 파일을 Codex 설정 디렉터리에 복사하므로 Claude Code를 설치하지 않아도 된다.

Claude Code와 Codex CLI 상태줄은 `~/.cache/statusline/usage.sqlite`에서 사용량을 공유한다.
같은 공급자와 인증 정보 조합의 갱신은 한 프로세스만 수행한다.
기본 캐시 유효 시간은 30초이며, 서버가 더 늦은 재시도 시각을 반환하면 그 값을 우선한다.
다른 세션은 갱신을 기다리지 않고 남아 있는 사용량을 표시한다.
Codex의 상태줄 MCP 서버는 1초 응답 제한에 여유를 두고 최대 800ms 동안 조회 결과를 기다린다.
조회가 늦으면 마지막으로 저장한 사용량을 표시하고, 캐시가 비어 있으면 기본 상태줄을 표시한다.
별도 프로세스가 캐시 갱신을 이어가므로 Codex를 닫아도 이미 시작한 갱신은 저장할 수 있다.
30분이 지난 사용량에는 조회 시각을 UTC로 표시한다.
기존 설치를 갱신할 때는 두 상태줄과 `statusline/`의 모듈을 함께 다시 복사한다.

다음 설정은 프로젝트가 아닌 사용자 [`config.toml`](.codex/config.toml)에 병합한다.
`CODEX_HOME`이 지정되어 있지 않으면 `$HOME/.codex`를 사용한다.

```toml
[features]
tui_extensions_statusline = true

[mcp_servers.statusline]
command = "sh"
args = ["-c", 'exec node "${CODEX_HOME:-$HOME/.codex}/statusline.ts"']
env_vars = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "MINIMAX_API_KEY", "MISTRAL_API_KEY", "ZHIPU_API_KEY"]

[mcp_servers.statusline.env]
NODE_USE_SYSTEM_CA = "1"

[tui.status_line_provider]
server = "statusline"
tool = "statusline"
```

Codex는 상태줄 MCP 서버를 별도로 실행하므로 서버의 `env`에 `NODE_USE_SYSTEM_CA`를 지정한다.
이미 해당 `env` 테이블이 있으면 기존 키를 유지하고 `NODE_USE_SYSTEM_CA`만 추가하거나 갱신한다.
Codex CLI를 재시작한다.

## 개발 검증

| 바꿀 항목 | 수정할 파일 | 다시 생성 |
| --- | --- | --- |
| Codex에서 표시하는 모델 | [Codex override](.codex/model_catalog.override.yaml) | `pnpm run generate:model-catalog` |
| 프록시 라우트, 모델 및 컨텍스트 기본값 | [모델 설정](cliproxyapi/models.yaml) | `pnpm run generate:config` |
| 프록시 공통 설정과 요청 필터 | [프록시 재정의](cliproxyapi/config.overrides.yaml) | `pnpm run generate:config` |

`pnpm run generate`는 두 설정과 pstack 에이전트 파일을 모두 갱신한다.
각 생성기는 공식 Codex 카탈로그를 직접 읽으며 다른 생성기의 결과를 읽지 않는다.
프록시 생성기는 [CLIProxyAPI의 main 샘플](https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml)에 로컬 설정을 적용한다.

### 모델 설정

- Codex override는 같은 slug의 필드만 덮어쓰며 새 모델은 공식 카탈로그의 첫 모델을 바탕으로 추가한다.
- 업그레이드가 있는 항목과 같은 GPT 계열의 이전 버전은 Codex 목록에서 숨긴다.
- 샘플 Codex 카탈로그의 `context_window`는 최대 292,000이며, 모델별 override 없이 적용한다.
- 프록시의 Codex OAuth 별칭은 같은 계열의 가장 높은 공개 버전을 가리킨다.
- 모델별 `context_window`를 지정하면 `default_context_window`보다 커도 그 값을 사용한다.
- `efforts`는 지원하는 값을 낮은 값부터 적는다.
- 반복되는 `efforts`와 `supported_reasoning_levels` 목록은 각 필드 안에서 `<<: &이름`으로 정의하고 `<<: *이름`으로 재사용한다.
- Z.ai 라우트 키에는 샘플 값만 두고 운영 키는 설치한 설정에 넣는다.

### 프록시 재정의

| 키 | 적용 방식 |
| --- | --- |
| `anchor` | 일치시킬 업스트림 텍스트 블록 |
| `comment: true` | 원래 내용을 주석으로 남기고 아래에 새 값 추가 |

`pnpm run generate:agents`는 [upstream pstack 에이전트](https://github.com/cursor/plugins/tree/main/pstack/agents)의 Markdown을 가져와 `.codex/agents/`의 `poteto-agent.toml`과 `comment-sicko.toml`을 갱신한다.
갱신한 TOML을 사용자 설정으로 적용하려면 `${CODEX_HOME:-$HOME/.codex}/agents/`에 복사한다.

기여 시 [공통 개발 지침](.agents/engineering.md)을 참고한다.
[package.json](package.json)에 지정된 Node.js와 pnpm을 사용한다.

```sh
pnpm install --frozen-lockfile
pnpm run pre-push
```

`pnpm run pre-push`는 Markdownlint CLI2와 Ultracite를 실행한다.
[CI](.github/workflows/checks.yaml)는 잠금 파일대로 의존성을 설치하고 같은 lint 검사를 실행한다.

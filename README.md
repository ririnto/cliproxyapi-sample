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
GLM을 사용하려면 이 파일에서 `__ZAI_API_KEY__`를 교체한다.

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

응답의 `data[].id`에서 `glm-5.3`과 `glm-5.3-flash`를 확인한다.
GPT가 보이지 않으면 서비스를 실행한 환경에서 Codex 로그인을 마쳤는지 확인한다.
이 요청은 프록시가 공개한 모델 목록만 읽는다.
실제 모델 접근 권한은 해당 계정으로 추론 요청을 보냈을 때 확인할 수 있다.

샘플의 `access.api-keys` 목록은 비어 있다.
여기에 클라이언트 키를 추가했다면 요청에 `Authorization: Bearer <클라이언트 키>` 헤더를 보낸다.
Z.ai 키는 프록시가 Z.ai에 접속할 때 사용한다.

GLM 요청은 Z.ai의 Responses API로 전달한다.
요청한 reasoning effort보다 높은 지원 수준 중 가장 가까운 값을 사용한다.
더 높은 수준이 없으면 지원 최댓값을 사용한다.
`minimal` 요청은 상위 서비스에 전달하지 않고 거절한다.

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
```

빈 테이블에는 추가 설정이 필요 없다.
새 Codex 세션에서 `/model`을 열어 `gpt-6.2-sol`과 `glm-5.3`이 표시되는지 확인한다.

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
cp .claude/statusline.mjs .claude/subagent-statusline.mjs "$dest/"
cp .claude/statusline/*.mjs .claude/statusline/providers.json "$dest/statusline/"
```

다음 항목을 사용자 [`settings.json`](.claude/settings.json)에 병합한다.

- `statusLine`
- `subagentStatusLine`

Claude Code를 재시작한다.

## Codex CLI 상태줄 설치

```sh
codex_dir="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$codex_dir/statusline"
cp -i .codex/statusline.mjs "$codex_dir/statusline.mjs"
cp -i .codex/statusline/*.mjs .codex/statusline/providers.json "$codex_dir/statusline/"
```

저장소의 `.codex/statusline`은 `.claude/statusline`을 가리키는 심볼릭 링크다.
설치 명령은 공급자 파일을 Codex 설정 디렉터리에 복사하므로 Claude Code를 설치하지 않아도 된다.

다음 설정은 프로젝트가 아닌 사용자 [`config.toml`](.codex/config.toml)에 병합한다.
`CODEX_HOME`이 지정되어 있지 않으면 `$HOME/.codex`를 사용한다.

```toml
[features]
tui_extensions_statusline = true

[mcp_servers.statusline]
command = "sh"
args = ["-c", 'exec node "${CODEX_HOME:-$HOME/.codex}/statusline.mjs"']
env_vars = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "MINIMAX_API_KEY", "MISTRAL_API_KEY", "ZHIPU_API_KEY"]

[tui.status_line_provider]
server = "statusline"
tool = "statusline"
```

Codex CLI를 재시작한다.

## 개발 검증

`pnpm run generate`는 [공식 Codex 카탈로그](https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json)를 새로 받아 메타데이터 스냅샷을 갱신한다.
기존 GLM 모델과 카탈로그에서 사라진 모델을 유지하고 별칭 및 프록시 설정도 다시 생성한다.
`config/codex-models.json`, `config.example.yaml`, `.codex/model_catalog.json`을 함께 커밋한다.
`pnpm run check:generated`는 네트워크 없이 생성물의 차이를 확인한다.
[모델 라우팅](config/model-routes.mts)이나 [프록시 템플릿](config/proxy.template.yaml)을 수정한 뒤에도 `pnpm run generate`를 실행한다.
카탈로그에 새 숫자 버전 모델을 공개하고 다시 생성하면 각 등급에서 가장 높은 공개 모델이
직접 경로가 되고, 알려진 이전 숫자 버전은 자동으로 그 모델을 가리키는 별칭이 된다.

기여 시 [공통 개발 지침](.agents/engineering.md)을 참고한다.
[package.json](package.json)에 지정된 Node.js와 pnpm을 사용한다.
라우팅 테스트는 PATH의 `cliproxyapi`를 실행한다.
실행 파일 이름이 다르면 `CLIPROXYAPI_TEST_BINARY`에 절대 경로를 지정한다.

```sh
pnpm install --frozen-lockfile
pnpm run pre-push
```

이 명령은 문서 형식, 린트, 타입과 테스트를 검사한다.
라우팅 테스트는 임시 계정으로 모델 목록을 조회하고 로컬 Responses 서버에서 GLM 요청을 확인한다.
[CI](.github/workflows/checks.yaml)는 최신 Linux amd64 릴리스로 같은 검사를 실행하고
`docker compose -f compose.yaml config --quiet`로 Compose 설정을 확인한다.

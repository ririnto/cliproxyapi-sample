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
Codex provider에는 `support-prompt-cache-key`, `input-modalities`, `output-modalities`를 지정하지 않는다.
GPT 모델을 사용하려면 Codex OAuth로 로그인한다.

```bash
brew install cliproxyapi
vi "$(brew --prefix)/etc/cliproxyapi.conf"
```

```bash
brew services start cliproxyapi
brew services stop cliproxyapi
```

설정을 수정한 뒤에는 서비스를 재시작하지 않는다.

### Claude Code

`.claude/settings.json`에서 기본 모델을 `opus`로 선택한다.
`ANTHROPIC_DEFAULT_OPUS_MODEL`은 `gpt-6.1-sol[1m]`로 설정한다.
`modelOverrides`의 `claude-opus-5-5`에도 `gpt-6.1-sol`을 지정한다.
Fable, Sonnet, Haiku의 모델 선택과 fallback은 기존 값을 사용한다.

### Codex 로그인

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

### Codex 로그인

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

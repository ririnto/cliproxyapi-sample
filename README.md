# CLIProxyAPI Sample

## Homebrew 로컬 설치

Homebrew로 설치하면 `$(brew --prefix)/etc/cliproxyapi.conf`를 설정 파일로 사용한다.
기본 경로는 Apple Silicon에서 `/opt/homebrew/etc/cliproxyapi.conf`, Intel Mac에서 `/usr/local/etc/cliproxyapi.conf`다.

`config.example.yaml`을 참고해 파일을 편집하고, `__ZAI_API_KEY__`를 Z.ai API 키로 바꾼다.

```bash
brew install cliproxyapi
vi "$(brew --prefix)/etc/cliproxyapi.conf"
```

```bash
brew services start cliproxyapi
brew services restart cliproxyapi
brew services stop cliproxyapi
```

### Codex 로그인

```bash
cliproxyapi --codex-device-login
```

## Docker Compose

### 설정

`config.example.yaml`을 `config.yaml`로 복사하고 `__ZAI_API_KEY__`를 Z.ai API 키로 바꾼다.
Docker의 기본 bridge network에서는 `config.yaml`의 `host`를 `"0.0.0.0"`으로 변경해야 포트 매핑으로 접속할 수 있다.
현재 Compose의 포트 매핑은 호스트의 `127.0.0.1:8317`에만 공개된다.
대신 host network를 사용하려면 Compose 서비스에 `network_mode: host`를 설정하고 `ports` 항목을 제거한다.
이 경우 `config.yaml`의 `host: "127.0.0.1"`을 유지할 수 있다.
Host network는 Linux Docker Engine에서 지원하며, Docker Desktop에서는 지원 버전의 host networking 기능을 별도로 활성화해야 한다.

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

로그인 정보는 `${CLI_PROXY_AUTH_PATH:-./auths}`에 저장된다.

## Status line

저장소 루트에서 실행한다.

```sh
dest="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$dest/statusline"
cp ".claude/statusline.mjs" "$dest/statusline.mjs"
for module in ".claude/statusline/"*.mjs; do
  cp "$module" "$dest/statusline/$(basename "$module")"
done
```

애드온 스크립트 경로 규칙:

- 절대 경로는 그대로 사용한다.
- `~`와 `~/...`는 홈 디렉터리로 확장한다.
- 상대 경로는 실행 중인 `statusline.mjs` 위치를 기준으로 해석한다.

## 환경 변수

경로와 이미지를 바꾸려면 설정한다.

- `CLI_PROXY_IMAGE` (기본값 `eceasy/cli-proxy-api`)
- `CLI_PROXY_CONFIG_PATH`
- `CLI_PROXY_AUTH_PATH`
- `CLI_PROXY_LOG_PATH`
- `CLI_PROXY_PLUGIN_PATH`

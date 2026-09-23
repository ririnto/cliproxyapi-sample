# CLIProxyAPI Sample

## Homebrew 로컬 설치

Homebrew로 설치한 CLIProxyAPI는 `$(brew --prefix)/etc/cliproxyapi.conf`에서 설정을 읽는다.
Apple Silicon의 기본 경로는 `/opt/homebrew/etc/cliproxyapi.conf`이고 Intel Mac의 기본 경로는 `/usr/local/etc/cliproxyapi.conf`다.

`config.example.yaml`을 참고해 설정 파일을 편집한다.
`__ZAI_API_KEY__`를 Z.ai API 키로 바꾼다.

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
Docker의 기본 bridge network를 사용한다면 `config.yaml`의 `host`를 `"0.0.0.0"`으로 바꾼다.
Compose는 컨테이너 포트를 호스트의 `127.0.0.1:8317`에 연결한다.
Host network를 사용하려면 Compose 서비스에 `network_mode: host`를 설정하고 `ports` 항목을 제거한다.
이때 `config.yaml`의 `host: "127.0.0.1"`을 유지할 수 있다.
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

# Claude Code 모델 설정

[settings.json](settings.json)은 선택자별 모델 ID를 지정한다.
`ANTHROPIC_BASE_URL`은 로컬 프록시의 `http://localhost:8317`을 가리킨다.

| 선택자 | 요청 모델 |
| --- | --- |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | `gpt-6.2-astra` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `gpt-6.2-sol` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `gpt-6.1-terra` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `gpt-6-luna` |
| `ANTHROPIC_CUSTOM_MODEL_OPTION` | `glm-5.3` |

## Gemini 컨텍스트와 effort

두 Gemini 항목의 `effortLevel`은 `medium`, `maxEffortLevel`은 `high`다.
모델별 `autoCompactWindow` 설정에는 Claude Code 2.1.288 이상이 필요하다.
샘플의 `autoCompactWindow`와 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`는 모두 305000이다.
Claude Code 2.1.302는 인식한 모델 용량을 적용하고 안전 여유분을 남기므로
실제 압축 시점은 305000보다 이를 수 있다.
[Gemini thinking 문서](https://ai.google.dev/gemini-api/docs/thinking)

## 가격 표시

아래 값은 샘플에 기록된 백만 토큰당 USD다.
Claude Code 2.1.302에서 이 값을 비용 계산에 쓰려면 지원되는 관리형 설정에
`modelPricing.overrides`를 배포해야 한다.
macOS 시스템 경로는 `/Library/Application Support/ClaudeCode/managed-settings.json`이다.
[Claude Code 설정 참조](https://code.claude.com/docs/en/settings-reference#modelpricing)

| 모델 | 입력 | 캐시 입력 | 출력 | 프로모션 종료일 |
| --- | ---: | ---: | ---: | --- |
| `gemini-3.8-flash` | 0.75 | 0.075 | 3.75 | 2026-12-31 |
| `gemini-4-argon` | 2.00 | 0.10 | 10.00 | 2026-12-01 |

`cacheWrite: 0`은 샘플에 별도 캐시 쓰기 단가가 없다는 뜻이다.
GPT의 272K 초과 장문 가격처럼 입력 길이에 따라 달라지는 요금은 네 가격 필드로 표현할 수 없다.
실제 청구액은 사용한 공급자의 요금표에서 확인한다.

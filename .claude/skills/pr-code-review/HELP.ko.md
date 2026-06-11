**/pr-code-review** — crispin-lab org 전용 PR 리뷰 / 답글 자동화 스킬

## 사용법

```
/pr-code-review <target> [flags]
```

`<target>`
- `owner/repo#NUMBER` 형식 — 예: `crispin-lab/crispin-lab-backend#42`
- 또는 PR URL — 예: `https://github.com/crispin-lab/crispin-lab-frontend/pull/17`

`owner` 는 항상 `crispin-lab` 이어야 합니다.

## 두 가지 모드

**리뷰 모드 (기본)** — PR diff를 보고 인라인 + 요약 리뷰를 한 번에 게시
1. PR 메타데이터 / diff / linked issues 수집
2. 대상 repo의 `.claude/` 룰을 PR head SHA 기준으로 로드
3. 큰 PR 가드 + 같은 head SHA에 대한 rate-limit 가드
4. 이전 봇 코멘트와 fingerprint 비교해 중복 제거
5. Claude가 룰 기반으로 리뷰 → (선택) codex 비평 → 사용자 확인 → 단일 GitHub Review로 게시
6. PR에 👀 (시작) / 🎉 (완료) 반응 자동 처리

**답글 모드 (`--reply`)** — 이전 봇 리뷰 스레드의 답글에 응답 + 수정 확인 시 자동 resolve
1. GraphQL 로 리뷰 스레드 전체 조회
2. **봇이 시작했고 마지막 commenter가 봇이 아닌** 미해결 스레드만 처리 (루프 방지)
3. 처리 대상 스레드의 사용자 마지막 답글에 👀 **즉시** 게시 (분류 LLM 호출 전, "보고 있다" 신호)
4. 각 답글의 의도 분류: fixed / disagreement / clarification / agreement / question
5. "수정함" 이라고 했고 HEAD 파일에서 실제 변경이 확인되면 → 확인 코멘트 + 스레드 resolve + 👀→🎉
6. 그 외엔 적절한 답글만 게시 + 👀 제거

## 플래그

| 플래그 | 모드 | 설명 |
|---|---|---|
| `--help`, `-h` | 둘 다 | 이 도움말 출력 후 종료 |
| `--dry-run` | 둘 다 | 게시 없이 결과만 `/tmp/pcr-*.md` 로 저장. 👀 반응만 PR 에 남음. `--yes` 보다 우선 — 같은 대화에서 "게시" 라고 말하면 재리뷰 없이 바로 POST |
| `--yes`, `-y` | 둘 다 | **모든** 확인 프롬프트를 자동으로 "continue" 로 응답. 게시 미리보기(step 8) / 답글 digest(R5) / closed·merged·draft 경고(step 3) / **큰 PR 가드(step 4 — 전체 리뷰로 진행)** / "게시할까요?" 류 self-check 모두 포함. 멈추는 건 묻지 않고 그냥 거절하는 케이스 (rate-limit, target 파싱 실패, 봇 미로그인, GitHub API 에러) 뿐. rate-limit 도 우회하려면 `--force`. `--dry-run` 과 같이 쓰면 무의미 |
| `--reply` | 답글 | 답글 모드로 전환 (diff 리뷰 안 함) |
| `--focus <cat>[,...]` | 리뷰 | 카테고리 한정. 가능: `correctness`, `security`, `conventions`, `reuse`, `perf`, `tests` |
| `--with-codex` | 리뷰 | codex CLI 로 finding을 한 번 더 검증 (false-positive 제거) |
| `--auto-reply` | 리뷰 | 리뷰 게시 후 자동으로 답글 모드까지 이어서 실행. `--yes` 와 조합하면 완전 무중단 |
| `--force` | 리뷰 | 큰 PR 가드 + rate-limit 가드 모두 우회. `--yes` 만으로도 큰 PR 가드는 이미 자동 "continue" 라, 보통은 rate-limit 강제 우회용 |

## 예시

```
# 일반 리뷰
/pr-code-review crispin-lab/crispin-lab-backend#42

# 리뷰 미리 보기만
/pr-code-review crispin-lab/crispin-lab-backend#42 --dry-run

# 보안 + 컨벤션만 + codex 검증
/pr-code-review crispin-lab/crispin-lab-backend#42 --focus security,conventions --with-codex

# 답글 처리 + 수정 확인 시 자동 resolve
/pr-code-review crispin-lab/crispin-lab-backend#42 --reply

# 답글 처리 미리 보기
/pr-code-review crispin-lab/crispin-lab-backend#42 --reply --dry-run

# 리뷰 + 답글까지 한 번에, 확인 프롬프트 없이
/pr-code-review crispin-lab/crispin-lab-backend#42 --auto-reply --yes
```

## 사전 셋팅

봇 계정 1회 로그인이 필요합니다. `~/.claude/skills/pr-code-review/SETUP.md` 참조.

더 자세한 동작 방식은 `~/.claude/skills/pr-code-review/SKILL.md` 본문을 보시면 됩니다.

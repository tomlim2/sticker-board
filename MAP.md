# Project Map

스티커 떼었다 붙이기. 아무 이미지(PNG, 움직이는 GIF 등)나 넣으면 실루엣을 따라 흰 칼선이 둘러진 다이컷 스티커가 되고,
시트에서 몇 장이고 떼어 판 위 아무 데나 붙일 수 있다. Three.js(WebGL) + Vite, 프레임워크 없음.
인터랙션·애니메이션은 60fps 고정 스텝.

## 구조

```
index.html                마크업: 판(#board) / 스티커 시트(#sheet) / WebGL 캔버스(#stage) / HUD
vite.config.js            base './' (하위 경로 배포용)
public/favicon.svg
src/
  main.js                 진입점. 렌더 루프, 스티커 상태, 입력(벗기기·들기·붙이기), 시트 배치, 파일 넣기, 저장
  sticker-art.js          이미지(프레임들) → 스티커 텍스처·그림자·판정 마스크 (cutSticker), 기본 스티커 6종 (PRESETS)
  frames.js               움직이는 이미지 → 프레임 목록 (decodeFrames: ImageDecoder, 없으면 GIF 는 omggif)
  sticker-material.js     벗겨지는 말림 셰이더 (createStickerMaterial), 그림자 셰이더 (createShadowMaterial)
  store.js                IndexedDB 키-값 (get / set / remove)
  sound.js                WebAudio 효과음 (peel / stick / swish)
  style.css               판 배경 3종, 시트(이형지), HUD
.github/workflows/deploy.yml   v* 태그 push → GitHub Pages 배포
```

화면 층: 판(z0) → 시트(z1) → 캔버스(z2, `pointer-events: none`) → HUD(z3).
캔버스가 입력을 막지 않으니 모든 포인터 입력은 `window` 에서 받아 직접 스티커를 판정한다 (버튼·라벨 위는 제외).

## 이미지 → 스티커 (sticker-art.js `cutSticker`)

1. 투명한 여백을 잘라 내고, 긴 변 512 텍스처 안에 테두리·그림자 여백(`PAD`)을 두고 배치
2. 알파 0.2~0.6 을 실루엣으로 (옅은 그림자·번짐은 테두리를 키우지 않게)
3. 실루엣을 흐린 뒤(상자 흐림 3회 ≈ 가우시안, σ = 테두리/2) 낮은 문턱(`EDGE`)으로 자르면 약 `BORDER`(28px) 두께로 둥글게 부푼 칼선.
   좁은 틈과 작은 구멍이 메워져서 떨어진 조각도 한 장으로 이어짐
4. 흰 칼선 위에 원본을 `source-atop` 으로 → 칼선 밖으로 나간 반투명 부분은 잘림
5. 칼선을 한 번 더 흐려 그림자, 칼선 알파를 그대로 클릭 판정 마스크로

기본 스티커(smile, heart, star, bolt, wow, hello)는 캔버스에 벡터로 그려서 같은 과정을 거친다.

## 움직이는 스티커 (GIF, 움직이는 WebP·PNG)

- `frames.js` `decodeFrames(blob)`: 브라우저 내장 `ImageDecoder` 로 프레임과 지연 시간을 꺼냄. 없는 브라우저에선 GIF 만
  `omggif` 로 직접 풀고 disposal(2 = 배경으로, 3 = 이전 화면으로)을 처리. 한 장짜리면 null → 정지 스티커
- 프레임은 긴 변 384px 로 줄이고 120장이 넘으면 건너뛰며 줄임 (지연 시간은 그만큼 늘림). 0~10ms 지연은 브라우저처럼 100ms
- 칼선은 모든 프레임을 겹친 실루엣으로 한 번만 만듦 → 움직이는 부분이 칼선 밖으로 안 나감
- 렌더 루프의 `animateDesigns` 가 지연 시간대로 프레임을 넘기고, 바뀔 때만 `compose(frame)` 로 텍스처 캔버스를 다시 그려
  올림. 같은 도안의 스티커(시트 + 판 위 복사본)는 텍스처를 같이 써서 다 같이 움직이고 업로드도 한 번
- 저장은 원본 파일 그대로 (PNG 로 다시 구우면 움직임이 사라짐). 15MB 넘으면 지금만 쓰고 저장 안 함

## 벗겨지는 셰이더 (sticker-material.js)

스티커 = 48×48 로 나눈 평면. 접히는 선에서의 거리 d 로 정점을 옮긴다.

| 영역 | 위치 | 보이는 면 |
|---|---|---|
| d < 0 | 그대로 바닥 | 앞면 |
| 0 ≤ d < πR | 반지름 R 원기둥을 따라 말려 올라감 (θ = d/R) | 앞면 → 뒷면 |
| d ≥ πR | 뒤집혀서 높이 2R 에 평평하게 | 뒷면(접착면 색 `uBack`) |

- 깊이 버퍼 없이 겹침을 맞추려고 같은 스티커를 영역별 4패스로 그림 (`uPass` 0 바닥 → 1 말림 아래 → 2 말림 위 → 3 뒤집힌 부분). 안 벗길 땐 0번만
- 말린 면의 법선으로 명암·반짝임, 말린 곳 앞 바닥엔 접촉 그림자, 앞면엔 대각선 비닐 광택(`uSheen`)
- 텍스처는 미리 곱한 알파(premultiplied)라 가장자리에 검은 테가 안 낌
- 그림자 셰이더도 같은 접힘 uniform 을 받아 들린 부분 아래 그림자를 지움

## 조작 흐름 (main.js)

```
누름(press) → 5px 넘게 끌면 peel: 어디를 잡았든 끄는 반대쪽 가장자리부터 말려 올라옴 (setPeel)
             벗겨진 비율 ≥ DETACH_AT(0.9) 이어야 떨어짐. 접힌 끝이 손을 따라오니 스티커 길이의 약 1.8배를 끌어야 함
떨어짐(detach) → 들기(hold): 잡은 점이 손가락 밑으로 따라옴, 옆으로 흔들면 기울어짐
놓음 ─┬─ 시트 위 → 돌려놓기 (판에서 사라짐)
      └─ 판 위   → 붙이기 (꾹 눌리는 스프링 + 소리)
떨어지기 전에 놓음 → 다시 착 붙음 (settle)
```

- 시트 스티커는 누르는 순간 똑같은 복제본(`pending`)을 위에 만들어 그걸 벗김 → 시트는 그대로, 몇 장이고 뗄 수 있음
- 시트 스티커를 움직이지 않고 톡 → 판 아무 데나 날아가 붙음 (`flyToBoard`)
- 들고 있을 때: 휠 = 회전, ⇧/⌃/⌥+휠(트랙패드 핀치 포함) = 크기, Q/E = 15° 회전, 두 번째 손가락 = 회전·크기
- 시트 칸 위에 마우스를 올리면 × (그 도안과 판에 붙인 것 모두 지움)
- 이미지 넣기: 시트의 + / 화면에 끌어다 놓기(판 위면 그 자리에 한 장 붙음) / ⌘V 붙여 넣기. PNG·JPG·GIF·WebP 등 브라우저가 읽는 건 다 됨
- 창이 포커스를 잃으면(blur) 들고 있던 걸 놓음

주요 상수(`main.js` 위): `DETACH_AT`, `HOLD_FOLLOW`, `SHEET_FILL`, `MIN_SCALE`/`MAX_SCALE`, `MAX_SAVED_BYTES`.
판 위 스티커 크기는 `boardSize()` (화면 짧은 변의 24%, 110~190px).

## 렌더 루프: 60fps 고정

- 들기·스프링·말림 되돌리기 등 모든 움직임은 1/60초 고정 스텝(`STEP`)으로 계산 → 60Hz·120Hz 화면 어디서나 같은 속도와 느낌
- 120Hz 화면에선 rAF 두 번에 한 번만 그림. 밀리면 최대 4스텝까지 따라잡고, 그보다 밀리면 박자를 지금으로 맞춤
- 움직이는 게 없으면 그리지 않음 (GIF 는 자기 지연 시간대로 프레임이 바뀔 때만 그림)

## 저장 (store.js, IndexedDB `sticker-board`)

| 키 | 값 |
|---|---|
| `state` | `{ version, background, sound, designs: [{ id, kind: 'preset' \| 'image', preset }], placed: [{ design, x, y, rotation, scale }] }` |
| `blob:<id>` | 사용자가 넣은 이미지. 정지 이미지는 긴 변 1024 로 줄인 PNG, 움직이는 이미지는 원본 그대로 |

위치는 화면 비율(0~1)로 저장해서 창 크기가 달라도 비슷한 자리에 놓인다. `placed` 는 아래 → 위 순서.
저장이 없으면(처음) 기본 스티커 6종 + 판에 3장을 붙여 시작 (`seed`).

## 명령어

```bash
npm run dev      # 개발 서버
npm run build    # dist/ 빌드
npm run preview  # 빌드 결과 미리보기
```

## 배포

- 사이트: https://tomlim2.github.io/sticker-board/
- 저장소: https://github.com/tomlim2/sticker-board

버전을 올리면 배포됨 (dice-roll, 허브와 같은 방식):

```bash
npm version patch   # minor / major 도 됨
```

버전 커밋 + `v*` 태그 → `postversion` 이 push → 태그가 `deploy.yml` 을 돌려 GitHub Pages 에 올림.
Pages 소스는 GitHub Actions, `github-pages` 환경은 `main` 브랜치와 `v*` 태그 배포를 허용해 둠.
허브(llm-playground)에 등록돼 있어서, 새로 배포하면 1시간 안에 허브 썸네일·버전도 알아서 바뀜.

# KGM ML 검사 Agent

제품 사진 또는 검사 이미지를 업로드하면 `helpy-v-reasoning-c` 모델을 호출해 다음 항목을 생성하는 로컬 웹 Agent입니다.

- 정상/의심/불량 가능성 판정
- 불량 의심 부위 설명
- 가능한 불량 유형 분류
- 검사자 확인 체크리스트
- 최종 판정 기록용 코멘트

## 실행

```bash
cp .env.example .env
```

`.env` 값을 본인 API 환경에 맞게 설정합니다.

```bash
export HELPY_API_URL="https://mlapi.run/YOUR_API_ID"
export HELPY_API_KEY="YOUR_API_KEY"
export HELPY_MODEL="google/gemini-2.5-flash-image"
npm run dev
```

브라우저에서 `http://localhost:3000`을 엽니다.

## API 연결 구조

브라우저는 `/api/inspect`로 이미지 data URL과 검사 메타데이터를 전송합니다. Node 서버는 API 키를 사용해 `.env`의 `HELPY_API_URL` 엔드포인트를 호출합니다.

```http
POST {HELPY_API_URL}
```

모델 요청에는 이미지와 함께 품질 검사 전용 JSON 출력 프롬프트가 포함됩니다. 모델이 `<think>` 또는 `<answer>` 태그를 섞어 반환해도 서버에서 가능한 범위로 정리하고 JSON 파싱을 시도합니다.

`HELPY_API_URL`이 없으면 이전 방식처럼 `HELPY_API_BASE_URL`에 `/v1/chat/completions`를 붙여 호출합니다.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");

async function loadDotEnv() {
  try {
    const envFile = await readFile(join(__dirname, ".env"), "utf8");
    for (const line of envFile.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is optional; shell environment variables work as well.
  }
}

await loadDotEnv();

const port = Number(process.env.PORT || 3000);

const apiUrlOverride = process.env.HELPY_API_URL;
const apiBaseUrl = process.env.HELPY_API_BASE_URL;
const apiKey = process.env.HELPY_API_KEY;
const model = process.env.HELPY_MODEL || "google/gemini-2.5-flash-image";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function summarizeText(text, maxLength = 1200) {
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  return JSON.parse(body);
}

function buildInspectionPrompt({ productName, inspectionGoal, notes }) {
  return [
    "당신은 제조 품질 검사 보조 Agent입니다.",
    "업로드된 제품 사진 또는 검사 이미지를 보고 검사자가 참고할 수 있는 1차 시각 검사 결과를 작성하세요.",
    "",
    "중요 원칙:",
    "- 이미지만으로 확정할 수 없는 내용은 단정하지 말고 '의심' 또는 '확인 필요'로 표현합니다.",
    "- 안전/품질 최종 판정은 현장 검사자가 내린다는 전제로 보조 의견을 제공합니다.",
    "- 정상, 의심, 불량 가능성 중 하나로 판정하되 근거를 간결히 씁니다.",
    "- 한국어로 답변합니다.",
    "",
    `제품/공정 정보: ${productName || "미제공"}`,
    `검사 목적: ${inspectionGoal || "외관 및 불량 의심 부위 확인"}`,
    `추가 메모: ${notes || "없음"}`,
    "",
    "반드시 아래 JSON 형식만 반환하세요. <think> 또는 <answer> 태그를 쓰지 마세요.",
    JSON.stringify(
      {
        verdict: "정상 | 의심 | 불량 가능성",
        confidence: "낮음 | 보통 | 높음",
        summary: "한 문장 요약",
        suspected_areas: [
          {
            area: "의심 부위 위치",
            observation: "관찰 내용",
            reason: "판정 근거"
          }
        ],
        defect_types: [
          {
            type: "스크래치 | 찍힘 | 오염 | 변색 | 균열 | 조립 불량 | 치수/형상 이상 | 기타",
            likelihood: "낮음 | 보통 | 높음",
            evidence: "이미지상 근거"
          }
        ],
        inspector_checklist: [
          "검사자가 확인해야 할 항목"
        ],
        final_record_comment: "검사 기록에 붙여넣을 수 있는 최종 코멘트"
      },
      null,
      2
    )
  ].join("\n");
}

function getBase64Payload(dataUrl) {
  if (!dataUrl?.startsWith("data:")) return dataUrl;
  return dataUrl.split(",", 2)[1] || "";
}

function buildRequestBody({ apiUrl, imageSource, productName, inspectionGoal, notes }) {
  const prompt = buildInspectionPrompt({ productName, inspectionGoal, notes });
  if (apiUrl.includes("/images/generations")) {
    return {
      model,
      prompt,
      n: 1,
      size: "1024x1024",
      extra_body: {
        image: getBase64Payload(imageSource)
      }
    };
  }

  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageSource } }
        ]
      }
    ]
  };

  if (model.includes("gpt-5")) {
    body.max_completion_tokens = 4000;
  } else {
    body.max_tokens = 1600;
    body.temperature = 0.1;
  }

  return body;
}

function stripModelWrappers(content) {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?answer>/gi, "")
    .trim();
}

function parseInspectionContent(content) {
  const cleaned = stripModelWrappers(content);
  try {
    return { parsed: JSON.parse(cleaned), raw: content };
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return { parsed: JSON.parse(jsonMatch[0]), raw: content };
      } catch {
        // Fall through to raw response.
      }
    }
    return {
      parsed: {
        verdict: "의심",
        confidence: "낮음",
        summary: "모델 응답을 구조화하지 못했습니다. 원문 응답을 확인하세요.",
        suspected_areas: [],
        defect_types: [],
        inspector_checklist: ["모델 원문 응답 검토", "필요 시 이미지를 다시 촬영하여 재분석"],
        final_record_comment: cleaned
      },
      raw: content
    };
  }
}

async function inspectImage(req, res) {
  if ((!apiUrlOverride && !apiBaseUrl) || !apiKey) {
    sendJson(res, 500, {
      error: "ML API 설정이 필요합니다.",
      detail: ".env 파일에 HELPY_API_URL 또는 HELPY_API_BASE_URL, 그리고 HELPY_API_KEY를 설정한 뒤 서버를 재시작하세요."
    });
    return;
  }

  const { imageDataUrl, imageUrl, productName, inspectionGoal, notes } = await readJsonBody(req);
  const imageSource = imageUrl || imageDataUrl;
  if (!imageSource) {
    sendJson(res, 400, { error: "imageDataUrl or imageUrl is required." });
    return;
  }

  const normalizedBaseUrl = apiBaseUrl?.replace(/\/$/, "");
  const apiUrl = apiUrlOverride
    ? apiUrlOverride
    : normalizedBaseUrl.endsWith("/v1")
      ? `${normalizedBaseUrl}/chat/completions`
      : `${normalizedBaseUrl}/v1/chat/completions`;
  const requestBody = buildRequestBody({ apiUrl, imageSource, productName, inspectionGoal, notes });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    sendJson(res, isTimeout ? 504 : 502, {
      error: isTimeout ? "ML API 응답 시간이 초과되었습니다." : "ML API 호출에 실패했습니다.",
      detail: isTimeout
        ? "60초 안에 응답이 오지 않았습니다. 이미지 크기를 줄이거나 API 상태를 확인하세요."
        : error instanceof Error ? error.message : String(error),
      apiUrl,
      model
    });
    return;
  } finally {
    clearTimeout(timeout);
  }

  const upstreamText = await upstreamResponse.text();
  if (!upstreamResponse.ok) {
    sendJson(res, upstreamResponse.status, {
      error: "ML API request failed.",
      detail: summarizeText(upstreamText),
      apiUrl,
      model
    });
    return;
  }

  let upstreamJson;
  try {
    upstreamJson = JSON.parse(upstreamText);
  } catch {
    sendJson(res, 502, {
      error: "ML API가 JSON이 아닌 응답을 반환했습니다.",
      detail: summarizeText(upstreamText),
      apiUrl,
      model
    });
    return;
  }
  const generatedImage = upstreamJson?.data?.[0]?.url || upstreamJson?.data?.[0]?.b64_json || "";
  const content = upstreamJson?.choices?.[0]?.message?.content || "";
  if (!content && generatedImage) {
    sendJson(res, 200, {
      result: {
        verdict: "의심",
        confidence: "낮음",
        summary: "이미지 생성/편집 endpoint가 응답했습니다. 이 endpoint는 검사 판정 텍스트 대신 이미지 결과를 반환할 수 있습니다.",
        suspected_areas: [],
        defect_types: [],
        inspector_checklist: [
          "검사 판정용 텍스트 모델 또는 chat completions 호환 vision endpoint 사용 여부 확인",
          "반환된 이미지 결과가 필요한 작업인지 확인"
        ],
        final_record_comment: generatedImage.startsWith("http")
          ? `생성 이미지 URL: ${generatedImage}`
          : "이미지 생성 결과가 base64 형식으로 반환되었습니다."
      },
      raw: upstreamJson,
      usage: upstreamJson.usage || null,
      model: upstreamJson.model || model
    });
    return;
  }
  const { parsed, raw } = parseInspectionContent(content);
  sendJson(res, 200, {
    result: parsed,
    raw,
    usage: upstreamJson.usage || null,
    model: upstreamJson.model || model
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/inspect") {
      await inspectImage(req, res);
      return;
    }
    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }
    res.writeHead(405);
    res.end("Method not allowed");
  } catch (error) {
    sendJson(res, 500, {
      error: "Unexpected server error.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, () => {
  console.log(`KGM ML Inspection Agent running at http://localhost:${port}`);
});

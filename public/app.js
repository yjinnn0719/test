const form = document.querySelector("#inspectionForm");
const imageInput = document.querySelector("#imageInput");
const previewFrame = document.querySelector("#previewFrame");
const previewImage = document.querySelector("#previewImage");
const statusPill = document.querySelector("#statusPill");
const submitButton = document.querySelector("#submitButton");
const verdictBand = document.querySelector("#verdictBand");
const verdictText = document.querySelector("#verdictText");
const confidenceText = document.querySelector("#confidenceText");
const summaryText = document.querySelector("#summaryText");
const suspectedAreas = document.querySelector("#suspectedAreas");
const defectTypes = document.querySelector("#defectTypes");
const checklist = document.querySelector("#checklist");
const recordComment = document.querySelector("#recordComment");
const copyButton = document.querySelector("#copyButton");

let imageDataUrl = "";

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function setStatus(text) {
  statusPill.textContent = text;
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

function setVerdict(verdict, confidence) {
  verdictBand.classList.remove("normal", "suspect", "defective");
  if (verdict === "정상") verdictBand.classList.add("normal");
  if (verdict === "의심") verdictBand.classList.add("suspect");
  if (verdict === "불량 가능성") verdictBand.classList.add("defective");
  verdictText.textContent = verdict || "-";
  confidenceText.textContent = `신뢰도 ${confidence || "-"}`;
}

function renderSuspectedAreas(items = []) {
  if (!items.length) {
    suspectedAreas.className = "list-block empty";
    suspectedAreas.textContent = "결과 없음";
    return;
  }
  suspectedAreas.className = "list-block";
  suspectedAreas.innerHTML = items
    .map(
      (item) => `
        <div class="item">
          <strong>${escapeText(item.area || "위치 미상")}</strong>
          <p>${escapeText(item.observation || "")}</p>
          <span>${escapeText(item.reason || "")}</span>
        </div>
      `
    )
    .join("");
}

function renderDefectTypes(items = []) {
  if (!items.length) {
    defectTypes.className = "list-block empty";
    defectTypes.textContent = "결과 없음";
    return;
  }
  defectTypes.className = "list-block";
  defectTypes.innerHTML = items
    .map(
      (item) => `
        <div class="item">
          <strong>${escapeText(item.type || "기타")} · ${escapeText(item.likelihood || "낮음")}</strong>
          <span>${escapeText(item.evidence || "")}</span>
        </div>
      `
    )
    .join("");
}

function renderChecklist(items = []) {
  checklist.innerHTML = "";
  const list = items.length ? items : ["이미지를 업로드하고 분석을 실행하세요."];
  for (const item of list) {
    const li = document.createElement("li");
    li.textContent = item;
    checklist.append(li);
  }
}

function renderResult(result) {
  setVerdict(result.verdict, result.confidence);
  summaryText.textContent = result.summary || "-";
  renderSuspectedAreas(result.suspected_areas);
  renderDefectTypes(result.defect_types);
  renderChecklist(result.inspector_checklist);
  recordComment.textContent = result.final_record_comment || "-";
}

imageInput.addEventListener("change", async () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  imageDataUrl = await fileToDataUrl(file);
  previewImage.src = imageDataUrl;
  previewFrame.classList.add("has-image");
  setStatus("이미지 선택");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!imageDataUrl) {
    setStatus("이미지 필요");
    summaryText.textContent = "분석할 제품 사진 또는 검사 이미지를 먼저 업로드하세요.";
    return;
  }

  submitButton.disabled = true;
  setStatus("분석 중");
  summaryText.textContent = "이미지를 분석하고 있습니다. API 응답을 기다리는 중입니다.";

  try {
    const response = await fetch("/api/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        imageDataUrl,
        productName: document.querySelector("#productName").value.trim(),
        inspectionGoal: document.querySelector("#inspectionGoal").value.trim(),
        notes: document.querySelector("#notes").value.trim()
      })
    });

    const payload = await response.json().catch(() => ({
      error: "서버 응답을 읽지 못했습니다.",
      detail: "JSON 형식이 아닌 응답이 반환되었습니다."
    }));
    if (!response.ok) {
      const detail = payload.detail ? `\n\n상세: ${payload.detail}` : "";
      const apiInfo = payload.apiUrl ? `\n\nAPI URL: ${payload.apiUrl}\nMODEL: ${payload.model || "-"}` : "";
      throw new Error(`${payload.error || "분석 요청 실패"}${detail}${apiInfo}`);
    }
    renderResult(payload.result);
    setStatus("완료");
  } catch (error) {
    setStatus("오류");
    summaryText.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    submitButton.disabled = false;
  }
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(recordComment.textContent);
  copyButton.textContent = "복사됨";
  setTimeout(() => {
    copyButton.textContent = "복사";
  }, 1200);
});

import type {
  DatasetReviewStatus,
  DatasetSample,
  IdentityReview,
  IdentityReviewDecision,
  Subject,
} from "./types.ts";

export const DATASET_MODELS: ReadonlyArray<readonly [string, string]> = [
  ["M-01", "사람 탐지·tracking"],
  ["M-02", "돌봄 대상자 식별"],
  ["M-03-04", "M-03/4 POSE·자세·행동·정지"],
  ["M-05", "위험물 탐지·관리 물품 Filter"],
];

export const DATA_REQUIREMENTS: ReadonlyArray<readonly [string, string]> = [
  ["DS-001", "사람 탐지·tracking"],
  ["DS-002", "POSE·자세·행동·낙상"],
  ["DS-003", "돌봄 대상자 식별"],
  ["DS-004", "위험물·관리 물품"],
  ["DS-006", "오탐·미탐 평가"],
  ["DS-007", "통합 시나리오 평가"],
  ["DS-009", "식별 검토 feedback"],
];

export function datasetManifest(
  datasetVersion: string, samples: readonly DatasetSample[],
): Record<string, unknown> {
  const approved = samples.filter((sample) => sample.reviewStatus === "approved");
  return {
    schema: "wardy.dataset-manifest.v1",
    datasetVersion: datasetVersion.trim(),
    exportedAt: new Date().toISOString(),
    activeModelChanged: false,
    sampleCount: approved.length,
    samples: approved.map((sample) => ({
      sampleId: sample.id,
      modelId: sample.modelId,
      requirementId: sample.requirementId,
      label: sample.label,
      captureSession: sample.captureSession,
      source: sample.source,
      imagePath: sample.imagePath,
      originalFilename: sample.originalFilename,
      capturedAt: sample.capturedAt,
      width: sample.width,
      height: sample.height,
    })),
  };
}

function selectOptionLabel(options: ReadonlyArray<readonly [string, string]>, value: string): string {
  const option = options.find(([id]) => id === value);
  return option ? `${option[0]} · ${option[1]}` : value;
}

export function renderDatasetSamples(
  container: HTMLTableSectionElement,
  samples: readonly DatasetSample[],
  onReview: (sampleId: string, label: string, status: DatasetReviewStatus) => void,
  onDelete: (sampleId: string) => void,
): void {
  container.replaceChildren();
  [...samples]
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
    .forEach((sample) => {
      const row = document.createElement("tr");

      const target = document.createElement("td");
      const targetName = document.createElement("strong");
      targetName.textContent = selectOptionLabel(DATASET_MODELS, sample.modelId);
      const requirement = document.createElement("small");
      requirement.textContent = selectOptionLabel(DATA_REQUIREMENTS, sample.requirementId);
      target.append(targetName, requirement);

      const labelCell = document.createElement("td");
      const label = document.createElement("input");
      label.className = "dataset-label-input";
      label.value = sample.label;
      label.maxLength = 120;
      label.setAttribute("aria-label", `${sample.id} label`);
      labelCell.append(label);

      const source = document.createElement("td");
      const session = document.createElement("strong");
      session.textContent = sample.captureSession;
      const sourcePath = document.createElement("small");
      sourcePath.textContent = `${sample.source === "jetson_camera" ? "Jetson camera" : sample.originalFilename ?? "로컬 파일"} · ${sample.width}×${sample.height}`;
      const path = document.createElement("small");
      path.className = "path-text";
      path.textContent = sample.imagePath;
      source.append(session, sourcePath, path);

      const review = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `badge dataset-status is-${sample.reviewStatus}`;
      badge.textContent = sample.reviewStatus === "approved" ? "승인" : sample.reviewStatus === "rejected" ? "제외" : "검토 대기";
      review.append(badge);

      const actions = document.createElement("td");
      actions.className = "row-actions dataset-row-actions";
      const actionsList: ReadonlyArray<readonly [string, DatasetReviewStatus, string]> = [
        ["승인", "approved", "button button-small"],
        ["대기", "pending", "button button-secondary button-small"],
        ["제외", "rejected", "button button-secondary button-small"],
      ];
      actionsList.forEach(([text, status, className]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = className;
        button.textContent = text;
        button.disabled = sample.reviewStatus === status;
        button.addEventListener("click", () => onReview(sample.id, label.value.trim(), status));
        actions.append(button);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button is-danger";
      remove.textContent = "삭제";
      remove.addEventListener("click", () => onDelete(sample.id));
      actions.append(remove);

      row.append(target, labelCell, source, review, actions);
      container.append(row);
    });
}

export function identityFeedbackManifest(
  reviews: readonly IdentityReview[], subjects: readonly Subject[],
): Record<string, unknown> {
  const subjectNames = new Map(subjects.map((subject) => [subject.id, subject.name]));
  return {
    schema: "wardy.identity-feedback.v1",
    exportedAt: new Date().toISOString(),
    activeModelChanged: false,
    samples: reviews.map((review) => ({
      reviewId: review.id,
      imagePath: review.imagePath,
      capturedAt: review.capturedAt,
      predictedName: review.predictedName,
      confidence: review.confidence,
      decision: review.decision,
      subjectId: review.subjectId,
      subjectName: review.subjectId ? subjectNames.get(review.subjectId) ?? null : null,
    })),
  };
}

export function renderIdentityReviews(
  container: HTMLElement,
  reviews: readonly IdentityReview[],
  subjects: readonly Subject[],
  onResolve: (reviewId: string, decision: IdentityReviewDecision, subjectId?: string | null) => void,
): void {
  container.replaceChildren();
  if (!reviews.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "식별 검토를 기다리는 장면이 없습니다. M-02 연결 뒤 낮은 확신·미등록 장면이 여기에 추가됩니다.";
    container.append(empty);
    return;
  }

  reviews.forEach((review) => {
    const card = document.createElement("article");
    card.className = "review-card";
    const visual = document.createElement("div");
    visual.className = "review-placeholder";
    visual.textContent = "미리보기 연결 전";
    const body = document.createElement("div");
    body.className = "review-body";
    const title = document.createElement("strong");
    title.textContent = review.predictedName
      ? `'${review.predictedName}'으로 추정 · ${Math.round((review.confidence ?? 0) * 100)}%`
      : "미등록 인물로 추정";
    const path = document.createElement("small");
    path.textContent = `${review.capturedAt} · Jetson 로컬 보관`;
    body.append(title, path);

    if (review.decision === "pending") {
      const select = document.createElement("select");
      select.setAttribute("aria-label", "등록 인물 선택");
      subjects.forEach((subject) => {
        const option = document.createElement("option");
        option.value = subject.id;
        option.textContent = `${subject.name} · ${subject.role}`;
        select.append(option);
      });
      select.disabled = true;
      const actions = document.createElement("div");
      actions.className = "review-actions";
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "button button-small";
      confirm.textContent = "선택한 인물";
      confirm.disabled = true;
      confirm.addEventListener("click", () => onResolve(review.id, "subject", select.value));
      const unknown = document.createElement("button");
      unknown.type = "button";
      unknown.className = "button button-secondary button-small";
      unknown.textContent = "미등록 인물";
      unknown.disabled = true;
      unknown.addEventListener("click", () => onResolve(review.id, "unknown"));
      const excluded = document.createElement("button");
      excluded.type = "button";
      excluded.className = "text-button";
      excluded.textContent = "학습 제외";
      excluded.disabled = true;
      excluded.addEventListener("click", () => onResolve(review.id, "excluded"));
      actions.append(confirm, unknown, excluded);
      body.append(select, actions);
      const notice = document.createElement("small");
      notice.textContent = "보안된 장면 미리보기 연결 뒤 답변할 수 있습니다.";
      body.append(notice);
    } else {
      const result = document.createElement("span");
      result.className = "badge";
      const subject = subjects.find((candidate) => candidate.id === review.subjectId);
      result.textContent = review.decision === "subject"
        ? `답변 완료 · ${subject?.name ?? "알 수 없는 인물"}`
        : review.decision === "unknown" ? "답변 완료 · 미등록 인물" : "답변 완료 · 학습 제외";
      body.append(result);
    }
    card.append(visual, body);
    container.append(card);
  });
}

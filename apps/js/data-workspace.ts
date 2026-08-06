import type { IdentityReview, IdentityReviewDecision, Subject } from "./types.ts";

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
    visual.textContent = "로컬 식별 장면";
    const body = document.createElement("div");
    body.className = "review-body";
    const title = document.createElement("strong");
    title.textContent = review.predictedName
      ? `'${review.predictedName}'으로 추정 · ${Math.round((review.confidence ?? 0) * 100)}%`
      : "미등록 인물로 추정";
    const path = document.createElement("small");
    path.textContent = `${review.capturedAt} · ${review.imagePath}`;
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
      const actions = document.createElement("div");
      actions.className = "review-actions";
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "button button-small";
      confirm.textContent = "선택한 인물";
      confirm.disabled = !subjects.length;
      confirm.addEventListener("click", () => onResolve(review.id, "subject", select.value));
      const unknown = document.createElement("button");
      unknown.type = "button";
      unknown.className = "button button-secondary button-small";
      unknown.textContent = "미등록 인물";
      unknown.addEventListener("click", () => onResolve(review.id, "unknown"));
      const excluded = document.createElement("button");
      excluded.type = "button";
      excluded.className = "text-button";
      excluded.textContent = "학습 제외";
      excluded.addEventListener("click", () => onResolve(review.id, "excluded"));
      actions.append(confirm, unknown, excluded);
      body.append(select, actions);
    } else {
      const result = document.createElement("span");
      result.className = "badge";
      const subject = subjects.find((candidate) => candidate.id === review.subjectId);
      result.textContent = review.decision === "subject"
        ? `답변 완료 · ${subject?.name ?? review.subjectId}`
        : review.decision === "unknown" ? "답변 완료 · 미등록 인물" : "답변 완료 · 학습 제외";
      body.append(result);
    }
    card.append(visual, body);
    container.append(card);
  });
}

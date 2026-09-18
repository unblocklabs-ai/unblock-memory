import type { ResponseJudgment, judgeResponseFollowup } from "./response-judge.js";

// Reporting/composition changes do not require paid re-inference of the same rubric.
export const RESPONSE_REPORT_VERSION = "response-report-v4";

/** Compose observed evidence, not a factual-verification or causal agent grade.
 * Narrow admissions take precedence over praise; missing evidence stays unknown. */
export function responseOutcome(result: ResponseJudgment & { retrospective: Awaited<ReturnType<typeof judgeResponseFollowup>> }) {
  const later = result.retrospective.judgment;
  const basis: string[] = [];
  const reasons: string[] = [];
  const reasonDetails: { reason: string; strength: number; measure: "choice_confidence" | "yes_probability"; source: string }[] = [];
  const addReason = (reason: string, strength: number, source: string, measure: "choice_confidence" | "yes_probability" = "choice_confidence") => {
    reasons.push(reason); reasonDetails.push({ reason, strength, measure, source });
  };
  if (result.quality.underdelivery.noul >= 0.8) {
    basis.push("visible_underdelivery");
    const reason = result.quality.failureReason;
    if (reason.confidence >= 0.8 && reason.choice !== "none_or_unclear") addReason(reason.choice, reason.confidence, "visible_quality");
  }
  if (later) {
    const correction = later.correction.noul >= 0.8;
    const delivery = later.deliveryAdmission.noul >= 0.8;
    const regression = later.regression.noul >= 0.8;
    if (correction) basis.push("later_correction");
    if (delivery) { basis.push("delivery_admission"); addReason("failed_delivery", later.deliveryAdmission.noul, "delivery_admission", "yes_probability"); }
    if (regression) { basis.push("regression_admission"); addReason("regression", later.regression.noul, "regression_admission", "yes_probability"); }
    const reported = later.outcome.confidence >= 0.8 && later.outcome.choice === "reported_shortfall" && later.scopeClarification.noul <= 0.2;
    if (reported) basis.push("reported_shortfall");
    // A narrow admission can establish the shortfall even when the broad outcome
    // abstains. Its independently confident reason is still useful, not overridden
    // by a hard-coded assumption that every correction means incorrect_claim.
    if ((correction || delivery || regression || reported) && later.reason.confidence >= 0.8 && later.reason.choice !== "none_or_unclear") {
      addReason(later.reason.choice, later.reason.confidence, "retrospective_reason");
    }
  }
  if (basis.length) return { status: "reported_shortfall" as const, basis, reasons: [...new Set(reasons)], reasonDetails,
    reasonStatus: reasonDetails.length ? "classified" as const : "uncertain" as const };
  if (later?.outcome.choice === "acknowledged_success" && later.outcome.confidence >= 0.8) {
    return { status: "acknowledged_success" as const, basis: ["human_acknowledgment"], reasons: [], reasonDetails: [], reasonStatus: "not_applicable" as const };
  }
  return { status: "unknown" as const, basis: [], reasons: [], reasonDetails: [], reasonStatus: "not_applicable" as const };
}

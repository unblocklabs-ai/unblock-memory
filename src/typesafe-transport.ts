export const TYPESAFE_MODEL = "jev-1.13.0";

export class TypeSafeHttpError extends Error {
  constructor(readonly status: number) {
    super(`TypeSafe HTTP ${status}`);
  }
}

/** Shared wire protocol; callers own deadlines, judgments and public errors. */
export async function postTypeSafe(
  params: { apiKey: string; signal: AbortSignal }, state: unknown, questions: unknown,
): Promise<unknown> {
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST", redirect: "error", signal: params.signal,
    headers: { Authorization: `Bearer ${params.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: TYPESAFE_MODEL, state, questions }),
  });
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } finally {
      // Preserve the status even if cancellation fails; never include provider content.
      throw new TypeSafeHttpError(response.status);
    }
  }
  return response.json();
}

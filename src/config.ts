export const DEFAULT_PATHS = ["MEMORY.md", "USER.md", "memory/**/*.md"] as const;

export type UnblockQmdConfig = { paths: readonly string[] };

export function resolveConfig(value: unknown): UnblockQmdConfig {
  if (!value || typeof value !== "object" || !("paths" in value)) {
    return { paths: DEFAULT_PATHS };
  }
  const paths = (value as { paths?: unknown }).paths;
  if (!Array.isArray(paths) || !paths.every((entry) => typeof entry === "string" && entry.trim())) {
    throw new Error("unblock-qmd paths must be an array of non-empty strings");
  }
  return { paths: paths.map((entry) => entry.trim()) };
}

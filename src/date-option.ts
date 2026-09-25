export function dateOption(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error("Dates must be valid YYYY-MM-DD UTC dates");
  }
  return Date.parse(value);
}

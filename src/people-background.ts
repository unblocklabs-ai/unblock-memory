/** A recognition aid, never a behavioral profile. Existing records remain readable. */
export const PEOPLE_BACKGROUND_MAX_WORDS = 70;

export function backgroundWordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

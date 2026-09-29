/**
 * Greedy label placement for the canal sheet: each label offers a few
 * candidate boxes (above/below, start/end of its line); the first that does
 * not overlap anything already placed wins, else the label is dropped.
 * Labels are placed in priority order so the important ones always land.
 */

export type Box = { x: number; y: number; w: number; h: number };

export function overlaps(a: Box, b: Box, gap = 2): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

/** Rough text width for the sheet's 12 px Thai/Latin label face. */
export function textWidth(text: string, px = 12): number {
  // Thai combining marks take no width; everything else ~0.58 em.
  const visible = text.replace(/[ัิ-ฺ็-๎]/g, "");
  return visible.length * px * 0.58;
}

export function place<T extends Box>(candidates: T[], taken: Box[]): T | null {
  for (const c of candidates) {
    if (!taken.some((t) => overlaps(c, t))) return c;
  }
  return null;
}

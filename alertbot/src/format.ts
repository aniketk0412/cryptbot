/** Price formatting that keeps precision for sub-dollar tokens. */
export function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return "—";
  if (p >= 1000) return p.toFixed(1);
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toPrecision(4);
}

export function nowStr(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

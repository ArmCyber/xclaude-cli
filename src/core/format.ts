// Plain-text tables for ls, tmux ls and doctor.

/** Pads every column but the last; cells are plain text. */
export function formatTable(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, col) => Math.max(...all.map((r) => (r[col] ?? "").length)));
  return all
    .map((r) =>
      r
        .map((cell, col) => (col === r.length - 1 ? cell : cell.padEnd(widths[col]!)))
        .join("  ")
        .trimEnd(),
    )
    .map((line) => `${line}\n`)
    .join("");
}

export const DASH = "–";

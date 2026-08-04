import { StepResolution, TourStep } from './tourTypes';

export interface ResolvedLines {
  /** 0-based inclusive. */
  startLine: number;
  /** 0-based inclusive. */
  endLine: number;
  resolution: StepResolution;
  note?: string;
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(Math.floor(value), max));
}

/**
 * Locate a step's range in a file as it exists right now.
 *
 * Line numbers alone are wrong in two common cases: the model was slightly off, or
 * the file changed after the tour was generated (the CLI reads from disk, so unsaved
 * editor edits make them wrong immediately). The verbatim `anchor` line is therefore
 * treated as the source of truth and the line numbers only as a proximity hint used
 * to disambiguate between multiple matches.
 *
 * Kept free of any `vscode` import so it can be unit-tested as plain data in/out.
 */
export function resolveAnchor(lines: string[], step: TourStep, fileLabel = 'the file'): ResolvedLines {
  const lastLine = Math.max(0, lines.length - 1);
  const hintStart = clamp(step.startLine - 1, 0, lastLine);
  const hintEnd = clamp(step.endLine - 1, hintStart, lastLine);
  const span = hintEnd - hintStart;

  const withSpan = (start: number): { startLine: number; endLine: number } => {
    const s = clamp(start, 0, lastLine);
    return { startLine: s, endLine: clamp(s + span, s, lastLine) };
  };

  const anchor = step.anchor;
  if (!anchor || !anchor.trim()) {
    return { ...withSpan(hintStart), resolution: 'line-only' };
  }

  // Tier 1 exact, tier 2 trimmed (reindented), tier 3 whitespace-normalized (reformatted).
  const exact: number[] = [];
  const trimmed: number[] = [];
  const loose: number[] = [];
  const anchorTrim = anchor.trim();
  const anchorNorm = normalize(anchor);

  for (let i = 0; i <= lastLine; i++) {
    const text = lines[i] ?? '';
    if (text === anchor) {
      exact.push(i);
    } else if (text.trim() === anchorTrim) {
      trimmed.push(i);
    } else if (anchorNorm.length > 0 && normalize(text) === anchorNorm) {
      loose.push(i);
    }
  }

  const candidates = exact.length ? exact : trimmed.length ? trimmed : loose;
  if (candidates.length === 0) {
    return {
      ...withSpan(hintStart),
      resolution: 'unresolved',
      note: `Could not find the expected code in ${fileLabel}; showing lines ${hintStart + 1}-${
        hintEnd + 1
      } as a best guess. The file has probably changed, so treat this highlight with suspicion.`,
    };
  }

  // Closest to the model's hint wins; ties go to the earlier line.
  let best = candidates[0];
  for (const c of candidates) {
    if (Math.abs(c - hintStart) < Math.abs(best - hintStart)) {
      best = c;
    }
  }

  if (best === hintStart) {
    return { ...withSpan(best), resolution: 'exact' };
  }
  return {
    ...withSpan(best),
    resolution: 'relocated',
    note: `The file changed since this tour was generated — re-located this step from line ${hintStart + 1} to line ${
      best + 1
    }.`,
  };
}

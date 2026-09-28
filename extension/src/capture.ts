import type { CaptureSource, CodeContext } from "../shared/protocol";

/** Deciding what code to attach, expressed as a pure function. */

/** Hard ceiling on a single capture. */
export const MAX_CAPTURE_LINES = 400;

/** Hard ceiling on a single capture, in characters. */
export const MAX_CAPTURE_CHARS = 40_000;

/** Document schemes we will read. */
export const ALLOWED_SCHEMES: readonly string[] = ["file", "untitled"];

/** A text editor flattened into plain data. */
export interface EditorSnapshot {
  label: string;
  languageId: string;
  scheme: string;
  lines: string[];
  selection: { startLine: number; endLine: number } | undefined;
}

export type CaptureResult =
  | { ok: true; context: CodeContext }
  | { ok: false; reason: string };

export function buildCodeContext(
  snapshot: EditorSnapshot,
  source: CaptureSource,
  focusLine?: number,
): CaptureResult {
  if (!ALLOWED_SCHEMES.includes(snapshot.scheme)) {
    return {
      ok: false,
      reason:
        "That tab is not an editable file, so there is nothing to attach. Switch to the file you are working on and try again.",
    };
  }

  if (snapshot.lines.every((line) => line.trim() === "")) {
    return {
      ok: false,
      reason: "That file is empty. Open the code you are stuck on and try again.",
    };
  }

  let startLine: number;
  let endLine: number;

  if (source === "selection") {
    if (snapshot.selection === undefined) {
      return {
        ok: false,
        reason:
          "Nothing is selected. Highlight the code you are stuck on, or choose Use active file.",
      };
    }
    startLine = snapshot.selection.startLine;
    endLine = snapshot.selection.endLine;
  } else {
    startLine = 1;
    endLine = snapshot.lines.length;
  }

  startLine = Math.max(1, Math.min(startLine, snapshot.lines.length));
  endLine = Math.max(startLine, Math.min(endLine, snapshot.lines.length));

  const truncated = endLine - startLine + 1 > MAX_CAPTURE_LINES;
  if (truncated) {
    if (focusLine !== undefined) {
      const half = Math.floor(MAX_CAPTURE_LINES / 2);
      const lastPossibleStart = snapshot.lines.length - MAX_CAPTURE_LINES + 1;
      startLine = Math.max(1, Math.min(focusLine - half, lastPossibleStart));
    }

    endLine = startLine + MAX_CAPTURE_LINES - 1;
  }

  const withinLineLimit = snapshot.lines.slice(startLine - 1, endLine);
  const captured = limitCharacters(withinLineLimit, MAX_CAPTURE_CHARS);

  return {
    ok: true,
    context: {
      label: snapshot.label,
      languageId: snapshot.languageId,
      source,
      startLine,
      endLine: startLine + captured.lines.length - 1,
      lineCount: captured.lines.length,
      code: captured.lines.join("\n"),
      truncated: truncated || captured.truncated,
    },
  };
}

/** Where a selection is after the developer edited the file. */
export function shiftedSelection(
  selection: { startLine: number; endLine: number },
  linesBefore: number,
  linesNow: number,
): { startLine: number; endLine: number } {
  const startLine = Math.max(1, Math.min(selection.startLine, linesNow));
  const endLine = selection.endLine + (linesNow - linesBefore);

  return { startLine, endLine: Math.max(startLine, Math.min(endLine, linesNow)) };
}

/** Drops trailing lines until the joined text fits. */
function limitCharacters(
  lines: string[],
  max: number,
): { lines: string[]; truncated: boolean } {
  let total = 0;
  const kept: string[] = [];

  for (const line of lines) {
    const cost = kept.length === 0 ? line.length : line.length + 1;

    if (total + cost > max) {
      return {
        lines: kept.length === 0 ? [line.slice(0, max)] : kept,
        truncated: true,
      };
    }

    kept.push(line);
    total += cost;
  }

  return { lines: kept, truncated: false };
}

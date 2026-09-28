import { describe, expect, it } from "vitest";

import { isWebviewToHost } from "../shared/protocol";
import {
  buildCodeContext,
  shiftedSelection,
  MAX_CAPTURE_CHARS,
  MAX_CAPTURE_LINES,
  type EditorSnapshot,
} from "../src/capture";

/** These tests cover src/capture.ts, which decides how much of the developer's code we read. */

function snapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    label: "app.py",
    languageId: "python",
    scheme: "file",
    lines: ["def total(items):", "    return sum(items)", "", "print(total([]))"],
    selection: undefined,
    ...overrides,
  };
}

describe("buildCodeContext", () => {
  it("captures only the selected lines", () => {
    const result = buildCodeContext(
      snapshot({ selection: { startLine: 2, endLine: 2 } }),
      "selection",
    );

    expect(result).toEqual({
      ok: true,
      context: {
        label: "app.py",
        languageId: "python",
        source: "selection",
        startLine: 2,
        endLine: 2,
        lineCount: 1,
        code: "    return sum(items)",
        truncated: false,
      },
    });
  });

  it("captures the whole document when the source is the file", () => {
    const result = buildCodeContext(snapshot(), "file");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.context.startLine).toBe(1);
    expect(result.context.endLine).toBe(4);
    expect(result.context.code).toContain("def total(items):");
    expect(result.context.code).toContain("print(total([]))");
  });

  it("refuses a selection capture when nothing is selected", () => {
    const result = buildCodeContext(snapshot({ selection: undefined }), "selection");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/nothing is selected/i);
  });

  it("refuses to read a tab that is not an editable file", () => {
    const result = buildCodeContext(snapshot({ scheme: "output" }), "file");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not an editable file/i);
  });

  it("refuses an empty document", () => {
    const result = buildCodeContext(snapshot({ lines: ["", "   ", ""] }), "file");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/empty/i);
  });

  it("caps a large capture and reports that it was truncated", () => {
    const lines = Array.from({ length: MAX_CAPTURE_LINES + 50 }, (_, i) => `line ${i + 1}`);
    const result = buildCodeContext(snapshot({ lines }), "file");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.context.truncated).toBe(true);
    expect(result.context.lineCount).toBe(MAX_CAPTURE_LINES);
    expect(result.context.endLine).toBe(MAX_CAPTURE_LINES);
    expect(result.context.code.endsWith(`line ${MAX_CAPTURE_LINES}`)).toBe(true);
  });

  it("centres the window on the reported line when a long file is truncated", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`);
    const result = buildCodeContext(snapshot({ lines }), "traceback", 900);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.context.truncated).toBe(true);
    expect(result.context.startLine).toBe(900 - MAX_CAPTURE_LINES / 2);
    expect(result.context.endLine).toBe(result.context.startLine + MAX_CAPTURE_LINES - 1);
    expect(result.context.code).toContain("line 900");
  });

  it("slides the window back inside the file when the reported line is near the end", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
    const result = buildCodeContext(snapshot({ lines }), "traceback", 995);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.context.endLine).toBe(1000);
    expect(result.context.startLine).toBe(1000 - MAX_CAPTURE_LINES + 1);
    expect(result.context.code).toContain("line 995");
  });

  it("starts at line 1 when a long file has no reported line", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
    const result = buildCodeContext(snapshot({ lines }), "file");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.context.startLine).toBe(1);
  });

  it("stops at the character ceiling even when the line count is fine", () => {
    const lines = Array.from({ length: 100 }, () => "x".repeat(1_000));
    const result = buildCodeContext(snapshot({ lines }), "file");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.context.truncated).toBe(true);
    expect(result.context.code.length).toBeLessThanOrEqual(MAX_CAPTURE_CHARS);
    expect(result.context.endLine).toBe(
      result.context.startLine + result.context.lineCount - 1,
    );
  });

  it("still returns something when one line exceeds the whole budget", () => {
    const result = buildCodeContext(
      snapshot({ lines: ["y".repeat(MAX_CAPTURE_CHARS + 500)] }),
      "file",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.context.truncated).toBe(true);
    expect(result.context.code.length).toBe(MAX_CAPTURE_CHARS);
  });

  it("leaves a normal capture unflagged", () => {
    const result = buildCodeContext(snapshot(), "file");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.context.truncated).toBe(false);
    expect(result.context.lineCount).toBe(4);
  });

  it("clamps a selection that runs past the end of the document", () => {
    const result = buildCodeContext(
      snapshot({ selection: { startLine: 3, endLine: 999 } }),
      "selection",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.context.endLine).toBe(4);
    expect(result.context.lineCount).toBe(2);
  });
});

describe("isWebviewToHost", () => {
  it("accepts the messages the webview is allowed to send", () => {
    expect(isWebviewToHost({ type: "ready" })).toBe(true);
    expect(isWebviewToHost({ type: "capture", source: "selection" })).toBe(true);
    expect(isWebviewToHost({ type: "capture", source: "file" })).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isWebviewToHost(null)).toBe(false);
    expect(isWebviewToHost("capture")).toBe(false);
    expect(isWebviewToHost({ type: "capture" })).toBe(false);
    expect(isWebviewToHost({ type: "capture", source: "repository" })).toBe(false);
    expect(isWebviewToHost({ type: "runTests", source: "file" })).toBe(false);
  });

  it("ignores extra fields on a ready message", () => {
    expect(isWebviewToHost({ type: "ready", source: "repository" })).toBe(true);
  });
});

describe("shiftedSelection", () => {
  it("grows with lines added inside the selection", () => {
    expect(shiftedSelection({ startLine: 10, endLine: 14 }, 50, 52)).toEqual({
      startLine: 10,
      endLine: 16,
    });
  });

  it("shrinks with lines removed", () => {
    expect(shiftedSelection({ startLine: 10, endLine: 14 }, 50, 48)).toEqual({
      startLine: 10,
      endLine: 12,
    });
  });

  it("never ends before it starts, however much was deleted", () => {
    expect(shiftedSelection({ startLine: 10, endLine: 14 }, 50, 20)).toEqual({
      startLine: 10,
      endLine: 10,
    });
  });

  it("never reads past the end of a file that got shorter", () => {
    expect(shiftedSelection({ startLine: 10, endLine: 14 }, 50, 8)).toEqual({
      startLine: 8,
      endLine: 8,
    });
  });
});

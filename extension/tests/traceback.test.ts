import { describe, expect, it } from "vitest";

import {
  hasTraversalSegment,
  isVendorPath,
  MAX_FRAMES,
  parseTraceback,
  pathMatchesReported,
  referencedFiles,
  reportedBasename,
} from "../src/traceback";

/** These tests cover src/traceback.ts, which reads pasted error text for the files it names. */

const PYTHON_TRACEBACK = `Traceback (most recent call last):
  File "app.py", line 12, in <module>
    print(average(scores))
  File "/Users/dev/project/utils.py", line 5, in average
    return sum(values) / len(values)
ZeroDivisionError: division by zero`;

describe("parseTraceback", () => {
  it("reads every frame of a Python traceback in call order", () => {
    const parsed = parseTraceback(PYTHON_TRACEBACK);

    expect(parsed.frames).toEqual([
      { path: "app.py", line: 12, functionName: "<module>" },
      {
        path: "/Users/dev/project/utils.py",
        line: 5,
        functionName: "average",
      },
    ]);
  });

  it("reads the exception summary from the last line", () => {
    expect(parseTraceback(PYTHON_TRACEBACK).exception).toBe(
      "ZeroDivisionError: division by zero",
    );
  });

  it("does not mistake echoed source lines for the summary", () => {
    const parsed = parseTraceback(`Traceback (most recent call last):
  File "app.py", line 12, in <module>
    total = compute()`);

    expect(parsed.exception).toBeUndefined();
  });

  it("reads path:line output from other toolchains", () => {
    const parsed = parseTraceback(
      ["src/app.py:12:5: error: unexpected indent", "utils.py:40: warning: unused"].join("\n"),
    );

    expect(parsed.frames).toEqual([
      { path: "src/app.py", line: 12, functionName: undefined },
      { path: "utils.py", line: 40, functionName: undefined },
    ]);
  });

  it("ignores the caret marker lines Python 3.11+ prints under each frame", () => {
    const parsed = parseTraceback(`Traceback (most recent call last):
  File "/project/samples/grade_report.py", line 26, in <module>
    report(STUDENTS)
    ~~~~~~^^^^^^^^^^
  File "/project/samples/grade_report.py", line 22, in report
    print(f"{name}: {average(scores):.1f}")
                     ~~~~~~~^^^^^^^^
  File "/project/samples/stats.py", line 5, in average
    return sum(values) / len(values)
           ~~~~~~~~~~~~^~~~~~~~~~~~~
ZeroDivisionError: division by zero`);

    expect(parsed.frames).toHaveLength(3);
    expect(parsed.exception).toBe("ZeroDivisionError: division by zero");
    expect(referencedFiles(parsed)).toEqual([
      {
        path: "/project/samples/grade_report.py",
        lines: [22, 26],
        innermostLine: 22,
      },
      { path: "/project/samples/stats.py", lines: [5], innermostLine: 5 },
    ]);
  });

  it("returns nothing for text that names no locations", () => {
    const parsed = parseTraceback("my program prints the wrong total");

    expect(parsed.frames).toEqual([]);
    expect(parsed.exception).toBe("my program prints the wrong total");
  });

  it("survives empty input", () => {
    expect(parseTraceback("")).toEqual({ frames: [], exception: undefined });
  });

  it("caps frames by keeping the innermost ones, not the first", () => {
    const huge = Array.from(
      { length: 500 },
      (_, index) => `  File "deep.py", line ${index + 1}, in recurse`,
    ).join("\n");

    const frames = parseTraceback(huge).frames;

    expect(frames).toHaveLength(MAX_FRAMES);
    expect(frames.at(-1)?.line).toBe(500);
    expect(frames.at(0)?.line).toBe(500 - MAX_FRAMES + 1);
  });
});

describe("referencedFiles", () => {
  it("gives one entry per file with its lines sorted", () => {
    const parsed = parseTraceback(`  File "app.py", line 30, in outer
  File "utils.py", line 5, in inner
  File "app.py", line 12, in <module>`);

    expect(referencedFiles(parsed)).toEqual([
      { path: "app.py", lines: [12, 30], innermostLine: 12 },
      { path: "utils.py", lines: [5], innermostLine: 5 },
    ]);
  });

  it("reports the innermost line separately from the sorted list", () => {
    const parsed = parseTraceback(`  File "app.py", line 40, in main
  File "app.py", line 1850, in compute`);

    expect(referencedFiles(parsed)).toEqual([
      { path: "app.py", lines: [40, 1850], innermostLine: 1850 },
    ]);
  });

  it("collapses a recursive frame that repeats the same line", () => {
    const parsed = parseTraceback(
      Array.from({ length: 6 }, () => `  File "app.py", line 7, in recurse`).join("\n"),
    );

    expect(referencedFiles(parsed)).toEqual([
      { path: "app.py", lines: [7], innermostLine: 7 },
    ]);
  });
});

describe("hasTraversalSegment", () => {
  it("flags a path that climbs out of its directory", () => {
    expect(hasTraversalSegment("/Users/dev/project/../../../etc/passwd")).toBe(true);
    expect(hasTraversalSegment("../secrets.py")).toBe(true);
    expect(hasTraversalSegment("src\\..\\..\\etc\\passwd")).toBe(true);
  });

  it("leaves ordinary paths alone", () => {
    expect(hasTraversalSegment("src/app.py")).toBe(false);
    expect(hasTraversalSegment("./src/app.py")).toBe(false);
    expect(hasTraversalSegment("src/..hidden.py")).toBe(false);
  });
});

describe("isVendorPath", () => {
  it("recognises dependency and cache directories", () => {
    expect(isVendorPath("/usr/lib/python3.12/site-packages/requests/api.py")).toBe(true);
    expect(isVendorPath(".venv/lib/flask/app.py")).toBe(true);
    expect(isVendorPath("node_modules/left-pad/index.js")).toBe(true);
    expect(isVendorPath("__pycache__/app.cpython-312.pyc")).toBe(true);
  });

  it("leaves the developer's own files alone", () => {
    expect(isVendorPath("src/app.py")).toBe(false);
    expect(isVendorPath("src/venv_helpers.py")).toBe(false);
  });
});

describe("pathMatchesReported", () => {
  it("matches a real path against the suffix a toolchain printed", () => {
    expect(pathMatchesReported("/Users/dev/project/app.py", "app.py")).toBe(true);
    expect(pathMatchesReported("/Users/dev/project/src/app.py", "src/app.py")).toBe(true);
    expect(pathMatchesReported("/Users/dev/project/app.py", "/Users/dev/project/app.py")).toBe(true);
  });

  it("does not match a different file that merely ends similarly", () => {
    expect(pathMatchesReported("/Users/dev/project/myapp.py", "app.py")).toBe(false);
    expect(pathMatchesReported("/Users/dev/other/app.py", "src/app.py")).toBe(false);
  });

  it("treats Windows separators as equivalent", () => {
    expect(pathMatchesReported("C:/dev/project/src/app.py", "src\\app.py")).toBe(true);
  });
});

describe("reportedBasename", () => {
  it("takes the filename from any separator style", () => {
    expect(reportedBasename("src/app.py")).toBe("app.py");
    expect(reportedBasename("src\\app.py")).toBe("app.py");
    expect(reportedBasename("app.py")).toBe("app.py");
  });
});

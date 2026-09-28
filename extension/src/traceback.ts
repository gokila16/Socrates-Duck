/** Reading error evidence for the code locations it mentions. */

/** One "File ..., line N" entry from an error report. */
export interface TracebackFrame {
  path: string;
  line: number;
  functionName: string | undefined;
}

export interface ParsedTraceback {
  frames: TracebackFrame[];
  exception: string | undefined;
}

/** A file the evidence referred to, with every line it was reported at. */
export interface ReferencedFile {
  path: string;
  lines: number[];
  innermostLine: number;
}

/** Ceiling on frames, so a pathological paste cannot stall the panel. */
export const MAX_FRAMES = 50;

/** Python: ` File "app.py", line 12, in average` */
const PYTHON_FRAME =
  /^\s*File\s+"(?<path>[^"]+)",\s+line\s+(?<line>\d+)(?:,\s+in\s+(?<fn>\S.*?))?\s*$/;

/** Most other toolchains: `app.py:12: message` or `src/app.py:12:5: error ...`. */
const GENERIC_FRAME =
  /^\s*(?<path>[^\s:"'()]+\.[A-Za-z0-9_]+):(?<line>\d+)(?::\d+)?:/;

/** Directory names whose contents are not the developer's own code. */
const VENDOR_SEGMENTS = [
  "site-packages",
  "dist-packages",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
];

export function parseTraceback(text: string): ParsedTraceback {
  const lines = text.split(/\r?\n/);
  const frames: TracebackFrame[] = [];

  for (const raw of lines) {
    const frame = parseFrame(raw);
    if (frame !== undefined) {
      frames.push(frame);
    }
  }

  return {
    frames: frames.slice(-MAX_FRAMES),
    exception: findExceptionLine(lines),
  };
}

function parseFrame(raw: string): TracebackFrame | undefined {
  const groups = (PYTHON_FRAME.exec(raw) ?? GENERIC_FRAME.exec(raw))?.groups;

  if (groups === undefined) {
    return undefined;
  }

  const { path, line, fn } = groups;

  if (path === undefined || line === undefined) {
    return undefined;
  }

  return { path, line: Number(line), functionName: fn };
}

/** The summary line is the last non-empty, non-indented line that is not itself a frame. */
function findExceptionLine(lines: string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const raw = lines[index];

    if (raw === undefined || raw.trim() === "" || /^\s/.test(raw)) {
      continue;
    }

    if (raw.startsWith("Traceback") || parseFrame(raw) !== undefined) {
      continue;
    }

    return raw.trim();
  }

  return undefined;
}

/** Collapses frames into one entry per file, keeping first-appearance order. */
export function referencedFiles(parsed: ParsedTraceback): ReferencedFile[] {
  const byPath = new Map<string, { lines: Set<number>; innermostLine: number }>();

  for (const frame of parsed.frames) {
    const existing = byPath.get(frame.path);

    if (existing === undefined) {
      byPath.set(frame.path, {
        lines: new Set([frame.line]),
        innermostLine: frame.line,
      });
    } else {
      existing.lines.add(frame.line);
      existing.innermostLine = frame.line;
    }
  }

  return [...byPath].map(([path, entry]) => ({
    path,
    lines: [...entry.lines].sort((a, b) => a - b),
    innermostLine: entry.innermostLine,
  }));
}

/** True when a reported path tries to climb out of wherever it is resolved. */
export function hasTraversalSegment(path: string): boolean {
  return normalizeReportedPath(path).split("/").includes("..");
}

/** True for paths inside a dependency or cache directory. */
export function isVendorPath(path: string): boolean {
  return normalizeReportedPath(path)
    .split("/")
    .some((segment) => VENDOR_SEGMENTS.includes(segment));
}

/** Makes a reported path comparable to a URI path. */
export function normalizeReportedPath(reported: string): string {
  return reported.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function reportedBasename(reported: string): string {
  const normalized = normalizeReportedPath(reported);
  const index = normalized.lastIndexOf("/");

  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** True when a real file path is, or ends with, the path the toolchain printed. */
export function pathMatchesReported(fsPath: string, reported: string): boolean {
  const target = normalizeReportedPath(reported);
  const actual = normalizeReportedPath(fsPath);

  return actual === target || actual.endsWith(`/${target}`);
}

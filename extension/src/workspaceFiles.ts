import { resolve as resolvePath } from "node:path";

import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

import type { FileCandidate } from "../shared/protocol";
import {
  hasTraversalSegment,
  isVendorPath,
  pathMatchesReported,
  reportedBasename,
  type ReferencedFile,
} from "./traceback";

/** Turning the paths printed in an error into real files on this machine. */

/** Never search inside dependency, build, or VCS directories. */
const EXCLUDE_GLOB =
  "**/{node_modules,.venv,venv,__pycache__,site-packages,dist-packages,.git,dist,build,.tox}/**";

/** A reported basename can exist in several folders; offer only a few. */
const MAX_MATCHES_PER_FILE = 3;

/** Upper bound on how many files one error may pull in. */
const MAX_CANDIDATES = 8;

/** A candidate plus the details the webview is never told. */
export interface ResolvedCandidate {
  candidate: FileCandidate;
  uri: vscode.Uri;
  focusLine: number;
}

export async function resolveReferencedFiles(
  files: ReferencedFile[],
): Promise<ResolvedCandidate[]> {
  const resolved: ResolvedCandidate[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (resolved.length >= MAX_CANDIDATES) {
      break;
    }

    if (hasTraversalSegment(file.path)) {
      continue;
    }

    if (isVendorPath(file.path)) {
      continue;
    }

    const uri = await locate(file.path);

    if (uri === undefined || seen.has(uri.toString())) {
      continue;
    }

    seen.add(uri.toString());

    const stat = await vscode.workspace.fs.stat(uri);

    resolved.push({
      uri,
      focusLine: file.innermostLine,
      candidate: {
        id: randomUUID(),
        label: vscode.workspace.asRelativePath(uri, false),
        sizeBytes: stat.size,
        referencedLines: file.lines,
      },
    });
  }

  return resolved;
}

/** Finds the file a reported path refers to, in cheapest-first order. */
async function locate(reported: string): Promise<vscode.Uri | undefined> {
  const open = vscode.workspace.textDocuments.find(
    (document) =>
      document.uri.scheme === "file" &&
      pathMatchesReported(document.uri.fsPath, reported) &&
      isOfferable(document.uri),
  );

  if (open !== undefined) {
    return open.uri;
  }

  if (reported.startsWith("/") || /^[A-Za-z]:[\\/]/.test(reported)) {
    const uri = vscode.Uri.file(resolvePath(reported));

    if (isOfferable(uri)) {
      try {
        await vscode.workspace.fs.stat(uri);
        return uri;
      } catch {
        // Not on this machine; fall through to searching the workspace.
      }
    }
  }

  const matches = await vscode.workspace.findFiles(
    `**/${reportedBasename(reported)}`,
    EXCLUDE_GLOB,
    MAX_MATCHES_PER_FILE,
  );

  return (
    matches.find((uri) => pathMatchesReported(uri.fsPath, reported)) ??
    (matches.length === 1 ? matches[0] : undefined)
  );
}

/** Whether a file may be offered to the developer at all. */
function isOfferable(uri: vscode.Uri): boolean {
  const folders = vscode.workspace.workspaceFolders;

  if (folders !== undefined && folders.length > 0) {
    return vscode.workspace.getWorkspaceFolder(uri) !== undefined;
  }

  return vscode.workspace.textDocuments.some(
    (document) => document.uri.toString() === uri.toString(),
  );
}

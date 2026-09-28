import { basename } from "node:path";

import * as vscode from "vscode";

import { ALLOWED_SCHEMES, type EditorSnapshot } from "./capture";

/** The only module that reads the developer's editor. */

// activeTextEditor is undefined while our webview has focus, so remember the last one.
let lastEditor: vscode.TextEditor | undefined;

export function registerActiveEditorTracking(
  context: vscode.ExtensionContext,
): void {
  remember(vscode.window.activeTextEditor);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(remember),
  );
}

function remember(editor: vscode.TextEditor | undefined): void {
  if (editor === undefined) {
    return;
  }

  if (!ALLOWED_SCHEMES.includes(editor.document.uri.scheme)) {
    return;
  }

  lastEditor = editor;
}

/** The editor a capture should read, or undefined if there is no sensible one. */
export function getTargetEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;

  if (active !== undefined && ALLOWED_SCHEMES.includes(active.document.uri.scheme)) {
    return active;
  }

  if (lastEditor !== undefined && !lastEditor.document.isClosed) {
    return lastEditor;
  }

  return undefined;
}

export function snapshotEditor(editor: vscode.TextEditor): EditorSnapshot {
  return {
    ...snapshotDocument(editor.document),
    selection: editor.selection.isEmpty
      ? undefined
      : toLineRange(editor.selection),
  };
}

/** Snapshots a document with no selection. */
export function snapshotDocument(document: vscode.TextDocument): EditorSnapshot {
  return {
    label: labelFor(document),
    languageId: document.languageId,
    scheme: document.uri.scheme,
    lines: document.getText().split(/\r?\n/),
    selection: undefined,
  };
}

/** A short, shareable name for a document. */
function labelFor(document: vscode.TextDocument): string {
  if (document.isUntitled) {
    return document.uri.path;
  }

  const relative = vscode.workspace.asRelativePath(document.uri, false);

  return relative === document.uri.fsPath
    ? basename(document.uri.fsPath)
    : relative;
}

function toLineRange(selection: vscode.Selection): {
  startLine: number;
  endLine: number;
} {
  const endsAtLineStart =
    selection.end.character === 0 && selection.end.line > selection.start.line;

  return {
    startLine: selection.start.line + 1,
    endLine: endsAtLineStart ? selection.end.line : selection.end.line + 1,
  };
}

import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

import {
  attachmentKey,
  isWebviewToHost,
  type CaptureSource,
  type CodeContext,
  type DirectCaptureSource,
  type HintKind,
  type HintStep,
  type HostToWebview,
  type Outcome,
  type PendingAction,
  type Resolution,
  type WebviewToHost,
} from "../shared/protocol";
import {
  askQuestion,
  BackendError,
  completeSession,
  createSession,
  recordAttempt,
  requestHint,
  resolveBackendUrl,
} from "./backend";
import { buildCodeContext, shiftedSelection } from "./capture";
import { assessProfile } from "./profile/policy";
import {
  buildSessionRecord,
  startTally,
  withHint,
  withQuestion,
  withReport,
  type SessionTally,
} from "./profile/record";
import type { ProfileStore } from "./profile/store";
import { getTargetEditor, snapshotDocument, snapshotEditor } from "./editor";
import { parseTraceback, referencedFiles } from "./traceback";
import { resolveReferencedFiles } from "./workspaceFiles";

/** Upper bound on pasted error text. */
const MAX_ERROR_TEXT_LENGTH = 20_000;

/** "" is how the webview says "nothing here"; the backend wants it absent. */
function blankToUndefined(value: string): string | undefined {
  return value.trim() === "" ? undefined : value;
}

/** What a command asked the panel to do once its webview is ready. */
type PanelRequest = DirectCaptureSource | "profile";

/** A file offered to the developer, kept out of the webview's reach. */
interface OfferedFile {
  uri: vscode.Uri;
  focusLine: number;
  label: string;
}

/** Where an attachment came from, so it can be read again on Report result. */
interface CaptureOrigin {
  uri: vscode.Uri;
  source: CaptureSource;
  selection: { startLine: number; endLine: number };
  focusLine: number | undefined;
  documentLines: number;
}

/** One attachment in the running session: where it came from, and its latest text. */
interface SessionAttachment {
  origin: CaptureOrigin | undefined;
  latest: CodeContext;
}

/** Owns the lifecycle of the single Socrates' Duck webview panel. */
export class SocraticPanel {
  private static readonly viewType = "socratesDuck.panel";

  private static current: SocraticPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private pendingCapture: PanelRequest | undefined;

  private sessionId: string | undefined;

  /** True while Finish or Give up is on its way, so closing the panel doesn't record it twice. */
  private ending = false;

  /** Counts for the local profile; only derived numbers, never content. */
  private tally: SessionTally | undefined;

  private readonly offeredFiles = new Map<string, OfferedFile>();

  private readonly captureOrigins = new Map<string, CaptureOrigin>();

  private sessionAttachments: SessionAttachment[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    profile: ProfileStore,
    capture?: PanelRequest,
  ): void {
    const existing = SocraticPanel.current;

    if (existing !== undefined) {
      const wasVisible = existing.panel.visible;
      existing.pendingCapture = capture;
      existing.panel.reveal(vscode.ViewColumn.Beside);

      if (wasVisible) {
        existing.flushPendingCapture();
      }

      return;
    }

    const panel = vscode.window.createWebviewPanel(
      SocraticPanel.viewType,
      "Socrates' Duck",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );

    SocraticPanel.current = new SocraticPanel(panel, extensionUri, profile, capture);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly profile: ProfileStore,
    pendingCapture: PanelRequest | undefined,
  ) {
    this.panel = panel;
    this.pendingCapture = pendingCapture;
    this.panel.webview.html = this.buildHtml(extensionUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message),
      null,
      this.disposables,
    );
  }

  private handleMessage(message: unknown): void {
    if (!isWebviewToHost(message)) {
      return;
    }

    switch (message.type) {
      case "ready":
        this.flushPendingCapture();
        return;
      case "capture":
        this.captureContext(message.source);
        return;
      case "analyzeError":
        this.analyzeError(message.text).catch(() => this.reportUnexpectedFailure());
        return;
      case "attachFiles":
        this.attachFiles(message.ids).catch(() => this.reportUnexpectedFailure());
        return;
      case "startSession":
        this.run("start", () => this.startSession(message));
        return;
      case "requestHint":
        this.run("hint", () => this.hint(message.kind));
        return;
      case "askQuestion":
        this.run("ask", () => this.ask(message.hintNumber, message.question));
        return;
      case "shareObservation":
        this.run("observe", () => this.shareObservation(message.observation));
        return;
      case "reportOutcome":
        this.run("report", () => this.reportOutcome(message));
        return;
      case "endSession":
        this.run("end", () =>
          this.endSession(message.status, message.outcome, message.resolution),
        );
        return;
      case "showProfile":
        this.showProfile(false);
        return;
    }
  }

  private run(action: PendingAction, work: () => Promise<void>): void {
    work().catch((error: unknown) => {
      this.post({
        type: "requestFailed",
        action,
        reason:
          error instanceof BackendError
            ? error.message
            : "Something went wrong talking to the backend. Please try again.",
      });
    });
  }

  private async startSession(
    message: Extract<WebviewToHost, { type: "startSession" }>,
  ): Promise<void> {
    const baseUrl = this.backendUrl();
    this.sessionAttachments = message.contexts.map((context) => ({
      origin: this.captureOrigins.get(attachmentKey(context)),
      latest: context,
    }));
    const started = await createSession(baseUrl, {
      problem: message.problem,
      evidence: blankToUndefined(message.evidence),
      codeContexts: message.contexts,
    });

    this.sessionId = started.id;
    this.tally = startTally(
      Date.now(),
      blankToUndefined(message.evidence) !== undefined,
    );
    this.post({ type: "sessionStarted", session: started.session });

    const hint = await requestHint(baseUrl, started.id, "normal", this.reportStep);

    this.count((tally) => withHint(tally, "normal", hint.level));
    this.post({ type: "hintReceived", hint });
  }

  private async hint(kind: HintKind): Promise<void> {
    const sessionId = this.requireSession();
    const hint = await requestHint(this.backendUrl(), sessionId, kind, this.reportStep);

    this.count((tally) => withHint(tally, kind, hint.level));
    this.post({ type: "hintReceived", hint });
  }

  private async ask(hintNumber: number, question: string): Promise<void> {
    const sessionId = this.requireSession();
    const answer = await askQuestion(
      this.backendUrl(),
      sessionId,
      hintNumber,
      question,
      this.reportStep,
    );

    this.count(withQuestion);
    this.post({ type: "answerReceived", answer });
  }

  /**
   * A note on what the developer saw after the last hint. Sent as an attempt
   * with no outcome and no code, so nothing is read from the editor.
   */
  private async shareObservation(observation: string): Promise<void> {
    const sessionId = this.requireSession();
    const session = await recordAttempt(this.backendUrl(), sessionId, {
      reasoning: observation,
      evidence: undefined,
      outcome: undefined,
      codeContexts: undefined,
    });

    this.post({ type: "attemptRecorded", session, hintFollows: true });

    const hint = await requestHint(
      this.backendUrl(),
      sessionId,
      "normal",
      this.reportStep,
    );

    this.count((tally) => withHint(tally, "normal", hint.level));
    this.post({ type: "hintReceived", hint });
  }

  private async reportOutcome(
    message: Extract<WebviewToHost, { type: "reportOutcome" }>,
  ): Promise<void> {
    const sessionId = this.requireSession();
    const session = await recordAttempt(this.backendUrl(), sessionId, {
      reasoning: message.reasoning,
      evidence: blankToUndefined(message.evidence),
      outcome: message.outcome,
      codeContexts: await this.rereadAttachments(),
    });

    this.count((tally) => withReport(tally, message.outcome));

    const hintFollows = message.outcome !== "resolved";
    this.post({ type: "attemptRecorded", session, hintFollows });

    if (!hintFollows) {
      return;
    }

    const hint = await requestHint(
      this.backendUrl(),
      sessionId,
      "normal",
      this.reportStep,
    );

    this.count((tally) => withHint(tally, "normal", hint.level));
    this.post({ type: "hintReceived", hint });
  }

  private async rereadAttachments(): Promise<CodeContext[] | undefined> {
    if (this.sessionAttachments.every((entry) => entry.origin === undefined)) {
      return undefined;
    }

    for (const entry of this.sessionAttachments) {
      const origin = entry.origin;

      if (origin === undefined) {
        continue;
      }

      try {
        const document = await vscode.workspace.openTextDocument(origin.uri);
        const snapshot = snapshotDocument(document);

        if (origin.source === "selection") {
          snapshot.selection = shiftedSelection(
            origin.selection,
            origin.documentLines,
            document.lineCount,
          );
        }

        const result = buildCodeContext(snapshot, origin.source, origin.focusLine);

        if (!result.ok) {
          throw new Error(result.reason);
        }

        entry.latest = result.context;
        origin.selection = {
          startLine: result.context.startLine,
          endLine: result.context.endLine,
        };
        origin.documentLines = document.lineCount;
      } catch {
        this.post({
          type: "captureFailed",
          reason: `Could not read ${entry.latest.label} again, so the next hint uses the version from before.`,
        });
      }
    }

    return this.sessionAttachments.map((entry) => entry.latest);
  }

  private rememberOrigin(
    context: CodeContext,
    document: vscode.TextDocument,
    focusLine?: number,
  ): void {
    this.captureOrigins.set(attachmentKey(context), {
      uri: document.uri,
      source: context.source,
      selection: { startLine: context.startLine, endLine: context.endLine },
      focusLine,
      documentLines: document.lineCount,
    });
  }

  private async endSession(
    status: "completed" | "abandoned",
    outcome: Outcome | null,
    resolution: Resolution,
  ): Promise<void> {
    const sessionId = this.requireSession();
    this.ending = true;

    try {
      const session = await completeSession(
        this.backendUrl(),
        sessionId,
        status,
        outcome,
      );

      this.sessionId = undefined;
      this.post({ type: "sessionEnded", session });
    } finally {
      this.ending = false;
    }

    await this.recordSession(status, resolution);
  }

  /** Updates the profile view if it is open, after the stored profile changed. */
  public static profileChanged(): void {
    SocraticPanel.current?.showProfile(true);
  }

  private count(update: (tally: SessionTally) => SessionTally): void {
    if (this.tally !== undefined) {
      this.tally = update(this.tally);
    }
  }

  /** Adds the finished session to the local profile; a failure only shows in the status bar. */
  private async recordSession(
    status: "completed" | "abandoned",
    resolution: Resolution,
  ): Promise<void> {
    const tally = this.tally;
    this.tally = undefined;

    if (tally === undefined) {
      return;
    }

    const saved = await this.profile.append(
      buildSessionRecord(tally, Date.now(), status, resolution),
    );

    if (!saved) {
      vscode.window.setStatusBarMessage(
        "Socrates' Duck: couldn't update your local profile.",
        5_000,
      );
    }
  }

  private showProfile(refreshOnly: boolean): void {
    try {
      const loaded = this.profile.load();

      this.post({
        type: "profile",
        profile: assessProfile(loaded.sessions, loaded.notice),
        refreshOnly,
      });
    } catch {
      this.post({
        type: "captureFailed",
        reason: "Your profile couldn't be shown. Your session is not affected.",
      });
    }
  }

  private requireSession(): string {
    const sessionId = this.sessionId;

    if (sessionId === undefined) {
      throw new BackendError(
        "That session has ended. Start a new one to keep going.",
      );
    }

    return sessionId;
  }

  private backendUrl(): string {
    return resolveBackendUrl(
      vscode.workspace
        .getConfiguration("socratesDuck")
        .get<string>("backendUrl"),
    );
  }

  private async analyzeError(text: string): Promise<void> {
    const parsed = parseTraceback(text.slice(0, MAX_ERROR_TEXT_LENGTH));
    const resolved = await resolveReferencedFiles(referencedFiles(parsed));

    this.offeredFiles.clear();
    for (const { candidate, uri, focusLine } of resolved) {
      this.offeredFiles.set(candidate.id, {
        uri,
        focusLine,
        label: candidate.label,
      });
    }

    this.post({
      type: "errorAnalyzed",
      candidates: resolved.map((entry) => entry.candidate),
      exception: parsed.exception,
    });
  }

  private async attachFiles(ids: string[]): Promise<void> {
    for (const id of ids) {
      const offered = this.offeredFiles.get(id);

      if (offered === undefined) {
        continue;
      }

      try {
        const document = await vscode.workspace.openTextDocument(offered.uri);
        const result = buildCodeContext(
          snapshotDocument(document),
          "traceback",
          offered.focusLine,
        );

        if (result.ok) {
          this.rememberOrigin(result.context, document, offered.focusLine);
        }

        this.post(
          result.ok
            ? { type: "captured", context: result.context }
            : { type: "captureFailed", reason: result.reason },
        );
      } catch {
        this.post({
          type: "captureFailed",
          reason: `Could not read ${offered.label}. It may have been moved or deleted.`,
        });
      }
    }
  }

  private reportUnexpectedFailure(): void {
    this.post({
      type: "captureFailed",
      reason: "Something went wrong reading your files. Please try again.",
    });
  }

  private flushPendingCapture(): void {
    const pending = this.pendingCapture;

    if (pending === undefined) {
      return;
    }

    this.pendingCapture = undefined;

    if (pending === "profile") {
      this.showProfile(false);
    } else {
      this.captureContext(pending);
    }
  }

  private captureContext(source: DirectCaptureSource): void {
    const editor = getTargetEditor();

    if (editor === undefined) {
      this.post({
        type: "captureFailed",
        reason:
          "No file is open. Open the code you are working on, then try again.",
      });
      return;
    }

    const result = buildCodeContext(snapshotEditor(editor), source);

    if (result.ok) {
      this.rememberOrigin(result.context, editor.document);
    }

    this.post(
      result.ok
        ? { type: "captured", context: result.context }
        : { type: "captureFailed", reason: result.reason },
    );
  }

  private readonly reportStep = (step: HintStep): void => {
    this.post({ type: "hintProgress", step });
  };

  private post(message: HostToWebview): void {
    this.panel.webview.postMessage(message).then(undefined, () => {
    });
  }

  private buildHtml(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "webview.css"),
    );

    const nonce = randomUUID().replaceAll("-", "");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <link href="${styleUri.toString()}" rel="stylesheet" />
    <title>Socrates' Duck</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
  </body>
</html>`;
  }

  public dispose(): void {
    SocraticPanel.current = undefined;
    this.abandonOpenSession();
    this.panel.dispose();

    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private abandonOpenSession(): void {
    const sessionId = this.sessionId;

    // An end already on its way will finish and record the developer's own answer.
    if (sessionId === undefined || this.ending) {
      return;
    }

    this.sessionId = undefined;

    completeSession(this.backendUrl(), sessionId, "abandoned", null).catch(
      () => {
      },
    );
    this.recordSession("abandoned", "not_asked").catch(() => {
    });
  }
}

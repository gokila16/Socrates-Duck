import type { WebviewToHost } from "../shared/protocol";

/** The webview's only way to reach the extension host. */

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  function acquireVsCodeApi(): VsCodeApi;
}

export const vscodeApi: VsCodeApi = acquireVsCodeApi();

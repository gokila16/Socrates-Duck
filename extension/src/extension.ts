import * as vscode from "vscode";

import { registerActiveEditorTracking } from "./editor";
import { SocraticPanel } from "./panel";

/** Called once, the first time one of this extension's commands is invoked. */
export function activate(context: vscode.ExtensionContext): void {
  registerActiveEditorTracking(context);

  const openCommand = vscode.commands.registerCommand(
    "socratesDuck.open",
    () => {
      SocraticPanel.createOrShow(context.extensionUri);
    },
  );

  const startFromSelectionCommand = vscode.commands.registerCommand(
    "socratesDuck.startFromSelection",
    () => {
      SocraticPanel.createOrShow(context.extensionUri, "selection");
    },
  );

  context.subscriptions.push(openCommand, startFromSelectionCommand);
}

/** Called when the extension is shut down. */
export function deactivate(): void {
}

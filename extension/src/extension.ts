import { homedir } from "node:os";
import { join } from "node:path";

import * as vscode from "vscode";

import { registerActiveEditorTracking } from "./editor";
import { SocraticPanel } from "./panel";
import { ProfileStore } from "./profile/store";

/** Called once, the first time one of this extension's commands is invoked. */
export function activate(context: vscode.ExtensionContext): void {
  registerActiveEditorTracking(context);

  const profile = new ProfileStore(context.globalState);

  const openCommand = vscode.commands.registerCommand(
    "socratesDuck.open",
    () => {
      SocraticPanel.createOrShow(context.extensionUri, profile);
    },
  );

  const startFromSelectionCommand = vscode.commands.registerCommand(
    "socratesDuck.startFromSelection",
    () => {
      SocraticPanel.createOrShow(context.extensionUri, profile, "selection");
    },
  );

  const showProfileCommand = vscode.commands.registerCommand(
    "socratesDuck.showProfile",
    () => {
      SocraticPanel.createOrShow(context.extensionUri, profile, "profile");
    },
  );

  const resetProfileCommand = vscode.commands.registerCommand(
    "socratesDuck.resetProfile",
    () => resetProfile(profile),
  );

  const exportProfileCommand = vscode.commands.registerCommand(
    "socratesDuck.exportProfile",
    () => exportProfile(profile),
  );

  context.subscriptions.push(
    openCommand,
    startFromSelectionCommand,
    showProfileCommand,
    resetProfileCommand,
    exportProfileCommand,
  );
}

async function resetProfile(profile: ProfileStore): Promise<void> {
  const confirm = "Reset profile";
  const choice = await vscode.window.showWarningMessage(
    "Reset your Socrates' Duck profile?",
    {
      modal: true,
      detail:
        "This deletes the session summaries stored on this machine. It can't be undone. Your evaluation metrics are not affected.",
    },
    confirm,
  );

  if (choice !== confirm) {
    return;
  }

  if (await profile.reset()) {
    SocraticPanel.profileChanged();
    void vscode.window.showInformationMessage("Your Socrates' Duck profile was reset.");
  } else {
    void vscode.window.showWarningMessage("Your profile couldn't be reset. Please try again.");
  }
}

async function exportProfile(profile: ProfileStore): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(join(homedir(), "socrates-duck-profile.json")),
    filters: { JSON: ["json"] },
    saveLabel: "Export profile",
  });

  if (target === undefined) {
    return;
  }

  try {
    await vscode.workspace.fs.writeFile(
      target,
      new TextEncoder().encode(profile.exportJson(new Date())),
    );
    void vscode.window.showInformationMessage("Your Socrates' Duck profile was exported.");
  } catch {
    void vscode.window.showWarningMessage("The profile file couldn't be written.");
  }
}

/** Called when the extension is shut down. */
export function deactivate(): void {
}

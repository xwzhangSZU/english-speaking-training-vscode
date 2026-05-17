import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { appendOutput, showOutput, stringValue } from "../core.js";
import type { JsonObject } from "../types.js";
import { refreshAll } from "../runtime/host.js";
import { pythonPath } from "../runtime/settings.js";
import { execFile, isHttpUrl } from "../runtime/training-root.js";
import { invalidateNextPackageCache, loadState } from "../runtime/state.js";

export async function completeLocalPackage(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date);
  if (!packageDate) {
    throw new Error("No current package to complete.");
  }
  const script = path.join(state.root, "scripts", "english_training_progress.py");
  if (!fs.existsSync(script)) {
    throw new Error("Local completion requires scripts/english_training_progress.py in this workspace.");
  }
  const result = await execFile(state.root, [
    "scripts/english_training_progress.py",
    "complete",
    "--date",
    packageDate,
    "--due-date",
    state.today,
    "--no-todoist",
    "--note",
    "Completed in VS Code local practice.",
  ], 90_000);
  showOutput(true);
  appendOutput(`\n$ ${pythonPath()} scripts/english_training_progress.py complete --date ${packageDate} --due-date ${state.today} --no-todoist`);
  appendOutput(result.stdout.trim());
  if (result.stderr.trim()) appendOutput(result.stderr.trim());
  if (result.code !== 0) {
    throw new Error(`Local completion failed: ${result.stderr || result.stdout}`);
  }
  vscode.window.showInformationMessage(`Completed ${packageDate} locally.`);
  // Completion advances which package is "next"; drop the memoized result
  // so the refresh below (and the next record/stop) re-resolve once.
  invalidateNextPackageCache();
  await refreshAll();
}

export async function openCurrentTaskCard(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const assets = (state.next.assets as JsonObject | undefined) ?? {};
  const taskCard = stringValue(assets.task_card);
  if (taskCard && isHttpUrl(taskCard)) {
    await vscode.env.openExternal(vscode.Uri.parse(taskCard));
    return;
  }
  const localTaskCard = existingFilePath(taskCard);
  const currentJson = existingFilePath(state.sourceDiagnostics.currentJson);
  const target = localTaskCard || currentJson;
  if (!target) {
    throw new Error("No task card or english-training.json path is available.");
  }
  await vscode.window.showTextDocument(vscode.Uri.file(target));
}

export async function revealCurrentPackage(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const assets = (state.next.assets as JsonObject | undefined) ?? {};
  const packageDir = stringValue(assets.package_dir);
  if (!packageDir) {
    throw new Error("No package directory is available.");
  }
  if (isHttpUrl(packageDir)) {
    await vscode.env.openExternal(vscode.Uri.parse(packageDir));
    return;
  }
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(packageDir));
}

export async function openSessionFolder(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const dir = path.join(state.root, "runtime", "vscode-sessions");
  fs.mkdirSync(dir, { recursive: true });
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
}

export function existingFilePath(value: string): string {
  if (!value || isHttpUrl(value) || !fs.existsSync(value)) {
    return "";
  }
  try {
    return fs.statSync(value).isFile() ? value : "";
  } catch {
    return "";
  }
}

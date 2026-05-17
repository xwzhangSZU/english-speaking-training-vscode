import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { writeJson } from "../core.js";
import {
  blankFollowupDrillPackage,
  blankTrainingPackage,
  buildGenerationPrompt,
} from "../card-schema.js";
import { openMaterialsGuide } from "../materials-guide.js";
import { refreshAll } from "../runtime/host.js";
import { invalidateNextPackageCache } from "../runtime/state.js";
import { findTrainingRoot, readLocalInventory, todayInConfiguredTimezone } from "../runtime/training-root.js";
import { sampleFollowupDrillPackage, sampleTrainingPackage } from "./sample-package.js";

export async function createSamplePackage(context: vscode.ExtensionContext): Promise<void> {
  const root = await resolveOrBootstrapLocalRoot();
  if (!root) {
    return;
  }
  const today = todayInConfiguredTimezone();
  const dateInput = await vscode.window.showInputBox({
    title: "Create Sample Package",
    prompt: "Lesson date (YYYY-MM-DD). Defaults to today.",
    value: today,
    ignoreFocusOut: true,
    validateInput: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? null : "Use YYYY-MM-DD format.",
  });
  if (!dateInput) {
    return;
  }
  const targetDate = dateInput.trim();
  const packageDir = path.join(root, "prebuilt", targetDate);
  const targetFile = path.join(packageDir, "english-training.json");
  if (fs.existsSync(targetFile)) {
    const overwrite = await vscode.window.showWarningMessage(
      `${targetDate}/english-training.json already exists. Overwrite?`,
      { modal: true },
      "Overwrite",
    );
    if (overwrite !== "Overwrite") {
      return;
    }
  }
  fs.mkdirSync(packageDir, { recursive: true });
  writeJson(targetFile, sampleTrainingPackage(targetDate));
  writeJson(path.join(packageDir, "followup-drill.json"), sampleFollowupDrillPackage(targetDate));
  vscode.window.showInformationMessage(`Sample lesson and FSI drill written to prebuilt/${targetDate}. Edit them and refresh the sidebar.`);
  await vscode.window.showTextDocument(vscode.Uri.file(targetFile));
  // A new prebuilt/<date> can change which package is "next".
  invalidateNextPackageCache();
  await refreshAll();
}

function nextPackageDate(root: string): string {
  const today = todayInConfiguredTimezone();
  let latest = "";
  try {
    const { dates } = readLocalInventory(root);
    latest = dates.length ? dates[dates.length - 1] : "";
  } catch {
    latest = "";
  }
  const base = latest && latest >= today ? latest : "";
  if (!base) {
    return today;
  }
  const next = new Date(`${base}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export async function generateNextPackage(context: vscode.ExtensionContext): Promise<void> {
  const root = await resolveOrBootstrapLocalRoot();
  if (!root) {
    return;
  }
  const suggested = nextPackageDate(root);
  const dateInput = await vscode.window.showInputBox({
    title: "Generate Next Package",
    prompt: "Lesson date (YYYY-MM-DD). Defaults to the day after your latest lesson.",
    value: suggested,
    ignoreFocusOut: true,
    validateInput: (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? null : "Use YYYY-MM-DD format."),
  });
  if (!dateInput) {
    return;
  }
  const targetDate = dateInput.trim();
  const brief = await vscode.window.showInputBox({
    title: "Generate Next Package — Learner Brief",
    prompt: "Optional: topic / material / situation to practice. Leave blank to fill in the prompt later.",
    ignoreFocusOut: true,
  });
  const packageDir = path.join(root, "prebuilt", targetDate);
  const targetFile = path.join(packageDir, "english-training.json");
  if (fs.existsSync(targetFile)) {
    const overwrite = await vscode.window.showWarningMessage(
      `${targetDate}/english-training.json already exists. Overwrite with a blank skeleton?`,
      { modal: true },
      "Overwrite",
    );
    if (overwrite !== "Overwrite") {
      return;
    }
  }
  fs.mkdirSync(packageDir, { recursive: true });
  writeJson(targetFile, blankTrainingPackage(targetDate));
  writeJson(path.join(packageDir, "followup-drill.json"), blankFollowupDrillPackage(targetDate));
  const prompt = buildGenerationPrompt({
    date: targetDate,
    brief: brief ?? "",
    sampleTraining: sampleTrainingPackage(targetDate),
    sampleDrill: sampleFollowupDrillPackage(targetDate),
  });
  const promptDoc = await vscode.workspace.openTextDocument({ language: "markdown", content: prompt });
  await vscode.window.showTextDocument(promptDoc, { preview: false });
  await vscode.window.showTextDocument(vscode.Uri.file(targetFile), { preview: false });
  vscode.window.showInformationMessage(
    `Blank skeleton written to prebuilt/${targetDate}. Feed the generation prompt to any LLM ` +
      "(MiniMax / Gemini / Kimi / ...), paste its two JSON blocks back into the skeleton files, then Refresh.",
  );
  // A new prebuilt/<date> can change which package is "next".
  invalidateNextPackageCache();
  await refreshAll();
}

async function resolveOrBootstrapLocalRoot(): Promise<string | undefined> {
  try {
    return await findTrainingRoot();
  } catch {
    // fall through to bootstrap flow
  }
  const choice = await vscode.window.showInformationMessage(
    "No local materials folder found. Pick a folder to host your lessons — the extension will create prebuilt/ and progress/ inside it.",
    { modal: true },
    "Pick Folder",
    "Open Guide",
  );
  if (choice === "Open Guide") {
    await openMaterialsGuide();
    return undefined;
  }
  if (choice !== "Pick Folder") {
    return undefined;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Use this folder for English Training materials",
  });
  if (!picked || picked.length === 0) {
    return undefined;
  }
  const root = picked[0].fsPath;
  fs.mkdirSync(path.join(root, "prebuilt"), { recursive: true });
  fs.mkdirSync(path.join(root, "progress"), { recursive: true });
  await vscode.workspace.getConfiguration().update("englishTraining.localMaterialsRoot", root, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`English Training materials root set to ${root}.`);
  return root;
}

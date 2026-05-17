import * as vscode from "vscode";

export function randomNonce(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

export function buildPracticeHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomNonce();
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "practice.css"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "practice.js"));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; media-src ${webview.cspSource} https: blob: data:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">

</head>
<body>
  <div class="stack">
    <section class="panel record-panel">
      <div class="record-row">
        <button id="record" class="record-cta" aria-label="Start recording" title="Start recording">
          <span class="record-cta-icon"></span>
        </button>
        <div class="record-meta">
          <div class="record-status" id="status">Ready to record</div>
          <div class="record-meter">
            <span id="timer">00:00</span>
            <canvas id="vu" width="100" height="14"></canvas>
            <button class="ghost" id="refresh" title="Refresh state" aria-label="Refresh state">↻</button>
          </div>
        </div>
      </div>
      <div class="speed-row" id="speedRow" role="group" aria-label="Playback speed">
        <span class="speed-label">Speed</span>
        <div class="speed-chips" id="speedChips"></div>
      </div>
      <ol class="stages" id="stages" hidden>
        <li data-stage="transcribe"><span class="stage-dot"></span><span class="stage-name">Transcribe</span></li>
        <li data-stage="coach"><span class="stage-dot"></span><span class="stage-name">Coach</span></li>
        <li data-stage="tts"><span class="stage-dot"></span><span class="stage-name">Speak</span></li>
        <li data-stage="save"><span class="stage-dot"></span><span class="stage-name">Save</span></li>
      </ol>
      <audio id="localAudio" controls hidden></audio>
    </section>
    <section class="panel onboarding-panel" id="onboarding" hidden></section>
    <section class="panel progress-panel" id="progress" hidden></section>
    <section class="panel" id="task"></section>
    <section class="panel" id="readingCard" hidden></section>
    <section class="panel" id="diagnostics"></section>
    <section class="panel" id="learnerProfile"></section>
    <section class="panel" id="drill"></section>
    <section class="panel" id="turnHistory" hidden></section>
    <section class="panel" id="result" hidden></section>
    <section class="panel" id="sessionLog"></section>
    <section class="panel">
      <h3>Source</h3>
      <div id="source" class="chips"></div>
      <div class="row">
        <button class="secondary" id="configureMaterials">Local Folder</button>
      </div>
    </section>
    <section class="panel" id="providersPanel"></section>
    <section class="panel">
      <h3>Local</h3>
      <div class="row">
        <button class="secondary" id="completeLocal">Complete</button>
        <button class="secondary" id="openTask">Task Card</button>
        <button class="secondary" id="openFolder">Sessions</button>
      </div>
    </section>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

# English Speaking Training VS Code Extension

Standalone VS Code speaking-practice cockpit for `EnglishSpeakingTraining`
materials.

The extension no longer depends on Hermes or Telegram for the main practice
loop. It reads local `prebuilt/` package files, records inside a VS Code webview,
stores API keys in VS Code SecretStorage, and writes session artifacts locally.

## Bring Your Own Materials

The extension does **not** ship lessons. You point it at a local `prebuilt/`
directory of your own, and it walks every `YYYY-MM-DD` subdirectory it finds.
There is no required curriculum length: 7 lessons or 365 lessons both work.

**First-run path** (no lessons yet):

1. Open the **English Training** sidebar. The Quick Setup card lists what's
   missing.
2. Click *Pick local folder* or run `English Training: Configure Local Materials
   Folder`.
3. Click *Create your first lesson* → pick a folder; the extension
   creates `prebuilt/` and `progress/` inside it and writes a starter
   `prebuilt/<today>/english-training.json` you can edit.
4. Click *Add your first AI key* → pick a provider (MiMo recommended for the
   default coach + STT + TTS combo).
5. Press the red record button.

For the field-by-field schema, run `English Training: Open Materials Guide`
from the command palette.

## Local Materials Source

- **Local**: auto-detects a workspace or parent folder containing `prebuilt/`.
- **Fixed local path**: set `englishTraining.localMaterialsRoot` to a directory
  containing `prebuilt/` so the sidebar works from any VS Code workspace.
- **Picker**: run `English Training: Configure Local Materials Folder`, or click
  `Source -> Local Folder` in the sidebar.

## Source Diagnostics and Learner Profile

The Practice sidebar shows **Source Diagnostics** so you can verify what it
actually loaded: local root, lesson count, current package date, and the exact
`english-training.json` path.

To personalize coaching, add one of these files to your materials root:

- `profile/learner-profile.md`
- `profile/learner-profile.json`

When found, the sidebar shows **Profile loaded** and the coach receives that
profile with every practice turn. If no profile exists, the sidebar shows the
expected path.

## Provider Defaults

- Speech input: OpenAI `gpt-4o-transcribe` by default, with Gemini
  `gemini-2.5-flash` and MiMo `mimo-v2.5` as options
- Coach: Xiaomi MiMo `mimo-v2.5`, with MiniMax `MiniMax-M2.7-highspeed` and
  Gemini `gemini-2.5-flash`, Kimi Code `kimi-for-coding`, and DeepSeek `deepseek-v4-pro`
  as language-model options
- Speech output: MiniMax `speech-2.8-hd` with `English_expressive_narrator` by
  default, with OpenAI `gpt-4o-mini-tts`, Gemini
  `gemini-2.5-flash-preview-tts`, and MiMo `mimo-v2.5-tts` as options

## Features

- `English Training` Activity Bar container with a `Practice` webview.
- Direct `Record` / `Stop` microphone flow inside the sidebar.
- Transcript, native-speaker version, concrete problems, repeat instruction,
  and follow-up question returned in the same sidebar.
- On-demand *Example audio*: click `Generate Example` to synthesize only the
  lesson example text (`clean_tts_text`, `audio_text`, or `demo_line`) with
  your configured speech-output provider. Scenario and goal background are not
  read aloud.
- Generated native-version audio saved locally and played in VS Code.
- API key commands:
  - `English Training: Configure OpenAI API Key`
  - `English Training: Configure Gemini API Key`
  - `English Training: Configure MiniMax API Key`
  - `English Training: Configure MiMo API Key`
  - `English Training: Configure Kimi API Key`
  - `English Training: Configure DeepSeek API Key`
- Local actions:
  - `English Training: Complete Current Package Locally`
  - `English Training: Open Current Task Card`
  - `English Training: Open Local Session Folder`
  - `English Training: Configure Local Materials Folder`

## Development

```sh
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

Open this folder in VS Code and press `F5` to run an Extension Development
Host. The host needs a workspace folder that contains a `prebuilt/` directory
to activate the extension; you can point it at any folder with lessons, or use
`English Training: Configure Local Materials Folder` from the command palette.

The legacy Python tooling that originally generated the daily packages now
lives in `reference/` (gitignored). It is kept as a methodology archive only —
the extension does not depend on it at runtime.

## Notes

The recorder defaults to `englishTraining.recorderBackend = macLocal` on macOS.
That path records through `ffmpeg` AVFoundation, auto-selects a local Mac
microphone such as `iMac Microphone`, and avoids device names matching
`englishTraining.blockedMicrophoneNamePattern` such as iPhone/Continuity inputs.
Set `englishTraining.preferredMicrophoneName` if you want to pin a specific
local microphone.

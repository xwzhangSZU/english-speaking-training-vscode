import type { JsonObject } from "./types.js";

/**
 * Versioned, machine-readable contract for the daily training package and the
 * follow-up FSI drill package. Any LLM (MiniMax / Gemini / Kimi / OpenAI / ...)
 * can read CARD_SCHEMA and emit a package this extension renders identically:
 * the pitch/contour card, the falling-tone card, the stress card, and the
 * reading-card images all derive from the fields described here.
 *
 * Keep this file the single source of truth for the contract. The renderer in
 * media/practice.js and the docs in materials-guide.ts must stay consistent
 * with the enumerations declared below.
 */

export const CARD_SCHEMA_VERSION = "1.2";

/** Glyphs the renderer understands for intonation contours. */
export const CONTOUR_GLYPHS = ["→", "↘", "↗", "↑", "↓"] as const;
/** Pause weights between thought groups. */
export const PAUSE_VALUES = ["none", "short", "long", "final"] as const;
/** Stress levels mapped to the stress card. */
export const STRESS_LEVELS = ["weak", "support", "nucleus"] as const;

export const CARD_SCHEMA: JsonObject = {
  schema: "english-training/card-schema",
  version: CARD_SCHEMA_VERSION,
  summary:
    "Daily English speaking-training package consumed by the English Training VS Code extension. " +
    "The extension renders a TODAY hero card (sentence + audio + prosody) and an FSI drill workbench " +
    "from these fields. Produce valid JSON only — every enumerated field must use an allowed value.",
  files: {
    "english-training.json": "Required. The daily lesson + prosody contract (object described in trainingPackage).",
    "followup-drill.json": "Optional but recommended. FSI substitution + shadowing rounds (object in followupDrillPackage).",
    "manifest.json": "Optional. Declares generated asset paths; see assets. Missing manifest falls back to default paths.",
  },
  trainingPackage: {
    required: {
      date: "string YYYY-MM-DD. MUST equal the prebuilt/<date>/ folder name.",
      scenario: "string. One line: who you talk to and what they asked.",
      goal: "string. What a successful spoken answer sounds like.",
      chinese_setup: "string. Chinese instruction shown to the learner before recording.",
      frames:
        "array of { label:string, text:string, function?:string }. Reusable spoken patterns; " +
        "use [slot] placeholders the learner fills in.",
      clean_tts_text:
        "string. The exact native-speaker sentence(s) used for reference TTS. No scenario/goal text mixed in.",
    },
    optional: {
      training_type: "string e.g. 'input' | 'output' | 'repair'.",
      primary_tags: "array of short uppercase tags e.g. ['OPEN','LINK'].",
      demo_line: "string. Spoken model answer; usually equals clean_tts_text.",
      audio_text: "string. Text actually sent to TTS if it must differ from clean_tts_text.",
      stress_guide: "string. Fallback stress card — see prosodyContract.stress_guide.",
      intonation_guide: "string. Fallback contour card — see prosodyContract.intonation_guide.",
      word_level_prosody: "object. Richest prosody source — see prosodyContract.word_level_prosody.",
      notes: "array of string. Coaching reminders shown under the card.",
    },
  },
  prosodyContract: {
    precedence:
      "word_level_prosody (richest) overrides stress_guide + intonation_guide, which override the plain sentence. " +
      "Provide word_level_prosody whenever possible so the pitch/falling/stress cards render fully.",
    stress_guide: {
      purpose: "Stress card fallback when word_level_prosody is absent.",
      convention:
        "Reproduce clean_tts_text verbatim, but mark every PRIMARY-stressed word either with a leading " +
        "ˈ (U+02C8) immediately before the word, or by writing that word in ALL-CAPS. Unmarked = unstressed.",
      example: "I ˈWORK on ˈLEGAL ˈISSUES around ˈAI and ˈPLATFORMS.",
    },
    intonation_guide: {
      purpose: "Contour (pitch / falling-tone) card fallback when word_level_prosody is absent.",
      convention:
        "Split the sentence into thought groups separated by ' | '. End each group segment with one " +
        `contour glyph from ${JSON.stringify(CONTOUR_GLYPHS)} (↘ = falling/降调, ↗ = rising, → = level/continuation).`,
      example: "I work on legal issues around AI and platforms. → | More broadly ... who controls. ↘",
    },
    word_level_prosody: {
      groups: {
        type: "array of thought-group objects, in spoken order.",
        item: {
          id: "integer, 1-based, unique. Referenced by words[].group.",
          text: "string. The thought group's words, a VERBATIM contiguous substring of the full sentence.",
          function: "string e.g. 'statement' | 'list item' | 'question' | 'contrast'.",
          nucleus:
            "string. The nuclear (most prominent) token of the group. MUST appear verbatim as a token in this group's text " +
            "(trailing punctuation included, e.g. 'platforms.').",
          contour: `string, one of ${JSON.stringify(CONTOUR_GLYPHS)}. The pitch movement on the nucleus; ↘ = falling tone.`,
          pause_after: `string, one of ${JSON.stringify(PAUSE_VALUES)}. Pause weight before the next group; 'final' ends the line.`,
        },
      },
      words: {
        type:
          "SPARSE array — include ONLY genuinely prominent words: exactly one nucleus per group, " +
          "plus the few real rhythmic beats (a typical thought group has 1-3 'support' beats, NOT every " +
          "content word). Unlisted words render as plain unstressed text. Over-listing every content " +
          "word as 'support' makes the stress card uniform and useless — keep it sparse on purpose.",
        item: {
          text:
            "string. The token exactly as it appears in its group's text (case + trailing punctuation included). " +
            "The renderer matches it case-insensitively to one token in groups[group].text.",
          stress: `string, one of ${JSON.stringify(STRESS_LEVELS)}. 'nucleus' = boxed/underlined main stress; 'support' = secondary beat; 'weak' = de-emphasized.`,
          syllables:
            "string, REQUIRED for every multi-syllable word listed here (see hardRules — the renderer needs " +
            "this to draw the stress card; without it the card shows only the bare word). The word split into " +
            "syllables by '·' (U+00B7 middle dot), with EXACTLY ONE syllable — the primary-stressed one — in " +
            "ALL-CAPS and every other syllable lowercase; never respell the word; keep any trailing punctuation " +
            "on its syllable. Examples: 'accountability' -> 'ac·count·a·BIL·i·ty', 'responsibility' -> " +
            "'re·spon·si·BIL·i·ty', 'platforms.' -> 'PLAT·forms.', 'respond' -> 're·SPOND'. Omit ONLY for " +
            "genuinely monosyllabic words and initialisms (those render whole, which is correct).",
          pitch_role: "string. Free-text label e.g. 'support beat' | 'falling target' | 'level continuation'.",
          arrow: `string, '' or one of ${JSON.stringify(CONTOUR_GLYPHS)}. Normally '' except the nucleus word, which carries its group's contour.`,
          group: "integer. The id of the groups[] entry this word belongs to.",
        },
        rule:
          "Each group MUST have exactly one word with stress:'nucleus' whose text equals that group's nucleus and " +
          "whose arrow equals that group's contour. Every multi-syllable listed word MUST carry 'syllables' " +
          "with exactly one ALL-CAPS (primary-stress) syllable so the renderer can mark the stressed syllable.",
      },
    },
  },
  assets: {
    note:
      "Images are OPTIONAL. The sidebar shows them only when the file exists. Paths in manifest.json may be " +
      "relative to prebuilt/<date>/ or absolute. With no manifest the default paths below are used.",
    manifestShape: { files: "object mapping the keys below to a path string." },
    keys: {
      daily_card: "Default daily-card.png. The TODAY reading-card image (sentence + setup).",
      prosody_detail: "Default prosody-detail.png. The stress/intonation detail card image.",
      audio_demo: "Default audio/demo.ogg. Prebuilt reference audio; otherwise TTS is generated on demand.",
      audio_queue: "Default audio-queue.json. Optional TTS generation queue.",
      telegram_task_card: "Default telegram-task-card.md. Optional external task card.",
    },
  },
  followupDrillPackage: {
    purpose: "FSI substitution + shadowing rounds shown in the persistent drill workbench. Infinitely repeatable.",
    fields: {
      schema_version: "integer, currently 1.",
      date: "string YYYY-MM-DD, equals the lesson date.",
      title: "string.",
      method: "string e.g. 'FSI-style substitution + shadowing'.",
      source_principles: "array of string. Why the drill is built this way.",
      routine_zh: "array of string. Chinese step-by-step routine.",
      rounds:
        "array of { id:string, label:string, base_frame:string, slot:string, " +
        "examples:[{ cue:string, text:string }] }. Each example.text is a full sentence, never a fragment.",
      shadowing_loop: "object { chunks:[string], instruction_zh:string }. Short chunks to shadow on a delay.",
    },
  },
  hardRules: [
    "Output MUST be valid JSON. No comments, no trailing commas, no markdown inside JSON values.",
    "date MUST equal the target prebuilt/<date>/ folder name.",
    "groups[].text and frames[].text must be reproducible substrings/patterns of clean_tts_text where applicable.",
    "groups[].nucleus must be a verbatim token inside that group's text.",
    `contour and words[].arrow values must come from ${JSON.stringify(CONTOUR_GLYPHS)} (use '' for non-nucleus arrows).`,
    `pause_after must be one of ${JSON.stringify(PAUSE_VALUES)}; stress must be one of ${JSON.stringify(STRESS_LEVELS)}.`,
    "words[] is sparse: exactly ONE nucleus per group plus only the 1-3 real rhythmic beats; never tag every content word as 'support'.",
    "Every multi-syllable word listed in words[] MUST include 'syllables' with exactly one ALL-CAPS primary-stress syllable, split by '·'.",
    "Every drill example.text and shadowing chunk must be a complete, speakable sentence.",
    "Never invent file paths the generator cannot create; omit assets/manifest unless images are actually produced.",
  ],
};

export function cardSchemaContractJson(): string {
  return JSON.stringify(CARD_SCHEMA, null, 2);
}

function placeholder(hint: string): string {
  return `<<${hint}>>`;
}

/**
 * A schema-conformant but empty skeleton for english-training.json. Placeholders
 * are wrapped in << >> so they are obvious to fill and easy to grep for.
 */
export function blankTrainingPackage(date: string): JsonObject {
  return {
    date,
    training_type: placeholder("input | output | repair"),
    primary_tags: [placeholder("TAG1"), placeholder("TAG2")],
    scenario: placeholder("one line: who you talk to and what they ask"),
    goal: placeholder("what a good 30s spoken answer sounds like"),
    chinese_setup: placeholder("中文任务说明：要说什么、说多久、像什么场合"),
    frames: [
      { label: "Frame 1", text: placeholder("reusable pattern with [slot]"), function: "spoken frame" },
      { label: "Frame 2", text: placeholder("reusable pattern with [slot]"), function: "spoken frame" },
    ],
    demo_line: placeholder("full model answer sentence(s)"),
    audio_text: placeholder("text sent to TTS — usually equals clean_tts_text"),
    clean_tts_text: placeholder("the exact native sentence(s) to shadow"),
    stress_guide: placeholder("clean_tts_text with ˈ / ALL-CAPS on primary-stressed words"),
    intonation_guide: placeholder("groups separated by ' | ', each ending → ↗ or ↘"),
    word_level_prosody: {
      groups: [
        {
          id: 1,
          text: placeholder("first thought group, verbatim substring"),
          function: "statement",
          nucleus: placeholder("nucleus token from this group's text"),
          contour: "→",
          pause_after: "short",
        },
        {
          id: 2,
          text: placeholder("final thought group, verbatim substring"),
          function: "statement",
          nucleus: placeholder("nucleus token from this group's text"),
          contour: "↘",
          pause_after: "final",
        },
      ],
      words: [
        { text: placeholder("one real support beat in group 1"), stress: "support", syllables: placeholder("sup·PORT·beat"), pitch_role: "support beat", arrow: "", group: 1 },
        { text: placeholder("group 1 nucleus token"), stress: "nucleus", syllables: placeholder("NU·cle·us"), pitch_role: "level continuation", arrow: "→", group: 1 },
        { text: placeholder("one real support beat in group 2"), stress: "support", syllables: placeholder("sup·PORT·beat"), pitch_role: "support beat", arrow: "", group: 2 },
        { text: placeholder("group 2 nucleus token"), stress: "nucleus", syllables: placeholder("NU·cle·us"), pitch_role: "falling target", arrow: "↘", group: 2 },
      ],
    },
    notes: [
      placeholder("coaching reminder shown under the card"),
      "Fill every << >> placeholder, then refresh the sidebar.",
    ],
  };
}

/** A schema-conformant but empty skeleton for followup-drill.json. */
export function blankFollowupDrillPackage(date: string): JsonObject {
  return {
    schema_version: 1,
    date,
    title: `Post-practice Speaking Drill - ${date}`,
    method: "FSI-style substitution + shadowing",
    source_principles: [
      placeholder("why this drill is built this way"),
    ],
    routine_zh: [
      placeholder("中文步骤 1"),
      placeholder("中文步骤 2"),
    ],
    rounds: [
      {
        id: "A",
        label: placeholder("round label"),
        base_frame: placeholder("stable base sentence"),
        slot: placeholder("what slot gets substituted"),
        examples: [
          { cue: placeholder("cue 1"), text: placeholder("full sentence 1") },
          { cue: placeholder("cue 2"), text: placeholder("full sentence 2") },
        ],
      },
    ],
    shadowing_loop: {
      chunks: [
        placeholder("short shadow chunk 1"),
        placeholder("short shadow chunk 2"),
      ],
      instruction_zh: placeholder("跟读循环中文说明"),
    },
  };
}

export interface GenerationPromptInput {
  date: string;
  brief?: string;
  sampleTraining: JsonObject;
  sampleDrill: JsonObject;
}

/**
 * A complete, provider-agnostic prompt the learner can feed to ANY LLM. It
 * embeds the versioned contract plus one worked example so the model returns a
 * package this extension renders without further editing.
 */
export function buildGenerationPrompt(input: GenerationPromptInput): string {
  const { date, brief, sampleTraining, sampleDrill } = input;
  const learnerBrief = (brief && brief.trim()) || placeholder("describe the topic / material / situation you want to practice");
  return [
    `# Generate an English speaking-training package (Card Schema v${CARD_SCHEMA_VERSION})`,
    "",
    "You are generating one daily lesson for the **English Training** VS Code extension.",
    "The extension renders a TODAY hero card (sentence + reference audio + pitch / falling-tone / stress",
    "prosody) and an FSI drill workbench directly from your JSON. Follow the contract exactly so the",
    "cards render with no manual fixes.",
    "",
    `## Target date\n\n\`${date}\` — the \`date\` field in both files MUST equal this, and the files belong in \`prebuilt/${date}/\`.`,
    "",
    "## Learner brief",
    "",
    learnerBrief,
    "",
    "## Machine-readable contract (authoritative)",
    "",
    "```json",
    cardSchemaContractJson(),
    "```",
    "",
    "## Render-critical invariants (the cards silently break without these)",
    "",
    "The extension does not validate or repair your JSON — it renders what you send. Each rule below maps",
    "to a card that goes blank or degrades if you get it wrong. These are not style preferences:",
    "",
    "- **Stress card → `word_level_prosody.words[].syllables` is REQUIRED on every multi-syllable listed word.** " +
      "Split on `·` with EXACTLY ONE ALL-CAPS syllable (the primary stress), e.g. `ac·count·a·BIL·i·ty`, " +
      "`re·spon·si·BIL·i·ty`, `PLAT·forms.`. Omit it ONLY for true monosyllables and initialisms. Get the " +
      "stress on the linguistically correct syllable — this is a pronunciation trainer; a wrong ALL-CAPS " +
      "syllable teaches the learner the wrong word stress.",
    "- **Pitch / falling-tone card → split `word_level_prosody.groups` into the ACTUAL thought groups.** " +
      "One group per sentence/clause minimum. A single group containing the whole multi-sentence answer " +
      "collapses the rise/fall card to one flat contour. Each group's `nucleus` MUST be a verbatim token " +
      "(trailing punctuation included) inside that same group's `text`.",
    "- **Every `contour`/`arrow` value comes from the contour glyph set; the final group ends `↘` with " +
      "`pause_after:'final'`.** Mismatched or empty contours render no pitch movement.",
    "- **`words[]` stays sparse:** exactly one `nucleus` per group plus only its 1-3 real beats. Tagging " +
      "every content word `support` makes the stress card uniform and useless.",
    "",
    "## Worked example — a valid `english-training.json`",
    "",
    "```json",
    JSON.stringify(sampleTraining, null, 2),
    "```",
    "",
    "## Worked example — a valid `followup-drill.json`",
    "",
    "```json",
    JSON.stringify(sampleDrill, null, 2),
    "```",
    "",
    "## Output format — return EXACTLY these two fenced blocks and nothing else",
    "",
    "First block, labelled `english-training.json`:",
    "",
    "```json",
    "{ ... your english-training.json ... }",
    "```",
    "",
    "Then block, labelled `followup-drill.json`:",
    "",
    "```json",
    "{ ... your followup-drill.json ... }",
    "```",
    "",
    "Do not add prose before, between, or after the two JSON blocks. Obey every entry in `hardRules`.",
  ].join("\n");
}

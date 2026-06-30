# Nuova

**Italian you can actually say.**

Nuova is a sentence-based audio trainer for Italian. It is built for a B1 learner
moving toward B2/C1 conversational fluency — you hear complete, natural sentences,
repeat them, recall them, and shadow them until you can say them automatically.

The first lesson is **Lesson 001 – Talking About Uncertainty**: using `penso che`,
`credo che`, `mi sembra che`, `pare che`, `ho l'impressione che` (and `dubito che`,
`è possibile che`, `può darsi che`, `non sono sicuro che`, `mi sa che`) with the
present subjunctive.

It is a pure static web app: **no backend, no login, no build step.** It runs by
opening it in a browser and works on GitHub Pages.

---

## Run it locally

Because the app loads the lesson with `fetch()`, browsers block it on
`file://` URLs. Serve the folder over a tiny local web server instead.

From inside the `nuova/` folder:

```bash
# Python 3 (already on macOS / most Linux)
python3 -m http.server 8000
```

Then open <http://localhost:8000> in your browser.

Other one-liners if you prefer:

```bash
npx serve .        # Node
php -S localhost:8000
```

> Tip: on iPhone/iOS Safari you must **tap a button** (Start lesson, then Play)
> before any audio will play — browsers require a user gesture to start speech.

---

## Put it on GitHub + GitHub Pages

1. Create a new repository on GitHub (e.g. `nuova`).
2. Push these files to it:

   ```bash
   cd nuova
   git init
   git add .
   git commit -m "Nuova — Lesson 001"
   git branch -M main
   git remote add origin https://github.com/<your-username>/nuova.git
   git push -u origin main
   ```

3. On GitHub: **Settings → Pages**.
4. Under *Build and deployment* → *Source*, choose **Deploy from a branch**.
5. Branch: `main`, folder: `/ (root)`. Save.
6. Wait a minute, then visit `https://<your-username>.github.io/nuova/`.

All paths in the app are relative, so it works from a project subpath like this
with no changes.

---

## Add more lessons

1. Copy `data/lesson-001.json` to `data/lesson-002.json` and edit the content,
   keeping the same schema (below).
2. To make the app load a different file, change `LESSON_URL` near the top of
   `app.js`. (A lesson picker is an easy next step — every lesson follows the
   same schema, so you can `fetch()` a list and let the user choose.)

The progress for each user is stored under the localStorage key
`nuova.progress.v1`. If you add per-lesson tracking, namespace this key by
lesson id.

---

## Lesson JSON schema

`data/lesson-001.json`:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Lesson id, e.g. `"lesson-001"`. |
| `title` | string | Shown on the home screen. |
| `grammarFocus` | string | One-line grammar summary. |
| `objective` | string | What the learner will be able to do. |
| `corePatterns` | array | `{ pattern, meaning }` — the headline structures. |
| `sentences` | array | The deck the player steps through (see below). |
| `patternDrill` | array | `{ italian, literal, natural }` extra reps. |
| `activeRecall` | array | `{ prompt, answer }` English → Italian prompts. |
| `conversationBuilder` | array | `{ speaker, italian, natural }` mini dialogue. |
| `grammarExplanation` | object | `intro`, `comparison[]`, `explanation`, `commonTriggers[]`, `usefulForms[]`, `note`. |
| `masteryChecklist` | array of string | When the learner can move on. |

Each item in `sentences[]`:

```json
{
  "section": "Core Sentences",
  "italian": "Penso che sia una buona idea.",
  "literal": "I think that it be a good idea.",
  "natural": "I think it's a good idea.",
  "note": "After 'penso che', Italian often uses the subjunctive: 'sia', not 'è'."
}
```

`italian` is spoken with an Italian voice; `literal` and `natural` are spoken with
an English voice; `note` is a short on-screen grammar tip.

---

## Playback modes

The player offers five modes (selectable from the bar at the top):

1. **Full Learning** — Italian → 3s pause → Italian again → Literal English → Natural English → 5s pause.
2. **Italian Only** — Italian → 3s pause → Italian again.
3. **Active Recall** — Natural English → 5s pause → Italian.
4. **Shadowing** — Italian → 1s pause → Italian again.
5. **Driving** — moves automatically through the whole lesson, hands-free, no screen interaction.

Controls: Play/Pause, Repeat, Previous, Next, Mark difficult, Complete sentence.
Audio settings let you set Italian and English speed (Slow/Normal/Fast) and pick a
specific voice. All preferences and progress persist in `localStorage`.

---

## Audio: ElevenLabs (premium Italian) + Web Speech fallback

Italian sentences are spoken with a **premium ElevenLabs voice** using the
`eleven_multilingual_v2` model, which pronounces Italian naturally. English text
is spoken with the browser's built-in voice to conserve the ElevenLabs quota.

How it works:

- **Embedded API key.** Two ElevenLabs API keys are bundled in `app.js`
  (`ELEVEN.keys`) so the app works out of the box with no setup. These keys are
  intentionally public. The app tries them in order and uses whichever has quota.
  Because the keys ship in client-side code, treat them as disposable — to use
  your own, replace the array in `app.js`.
- **Voice selector.** Pick the Italian voice in *Audio settings → Italian voice
  (premium)*. Your choice is saved to `localStorage`. All bundled voices speak
  Italian via the multilingual model.
- **Clip caching.** Each fetched clip is cached in memory for the session
  (keyed by voice + sentence), so repeating a sentence costs nothing extra.
- **Robust fallback.** If ElevenLabs returns `401`/`429` (quota exhausted) on
  both keys, the app:
  1. switches Italian audio to the browser's Web Speech `it-IT` voice,
  2. shows a clear banner at the top of the page, and
  3. changes the on-screen audio indicator to "Browser Italian voice".

  Transient network errors are retried once before falling back; quota errors
  disable premium audio for the session.
- **Speed.** Italian Slow/Normal/Fast is applied to the premium clip via
  playback rate (so changing speed does not re-spend quota).

> **Quota note:** the ElevenLabs free tier is small. If you hear the browser
> voice and see the banner, the bundled keys are out of credits — add your own
> key in `app.js` to restore premium audio.

## Browser note: Web Speech API voices (fallback)

Audio uses the browser's built-in **`speechSynthesis`** (Web Speech API). A few
things to know:

- **Voices vary by browser and operating system.** The set of available voices,
  and their quality, depends on the device — there is no bundled audio.
- **An Italian (`it-IT`) voice may need to be installed.** If your device has no
  Italian voice, the app falls back to the default voice (English pronunciation of
  Italian text) and shows a warning in *Audio settings*. On macOS/iOS add one via
  *System Settings → Accessibility → Spoken Content → System Voice → Manage Voices*;
  on Windows via *Settings → Time & Language → Language → add Italian*.
- **iOS Safari requires a user tap before speech.** The first sound only plays
  after you tap a button. iOS is especially strict about HTML5 `Audio` (used for
  the premium ElevenLabs clips): the element must be *unlocked* inside the tap
  itself. Nuova handles this by priming a single reused `<audio>` element
  synchronously the moment you tap **Play** (before the network request runs), so
  the premium clip is allowed to play on iPhone Safari. If playback is ever
  blocked anyway, the app logs it to the console and falls back to the browser
  `it-IT` voice with the on-screen banner. The status line shows live state:
  "Fetching premium audio…" → "Playing premium Italian…".
- Voices often load **asynchronously**; Nuova listens for `voiceschanged` and
  refreshes the voice list automatically.

---

## Files

```
nuova/
├── index.html            # Home screen + lesson player markup
├── styles.css            # Mobile-first, premium styling
├── app.js                # Player logic, 5 modes, speechSynthesis, localStorage
├── data/
│   └── lesson-001.json   # Lesson content
└── README.md
```

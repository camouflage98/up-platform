# Video Studio — notes for Claude

This folder is a small video editor. **A video is one JSON file** in `projects/`.
That is the whole integration surface: write the JSON, and the human sees the
result in the editor within a couple of seconds (it polls the file and reloads
when it changes on disk).

So the division of labour is:

- **You** assemble the video — pick the media, set the timings, write the
  subtitles, choose the motion.
- **They** open the editor and nudge whatever doesn't match their intent, by
  dragging.

Both sides write the same file. Don't be precious about it: if they changed
something, read the file again before your next edit.

## Working on a project

```bash
cd video-studio
npm install                         # once — fetches a private ffmpeg
node cli.js ls                      # list projects
node cli.js info my-film            # print the timeline as text (do this after edits)
node cli.js render my-film -o exports/my-film.mp4 --quality good
node cli.js render my-film -o exports/my-film.avi          # AVI instead
node cli.js doctor                  # check ffmpeg and its filters
```

`info` is the quickest way to sanity-check your own work: it shows every
segment, gap and subtitle in order.

Media lives in `media/`. Reference it from a project as `"media/photo.jpg"` —
paths are relative to this folder. Anything ffmpeg can read works; the browser
preview additionally needs a format *it* can decode (JPEG/PNG/WebP, H.264 MP4,
WebM). A file the browser can't decode still exports correctly — the preview
just shows a placeholder.

## Project schema

Every field below is optional except where noted; `normalizeProject()` in
`lib/project.js` fills in the rest, so a sparse file is fine.

```jsonc
{
  "version": 1,
  "name": "Eleanor's story",
  "width": 1920,          // 1080x1920 for vertical, 1080x1080 for square
  "height": 1080,
  "fps": 30,
  "background": "#000000", // shows in gaps, letterbox bars and fades

  "clips": [
    {
      "id": "c1",          // any unique string
      "type": "image",     // "image" | "video" | "color"
      "src": "media/harbour.jpg",   // omit for "color"
      "name": "Harbour",   // label on the timeline; defaults to the filename
      "start": 0,          // position on the timeline, seconds
      "duration": 5,       // how long it is on screen, seconds
      "in": 0,             // video only: where to start inside the source file
      "effect": "zoomIn",  // see the list below
      "amount": 0.12,      // how far the move goes: 0.12 = 12%
      "fit": "cover",      // "cover" fills and crops, "contain" letterboxes
      "fadeIn": 0,         // seconds of fade from the background colour
      "fadeOut": 0,
      "volume": 1,         // video only
      "muted": false,      // video only
      "color": "#000000"   // "color" clips only — a plain title card
    }
  ],

  "subtitles": [
    {
      "id": "s1",
      "text": "She kept the harbour light burning\nfor forty-one years.",  // \n = line break
      "start": 0.4,
      "end": 4.2,
      "style": null        // optional per-line overrides of subtitleStyle
    }
  ],

  "audio": [
    {
      "id": "a1",
      "src": "media/music.mp3",
      "start": 0,
      "in": 0,
      "duration": 0,       // 0 = play until the video ends
      "volume": 0.35,      // keep music under a voice-over at 0.2–0.4
      "fadeIn": 1,
      "fadeOut": 2,
      "loop": false
    }
  ],

  "subtitleStyle": {
    "fontFamily": "DejaVu Sans",
    "fontSize": 52,        // in project pixels, so scale it with the canvas
    "color": "#FFFFFF",
    "outlineColor": "#000000",
    "outlineWidth": 3,
    "shadow": 1,
    "bold": true,
    "italic": false,
    "boxColor": "",        // "" = outline only; a hex turns on a box behind the text
    "boxOpacity": 0.55,
    "align": "bottom",     // "top" | "middle" | "bottom"
    "marginV": 80,         // distance from that edge
    "lineSpacing": 0
  }
}
```

### Effects

`none`, `zoomIn`, `zoomOut`, `zoomInOut`, `panLeft`, `panRight`, `panUp`,
`panDown`, `zoomInLeft`, `zoomInRight`, `zoomOutLeft`, `zoomOutRight`.

`amount` is the size of the move. `0.08`–`0.15` is the subtle range and should
be the default choice; past `0.3` it reads as a deliberate push. The pan
effects hold a constant zoom of `1 + amount` and travel across it, so a pan
with a small amount barely moves — use `0.15`–`0.25` for those.

Alternate the direction between neighbouring clips (`zoomIn`, then `zoomOut`,
then `zoomInLeft`) so a sequence doesn't feel like it's marching one way.

### Timeline rules

- Clips are placed by `start`, not by their order in the array. Gaps are filled
  with `background`. Where clips overlap, the **later one in the array** wins.
- The video ends at the last thing that finishes — a clip or a subtitle.
  Music never extends it.
- Subtitles are independent of clips: their timing is absolute, so re-timing a
  clip does not drag its caption along. Check both after moving things.

## Writing a video that reads well

- 4–6 seconds per still image. Under 3 feels rushed with a zoom on it; over 8
  goes slack unless there's narration.
- One idea per subtitle, ~2 lines, ~42 characters a line. Leave it up for at
  least 1.2s, plus about 0.25s per extra word.
- Start a subtitle ~0.2s after its clip, not on the exact frame — landing
  together looks mechanical.
- `fadeIn` on the first clip and `fadeOut` on the last (0.5–0.8s) is almost
  always worth it. Between clips, leave fades at 0 — a hard cut is cleaner.
- A title card is `type: "color"` with a subtitle over it.

## After you write a project

1. `node cli.js info <name>` — check the order, the gaps and the total length.
2. Render a draft if you want to see it yourself:
   `node cli.js render <name> --quality draft -o exports/draft.mp4`
3. Tell the human what you built and what you'd like them to check. If the
   editor is already open, they don't need to do anything — it reloads itself.

## Code layout

| file | what it does |
| --- | --- |
| `lib/effects.js` | effect definitions — one source of truth for preview *and* export |
| `lib/project.js` | schema, defaults, timeline segmentation |
| `lib/render.js` | the ffmpeg pipeline: per-segment renders → concat → subtitles + music |
| `lib/subtitles.js` | ASS/SRT generation |
| `lib/ffmpeg.js` | finding and running the binary |
| `lib/store.js` | where files live on disk |
| `server.js` | the local HTTP API |
| `public/` | the editor UI |
| `cli.js` | the scriptable side |

If you change how an effect moves, change it in `lib/effects.js` only — both
renderers read it from there, and splitting them would let preview and export
drift apart.

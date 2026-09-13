# Video Studio

A small video editor that runs on your own machine. Drop photos and clips onto
a timeline, give them a slow zoom or slide, write subtitles, export an MP4 or
an AVI.

It is built so that **Claude can assemble a video for you and you can then
adjust it by dragging** — both of you are editing the same project file, and
the editor picks up changes made underneath it within a couple of seconds.

```
┌─ Media ─┐┌──────── Preview ────────┐┌─ Properties ─┐
│ photo   ││                         ││ Effect       │
│ clip    ││      what it looks      ││ Strength     │
│ music   ││         like            ││ Fades        │
└─────────┘└─────────────────────────┘└──────────────┘
┌───────────────── Timeline ──────────────────────────┐
│ VIDEO     [ photo ][ clip ][ photo ]                │
│ SUBTITLES   [ caption ]  [ caption ]                │
│ AUDIO     [ music ─────────────────────────── ]     │
└─────────────────────────────────────────────────────┘
```

## Start it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd video-studio
npm install      # also downloads a private copy of ffmpeg, nothing global
npm start
```

Then open **http://127.0.0.1:4173**.

It listens on localhost only. Nothing is uploaded anywhere — your media, your
projects and your exports all stay in this folder.

If `npm install` can't fetch ffmpeg, install it yourself and it will be found
on your PATH:

| | |
| --- | --- |
| macOS | `brew install ffmpeg` |
| Debian/Ubuntu | `sudo apt install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg` |

Or point at an existing one: `FFMPEG_PATH=/path/to/ffmpeg npm start`.
Check what it found with `node cli.js doctor`.

## Using it

**Add media.** Drag photos, videos or music anywhere onto the window, or use
*Add files*. They're copied into `media/`.

**Build the timeline.** Drag an item from the Media list onto the **Video**
track. Drag a clip to move it, drag its ends to change how long it lasts.
Dropping several files at once lays them end to end.

**Add movement.** Click a clip and pick an Effect — a slow push in, a pull
out, or a slide across. *Strength* controls how far it travels; 10–15% is the
subtle range that looks like a considered camera move rather than an effect.
Photos get a slow zoom by default.

**Subtitles.** Put the playhead where the line should start and press
*+ Subtitle*, then type. Drag the block to move it, drag its edges to change
when it appears and disappears — or use *Start here* / *End here* to snap it
to the playhead while you listen. Font, size and colour are under *Settings →
Subtitle style*, and apply to the whole video.

**Export.** *Export video* → pick MP4 (plays everywhere) or AVI (for older
software), then *Render*. The file lands in `exports/` and you get a download
link. Use *Draft* quality while you're checking timing — it's several times
faster.

### Keyboard

| | |
| --- | --- |
| `Space` | play / pause |
| `←` `→` | one frame back / forward (`Shift` for a second) |
| `Home` `End` | jump to the start / end |
| `S` | split the clip under the playhead |
| `Delete` | delete what's selected |
| `Ctrl/⌘ Z` | undo (`Shift` to redo) |
| `Ctrl/⌘ S` | save now (it also saves by itself) |

## Working with Claude

Ask for a video and Claude writes a project file into `projects/`. If you have
the editor open, it reloads on its own and the new version is just there; if
you've made unsaved changes, it asks before replacing them.

Then adjust whatever isn't right — that's the point. Both of you can keep
editing the same project.

Claude can also render without the editor:

```bash
node cli.js info my-film                    # print the timeline as text
node cli.js render my-film --quality draft  # render it
```

`CLAUDE.md` in this folder documents the project format for it.

## Where things go

```
video-studio/
  projects/   one .json per video — plain, hand-editable
  media/      your photos, clips and music
  exports/    rendered MP4 / AVI files
```

Projects are small text files. Back them up, diff them, copy one to start a
new video from an old one.

## How it renders

Each stretch of the timeline is rendered to its own short segment, the segments
are concatenated, and a final pass burns in the subtitles and mixes the music.
The motion is `zoompan` over a 2× upscaled source, which is what keeps a slow
zoom from stepping.

The preview and the exporter share `lib/effects.js`, so the movement you scrub
through is the movement you get. Subtitles are the one approximation: the
preview draws them with the browser's text engine, while the export uses
libass, so wrapping can differ by a word. If a caption is tight, render a draft
to confirm.

## Notes and limits

- Transitions between clips are fades to the background colour, not
  cross-dissolves.
- There's one video track. Clips can overlap on it — the later one wins — but
  there's no compositing or picture-in-picture.
- AVI is written as MPEG-4 + MP3, which is what old editors and players expect.
  MP4 is H.264 + AAC.
- The preview needs a format your browser can decode. Anything else (ProRes,
  HEVC, some MOV files) shows a placeholder and still exports correctly.

/**
 * Subtitle burn-in: the project's subtitle list becomes an ASS file, which
 * libass renders into the video. ASS gives us real outlines, boxes and
 * positioning without needing a dozen chained drawtext filters.
 */

import { DEFAULT_SUBTITLE_STYLE } from './project.js';

/** '#RRGGBB' -> ASS '&HAABBGGRR' (AA is *transparency*: 00 = opaque). */
export function assColor(hex, opacity = 1) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '#000000'));
  const [r, g, b] = m ? [m[1], m[2], m[3]] : ['00', '00', '00'];
  const alpha = Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255)
    .toString(16)
    .padStart(2, '0');
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

export function assTime(seconds) {
  const t = Math.max(0, seconds || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t - h * 3600) / 60);
  const s = t - h * 3600 - m * 60;
  const cs = Math.floor((s % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

const ALIGNMENT = { bottom: 2, middle: 5, top: 8 };

function styleLine(name, style, project) {
  const s = { ...DEFAULT_SUBTITLE_STYLE, ...style };
  const boxed = !!s.boxColor;
  return [
    `Style: ${name}`,
    s.fontFamily || 'Sans',
    Math.round(s.fontSize),
    assColor(s.color, 1), // PrimaryColour
    assColor(s.color, 1), // SecondaryColour (karaoke, unused)
    assColor(s.outlineColor, 1), // OutlineColour
    boxed ? assColor(s.boxColor, s.boxOpacity) : assColor('#000000', 0.5), // BackColour / box
    s.bold ? -1 : 0,
    s.italic ? -1 : 0,
    0, // underline
    0, // strikeout
    100, // ScaleX
    100, // ScaleY
    0, // Spacing
    0, // Angle
    boxed ? 3 : 1, // BorderStyle: 3 = opaque box, 1 = outline + shadow
    boxed ? Math.max(1, Math.round(s.outlineWidth / 2)) : s.outlineWidth,
    s.shadow,
    ALIGNMENT[s.align] ?? 2,
    Math.round(project.width * 0.06), // MarginL
    Math.round(project.width * 0.06), // MarginR
    Math.round(s.marginV),
    1, // Encoding
  ].join(',');
}

function escapeText(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^ +/, (sp) => '\\h'.repeat(sp.length)))
    .join('\\N');
}

/**
 * Build the whole .ass document for a project.
 * Per-subtitle `style` overrides get their own generated style block.
 */
export function buildAss(project) {
  const base = project.subtitleStyle || DEFAULT_SUBTITLE_STYLE;
  const styles = [styleLine('Default', base, project)];
  const events = [];

  project.subtitles.forEach((sub, i) => {
    if (!String(sub.text || '').trim()) return;
    let styleName = 'Default';
    if (sub.style && Object.keys(sub.style).length) {
      styleName = `S${i}`;
      styles.push(styleLine(styleName, { ...base, ...sub.style }, project));
    }
    events.push(
      `Dialogue: 0,${assTime(sub.start)},${assTime(sub.end)},${styleName},,0,0,0,,${escapeText(sub.text)}`
    );
  });

  return [
    '[Script Info]',
    `Title: ${String(project.name || 'Untitled').replace(/[\r\n]/g, ' ')}`,
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    `PlayResX: ${project.width}`,
    `PlayResY: ${project.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

/** Also handy on its own: standard SRT, for uploading alongside the video. */
export function buildSrt(project) {
  return (
    project.subtitles
      .filter((s) => String(s.text || '').trim())
      .map((s, i) => {
        const t = (sec) => assTime(sec).replace('.', ',') + '0';
        return `${i + 1}\n${pad(t(s.start))} --> ${pad(t(s.end))}\n${String(s.text).trim()}\n`;
      })
      .join('\n') + '\n'
  );
}

// SRT wants 00:00:00,000 (two-digit hours)
const pad = (t) => (t.length === 11 ? '0' + t : t);

/** Escape a path so it survives being embedded in an ffmpeg filtergraph. */
export function escapeFilterPath(p) {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,');
}

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Compose a side-by-side demo video from the web (.webm, Playwright) and iOS
 * (.mp4, simctl) recordings via ffmpeg: each scaled to a common height with a
 * labelled header bar, hstacked, then timed captions burned in along the
 * bottom from an SRT track (subtitles filter — avoids drawtext escaping and
 * handles arbitrary text). Falls back to a label/caption-free compose if the
 * filter chain fails.
 */
const MAC_FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";
const sh = (args: string[]) => execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

function srtTimecode(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(mmm, 3)}`;
}

/** Write caption cues to an SRT file; each shows until the next cue (or +4s). */
function writeSrt(captions: { at: number; text: string }[]): string {
  const path = resolve(tmpdir(), `ethora-captions-${captions.length}-${captions[0]?.at ?? 0}.srt`);
  const lines: string[] = [];
  captions.forEach((c, i) => {
    const end = i + 1 < captions.length ? captions[i + 1]!.at - 0.15 : c.at + 4;
    lines.push(String(i + 1), `${srtTimecode(c.at)} --> ${srtTimecode(Math.max(end, c.at + 1.2))}`, c.text, "");
  });
  writeFileSync(path, lines.join("\n"));
  return path;
}

/** Single-pane captioned video (web only) — same labelled header + SRT captions. */
export function composeSinglePane(opts: {
  video: string;
  out: string;
  height?: number;
  label?: string;
  captions?: { at: number; text: string }[];
}): string {
  const h = opts.height ?? 1000;
  const label = (opts.label ?? "Web (React.js SDK)").replace(/[—–]/g, "-").replace(/['":]/g, "");
  const hasFont = existsSync(MAC_FONT);
  const header = hasFont
    ? `,drawtext=fontfile=${MAC_FONT}:text=${label}:x=(w-text_w)/2:y=22:fontsize=34:fontcolor=0x1b1340`
    : "";
  let tail = `[0:v]scale=-2:${h},setsar=1,pad=iw:ih+72:0:72:white${header}[v]`;
  if (opts.captions?.length) {
    const srt = writeSrt(opts.captions);
    const style = "FontName=Arial,FontSize=17,Bold=1,PrimaryColour=&H00FFFFFF&,BackColour=&HC0000000&,BorderStyle=4,Outline=0,Shadow=0,Alignment=2,MarginV=26";
    tail = `[0:v]scale=-2:${h},setsar=1,pad=iw:ih+72:0:72:white${header},subtitles=${srt}:force_style='${style}'[v]`;
  }
  try {
    sh(["-y", "-i", opts.video, "-filter_complex", tail, "-map", "[v]", "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", opts.out]);
  } catch {
    sh(["-y", "-i", opts.video, "-vf", `scale=-2:${h}`, "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", opts.out]);
  }
  return opts.out;
}

export function composeSideBySide(opts: {
  webVideo: string;
  iosVideo: string;
  out: string;
  height?: number;
  webLabel?: string;
  iosLabel?: string;
  captions?: { at: number; text: string }[];
}): string {
  const h = opts.height ?? 1000;
  // Plain-ASCII header labels only (no em/en-dashes or apostrophes — they break
  // drawtext escaping, and dashes are an AI tell in customer-facing output).
  const sanitize = (s: string) => s.replace(/[—–]/g, "-").replace(/['":]/g, "");
  const webLabel = sanitize(opts.webLabel ?? "Web (React.js SDK)");
  const iosLabel = sanitize(opts.iosLabel ?? "iOS (React Native SDK)");
  const hasFont = existsSync(MAC_FONT);

  const labelChain = (idx: number, label: string, tag: string) => {
    const base = `[${idx}:v]scale=-2:${h},setsar=1,pad=iw:ih+72:0:72:white`;
    if (!hasFont) return `${base}[${tag}]`;
    return `${base},drawtext=fontfile=${MAC_FONT}:text=${label}:x=(w-text_w)/2:y=22:fontsize=34:fontcolor=0x1b1340[${tag}]`;
  };

  const stack = `[w][i]hstack=inputs=2[vs]`;
  let tail = `[vs]copy[v]`;
  if (opts.captions?.length) {
    const srt = writeSrt(opts.captions);
    const style =
      "FontName=Arial,FontSize=17,Bold=1,PrimaryColour=&H00FFFFFF&," +
      "BackColour=&HC0000000&,BorderStyle=4,Outline=0,Shadow=0,Alignment=2,MarginV=26";
    tail = `[vs]subtitles=${srt}:force_style='${style}'[v]`;
  }
  const filter = `${labelChain(0, webLabel, "w")};${labelChain(1, iosLabel, "i")};${stack};${tail}`;

  const baseArgs = (fc: string) => [
    "-y", "-i", opts.webVideo, "-i", opts.iosVideo,
    "-filter_complex", fc, "-map", "[v]",
    "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", opts.out,
  ];
  try {
    sh(baseArgs(filter));
  } catch {
    // Fallback: no labels, no captions — guaranteed to produce a video.
    const plain = `[0:v]scale=-2:${h},setsar=1[w];[1:v]scale=-2:${h},setsar=1[i];[w][i]hstack=inputs=2[v]`;
    sh(baseArgs(plain));
  }
  return opts.out;
}

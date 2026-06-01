import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Compose a side-by-side demo video from the web (.webm, Playwright) and iOS
 * (.mp4, simctl) recordings via ffmpeg: each scaled to a common height with a
 * labelled header bar, then hstacked. Falls back to a label-free compose if
 * drawtext/fonts misbehave.
 */
const MAC_FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";
const sh = (args: string[]) => execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

export function composeSideBySide(opts: {
  webVideo: string;
  iosVideo: string;
  out: string;
  height?: number;
  webLabel?: string;
  iosLabel?: string;
}): string {
  const h = opts.height ?? 1000;
  // Plain-ASCII labels only — no em/en-dashes or apostrophes (they break
  // drawtext escaping inside -filter_complex, and dashes are an AI tell in
  // customer-facing content). Parentheses are safe.
  const sanitize = (s: string) => s.replace(/[—–]/g, "-").replace(/['":]/g, "");
  const webLabel = sanitize(opts.webLabel ?? "Web (React.js SDK)");
  const iosLabel = sanitize(opts.iosLabel ?? "iOS (React Native SDK)");
  const hasFont = existsSync(MAC_FONT);

  // Each input: scale to height h (even width), add a 72px white header bar,
  // draw the label centered in it. hstack requires equal heights → both h+72.
  const labelChain = (idx: number, label: string, tag: string) => {
    const base = `[${idx}:v]scale=-2:${h},setsar=1,pad=iw:ih+72:0:72:white`;
    if (!hasFont) return `${base}[${tag}]`;
    return `${base},drawtext=fontfile=${MAC_FONT}:text=${label}:x=(w-text_w)/2:y=22:fontsize=34:fontcolor=0x1b1340[${tag}]`;
  };

  const filter =
    `${labelChain(0, webLabel, "w")};` +
    `${labelChain(1, iosLabel, "i")};` +
    `[w][i]hstack=inputs=2[v]`;

  const args = [
    "-y",
    "-i", opts.webVideo,
    "-i", opts.iosVideo,
    "-filter_complex", filter,
    "-map", "[v]",
    "-r", "30",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", "medium",
    opts.out,
  ];
  try {
    sh(args);
  } catch (e) {
    // Retry without labels in case of font/drawtext issues.
    const plain =
      `[0:v]scale=-2:${h},setsar=1[w];[1:v]scale=-2:${h},setsar=1[i];[w][i]hstack=inputs=2[v]`;
    sh([
      "-y", "-i", opts.webVideo, "-i", opts.iosVideo,
      "-filter_complex", plain, "-map", "[v]",
      "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", opts.out,
    ]);
  }
  return opts.out;
}

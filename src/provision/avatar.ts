/**
 * Dependency-free themed avatar generator.
 *
 * Produces a small SVG of the cast member's initials on a deterministic
 * coloured disc with a subtle crescent-moon motif (fitting the forest-at-night
 * scenario). SVG keeps us binary-asset-free and text rendering trivial; the
 * chat components render `photoURL` in an <img>, which displays SVG fine.
 *
 * Avatars are a polish layer, never a hard dependency — if upload fails the
 * clients fall back to their built-in initials avatar.
 */

function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

function initials(firstName: string, lastName: string): string {
  const a = firstName.trim()[0] || "?";
  const b = lastName.replace(/[^a-zA-Z]/g, "").trim()[0] || "";
  return (a + b).toUpperCase();
}

export function avatarSvg(opts: {
  firstName: string;
  lastName: string;
  seed: string;
  color?: string;
}): string {
  const hue = hashHue(opts.seed);
  const bg = opts.color || `hsl(${hue} 45% 32%)`;
  const accent = `hsl(${(hue + 40) % 360} 70% 78%)`;
  const text = initials(opts.firstName, opts.lastName);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="36" fill="${bg}"/>
  <circle cx="196" cy="64" r="34" fill="${accent}" opacity="0.85"/>
  <circle cx="210" cy="58" r="30" fill="${bg}"/>
  <text x="128" y="150" font-family="Georgia, 'Times New Roman', serif" font-size="104" font-weight="600" fill="#fdfaf3" text-anchor="middle">${text}</text>
</svg>`;
}

export interface AvatarOpts {
  firstName: string;
  lastName: string;
  seed: string;
  color?: string;
}

/**
 * Rasterize the themed avatar SVG to PNG via a headless Chromium page.
 *
 * Why PNG and not SVG: the QA file server serves every upload as
 * `application/octet-stream` with `X-Content-Type-Options: nosniff`. Browsers
 * refuse to render SVG-as-octet-stream in <img> (SVG can carry script), so SVG
 * avatars fall back to initials. Raster images still render in <img> under the
 * same headers, so we ship PNG. Playwright gives us real text rendering for
 * free, avoiding a hand-rolled glyph rasterizer.
 *
 * One browser is reused across the whole cast (cheap), so callers should
 * create one rasterizer, render all avatars, then close().
 */
export class AvatarRasterizer {
  private browser: import("playwright").Browser | null = null;
  private page: import("playwright").Page | null = null;

  async init(): Promise<void> {
    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({ headless: true });
    const ctx = await this.browser.newContext({ deviceScaleFactor: 1 });
    this.page = await ctx.newPage();
    await this.page.setViewportSize({ width: 256, height: 256 });
  }

  async toPng(opts: AvatarOpts): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    if (!this.page) throw new Error("AvatarRasterizer not initialized");
    const svg = avatarSvg(opts);
    await this.page.setContent(
      `<!doctype html><html><body style="margin:0;padding:0">${svg}</body></html>`,
      { waitUntil: "load" }
    );
    const buffer = await this.page.locator("svg").screenshot({ type: "png" });
    return { buffer, filename: `${opts.seed.toLowerCase()}.png`, contentType: "image/png" };
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.page = null;
  }
}

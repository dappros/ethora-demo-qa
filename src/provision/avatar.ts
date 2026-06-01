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

export function avatarBuffer(opts: {
  firstName: string;
  lastName: string;
  seed: string;
  color?: string;
}): { buffer: Buffer; filename: string; contentType: string } {
  return {
    buffer: Buffer.from(avatarSvg(opts), "utf8"),
    filename: `${opts.seed.toLowerCase()}.svg`,
    contentType: "image/svg+xml",
  };
}

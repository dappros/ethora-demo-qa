/**
 * Scenario model. A scenario is a self-contained "world" definition plus a
 * scripted conversation. The provisioner turns the cast + room into live
 * server state; the runners replay the beats across the web and iOS surfaces
 * and capture screenshots.
 *
 * Scenarios are pure data so non-engineers can add new themed casts (a new
 * play, a product story, an enterprise vertical) without touching the engine.
 */

export type Surface = "web" | "ios";

export interface CastMember {
  /** Stable handle, used for emails + JIDs. Lowercase, no spaces. */
  handle: string;
  firstName: string;
  lastName: string;
  /** One-line character note — shown nowhere critical, but nice in logs. */
  role: string;
  /**
   * Avatar generation seed. The provisioner renders a themed SVG avatar from
   * this (initials + deterministic colour) so no external image service or
   * binary assets are needed.
   */
  avatarSeed: string;
  /** Optional explicit hex background for the avatar. */
  avatarColor?: string;
}

/**
 * A single step in the scripted conversation. The optional `caption` on action
 * beats is a short, viewer-facing line ("Web sends a message; it appears on
 * iOS") burned into the side-by-side video at the moment the beat runs.
 */
export type Beat =
  | { kind: "message"; actor: string; text: string; caption?: string; note?: string }
  | { kind: "media"; actor: string; asset: string; caption?: string; note?: string }
  | { kind: "typing"; actor: string; ms?: number; caption?: string; note?: string }
  | { kind: "edit"; actor: string; targetText: string; newText: string; caption?: string; note?: string }
  | { kind: "delete"; actor: string; targetText: string; caption?: string; note?: string }
  | { kind: "history"; actor: string; caption?: string; note?: string }
  // --- advanced / rich features ---
  // React to a message with an emoji (reaction id: heart, joy, fire, +1, smile, scream).
  | { kind: "reaction"; actor: string; targetText: string; emoji: string; caption?: string; note?: string }
  // Threaded reply to a specific message.
  | { kind: "reply"; actor: string; targetText: string; text: string; caption?: string; note?: string }
  // Voice note (audio media), injected over XMPP with a waveform.
  | { kind: "voice"; actor: string; seconds?: number; caption?: string; note?: string }
  // --- resilience ---
  // Drop the web client's network for `offlineMs`, then restore; messages
  // injected during the outage backfill on reconnect.
  | { kind: "reconnect"; offlineMs?: number; duringOffline?: { actor: string; text: string }[]; caption?: string; note?: string }
  // Switch the web client to another room and back, exercising per-room state.
  | { kind: "switchRoom"; caption?: string; note?: string }
  | { kind: "screenshot"; surface: Surface | "both"; label: string; note?: string }
  | { kind: "wait"; ms: number; note?: string };

export interface Scenario {
  id: string;
  title: string;
  theme: string;
  /** Room title for the group chat. */
  roomTitle: string;
  /** Optional second room title — provisions a second room for switchRoom. */
  secondRoomTitle?: string;
  /** Backstory for the second room (so it isn't empty when switched to). */
  secondRoomHistory?: { actor: string; text: string }[];
  /** DiceBear avatar style (https://dicebear.com). Default "adventurer". */
  avatarStyle?: string;
  cast: CastMember[];
  /**
   * Which cast handle is driven live on each surface. Everyone else is a
   * "seeded" participant whose lines are injected over XMPP (history + during
   * the run) so the two hero clients have something to talk to.
   */
  heroes: Record<Surface, string>;
  /** Backstory messages injected before the live run, for scrollback. */
  history: { actor: string; text: string }[];
  /** The live, screenshot-captured script. */
  script: Beat[];
}

export function castByHandle(s: Scenario, handle: string): CastMember {
  const m = s.cast.find((c) => c.handle === handle);
  if (!m) throw new Error(`Scenario ${s.id}: unknown cast handle "${handle}"`);
  return m;
}

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { HarnessConfig } from "../config.js";
import type { Scenario } from "../scenarios/types.js";
import { EthoraApi } from "../provision/ethora-api.js";
import type { World } from "../provision/state.js";
import { HarnessXmpp, type XmppIdentity } from "../xmpp/client.js";
import { moonlitForestPng } from "../media/png.js";

const WEB_PORT = 5173;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`  [web] ${m}`);

async function portUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Start the chat-component Vite dev server unless one is already running. */
async function ensureDevServer(cfg: HarnessConfig): Promise<{ proc?: ChildProcess }> {
  if (await portUp(WEB_PORT)) {
    log(`dev server already running on :${WEB_PORT}`);
    return {};
  }
  log(`starting dev server (npm run dev) in ${cfg.paths.webComponent}`);
  const proc = spawn("npm", ["run", "dev"], {
    cwd: cfg.paths.webComponent,
    stdio: "ignore",
    detached: false,
    env: { ...process.env, BROWSER: "none" },
  });
  for (let i = 0; i < 60; i++) {
    if (await portUp(WEB_PORT)) {
      log(`dev server up on :${WEB_PORT}`);
      return { proc };
    }
    await sleep(1000);
  }
  proc.kill();
  throw new Error("dev server did not come up on :5173 within 60s");
}

/** Build the IConfig override injected into the sandbox for the web hero. */
async function buildOverride(cfg: HarnessConfig, world: World, heroHandle: string) {
  const api = new EthoraApi(cfg.server.apiUrl);
  const rec = world.users[heroHandle];
  if (!rec) throw new Error(`web hero "${heroHandle}" not provisioned`);
  const login = await api.login(world.app.token, rec.email, rec.password);
  const user = {
    ...login.user,
    token: login.token,
    refreshToken: login.refreshToken,
    walletAddress: (login.user as any)?.defaultWallet?.walletAddress,
  };
  return {
    appId: world.app.id,
    baseUrl: cfg.server.apiUrl,
    xmppSettings: {
      devServer: cfg.server.xmppWebSocket,
      host: cfg.server.xmppHost,
      conference: cfg.server.xmppConference,
      xmppPingOnSendEnabled: true,
    },
    userLogin: { enabled: true, user },
    refreshTokens: { enabled: true },
    disableMedia: false,
    setRoomJidInPath: true,
    roomJID: world.room!.jid,
  };
}

/** XMPP injector for actors not driven by a live UI (counterparties + fairies). */
class Injector {
  private conns = new Map<string, HarnessXmpp>();
  constructor(
    private cfg: HarnessConfig,
    private idents: Record<string, { identity: XmppIdentity }>,
    private roomJid: string
  ) {}
  private async conn(handle: string): Promise<HarnessXmpp> {
    let c = this.conns.get(handle);
    // Recreate if missing or the stream dropped (idle close / teardown) — a
    // stale connection would otherwise fail the send silently.
    if (c && !c.online) {
      await c.disconnect();
      c = undefined;
      this.conns.delete(handle);
    }
    if (!c) {
      const id = this.idents[handle];
      if (!id) throw new Error(`injector: no identity for ${handle}`);
      c = new HarnessXmpp({ service: this.cfg.server.xmppWebSocket, conference: this.cfg.server.xmppConference, identity: id.identity });
      await c.connect();
      await c.joinAndSubscribe(this.roomJid);
      this.conns.set(handle, c);
    }
    return c;
  }
  async sendAs(handle: string, text: string): Promise<void> {
    await (await this.conn(handle)).sendText(this.roomJid, text);
  }
  async sendMediaAs(handle: string, media: { location: string; mimetype: string; fileName: string; duration?: number }): Promise<void> {
    await (await this.conn(handle)).sendMedia(this.roomJid, media);
  }
  /** Target room for sends (lets callers redirect, e.g. after switchRoom). */
  setRoom(jid: string): void {
    this.roomJid = jid;
  }
  async close(): Promise<void> {
    for (const c of this.conns.values()) await c.disconnect();
  }
}

export interface WebRunResult {
  screenshots: string[];
  videoDir: string;
  /** Caption cues for the side-by-side video, in seconds from video start. */
  captions: { at: number; text: string }[];
}

/**
 * Run a scenario with the web component as the live hero surface. Non-web
 * actors are injected over XMPP, so this is a complete self-contained demo
 * even without the mobile simulator. The orchestrator (full run) reuses the
 * same page driver but lets the iOS app play its hero instead of the injector.
 */
export async function runWeb(
  cfg: HarnessConfig,
  scenario: Scenario,
  world: World,
  liveIdents: Record<string, { identity: XmppIdentity }>,
  runId: string,
  opts: { headless?: boolean; injectIosHero?: boolean } = {}
): Promise<WebRunResult> {
  if (!world.room) throw new Error("no room in world — run `npm run reset` first");
  const outDir = resolve(cfg.paths.artifacts, runId, "web");
  mkdirSync(outDir, { recursive: true });

  // Ensure the media asset exists.
  const mediaPath = resolve(cfg.paths.assets, "media", "moonlit-forest.png");
  if (!existsSync(mediaPath)) {
    mkdirSync(resolve(cfg.paths.assets, "media"), { recursive: true });
    writeFileSync(mediaPath, moonlitForestPng());
    log("generated media asset: moonlit-forest.png");
  }
  // Voice-note audio as a base64 data: URI (QA file server 500s on audio
  // uploads, so we embed it in the message; the component plays it directly).
  const voiceUri = prepareVoiceDataUri(cfg.paths.assets);

  const heroWeb = scenario.heroes.web;
  const heroIos = scenario.heroes.ios;
  const override = await buildOverride(cfg, world, heroWeb);
  const injector = new Injector(cfg, liveIdents, world.room.jid);

  const server = await ensureDevServer(cfg);
  let browser: Browser | undefined;
  let ctx: BrowserContext | undefined;
  const screenshots: string[] = [];
  try {
    browser = await chromium.launch({ headless: opts.headless !== false });
    ctx = await browser.newContext({
      viewport: { width: 480, height: 880 },
      recordVideo: { dir: outDir, size: { width: 480, height: 880 } },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    const videoStartMs = Date.now(); // video recording begins ~here
    const captions: { at: number; text: string }[] = [];
    await page.addInitScript((c) => {
      (window as unknown as Record<string, unknown>).__ETHORA_DEMO_CONFIG__ = c;
    }, override);
    await page.goto(`http://localhost:${WEB_PORT}/chat`);

    // Wait for the room list, then explicitly open our room (don't rely solely
    // on roomJID auto-open, which can race the room-list load).
    const roomLocal = world.room.jid.split("@")[0]!;
    const roomRow = page.locator(`[data-roomjid="${world.room.jid}"], [data-testid="room_row_${roomLocal}"]`).first();
    try {
      await roomRow.waitFor({ state: "visible", timeout: 60000 });
      await roomRow.click();
    } catch {
      log("room row not found in list; relying on roomJID auto-open");
    }
    try {
      await page.getByTestId("chat_input").first().waitFor({ state: "visible", timeout: 30000 });
    } catch (e) {
      await page.screenshot({ path: resolve(outDir, "_open-failure.png") });
      throw e;
    }
    await sleep(2500); // let history settle
    log("web hero logged in, room open");

    const shot = async (label: string) => {
      const p = resolve(outDir, `${label}.png`);
      await page.screenshot({ path: p });
      screenshots.push(p);
      log(`screenshot ${label}`);
    };

    const isWebActor = (actor: string) => actor === heroWeb;
    const isInjected = (actor: string) =>
      actor !== heroWeb && (opts.injectIosHero || actor !== heroIos);

    // A short settle after each message so the viewer can connect a message
    // sent on the left (web) with it appearing on the right (iOS).
    const SETTLE = 1700;

    for (const beat of scenario.script) {
      try {
        // Record the caption cue at the moment the beat starts.
        const cap = (beat as { caption?: string }).caption;
        if (cap) captions.push({ at: (Date.now() - videoStartMs) / 1000, text: cap });

        switch (beat.kind) {
          case "message": {
            if (isWebActor(beat.actor)) {
              const input = page.getByTestId("chat_input").first();
              await input.click();
              await input.fill(beat.text);
              await page.getByTestId("chat_send_button").first().click();
              await sleep(900 + SETTLE);
            } else if (isInjected(beat.actor)) {
              await injector.sendAs(beat.actor, beat.text);
              await sleep(900 + SETTLE);
            }
            break;
          }
          case "media": {
            if (isWebActor(beat.actor)) {
              const [chooser] = await Promise.all([
                page.waitForEvent("filechooser", { timeout: 8000 }),
                page.getByTestId("chat_attach_button").first().click(),
              ]);
              await chooser.setFiles(mediaPath);
              await sleep(1200);
              await page.getByTestId("chat_send_button").first().click().catch(() => {});
              await sleep(2500 + SETTLE);
            }
            break;
          }
          case "typing": {
            if (isWebActor(beat.actor)) {
              const input = page.getByTestId("chat_input").first();
              await input.click();
              await input.type("...", { delay: 150 });
              await sleep(beat.ms ?? 2000);
              await input.fill("");
            } else {
              await sleep(beat.ms ?? 1500);
            }
            break;
          }
          case "edit": {
            if (isWebActor(beat.actor)) {
              await editWebMessage(page, beat.targetText, beat.newText).catch((e) =>
                log(`edit best-effort failed: ${String(e).slice(0, 80)}`)
              );
              await sleep(800);
            }
            break;
          }
          case "delete": {
            if (isWebActor(beat.actor)) {
              await deleteWebMessage(page, beat.targetText).catch((e) =>
                log(`delete best-effort failed: ${String(e).slice(0, 80)}`)
              );
              await sleep(800);
            }
            break;
          }
          case "history": {
            await scrollHistory(page).catch(() => {});
            await sleep(1500);
            break;
          }
          case "reaction": {
            if (isWebActor(beat.actor)) {
              await reactWebMessage(page, beat.targetText, beat.emoji).catch((e) =>
                log(`reaction best-effort failed: ${String(e).slice(0, 80)}`)
              );
              await sleep(SETTLE);
            }
            break;
          }
          case "reply": {
            if (isWebActor(beat.actor)) {
              await replyWebMessage(page, beat.targetText, beat.text).catch((e) =>
                log(`reply best-effort failed: ${String(e).slice(0, 80)}`)
              );
              await sleep(SETTLE);
            }
            break;
          }
          case "voice": {
            // Injected over XMPP for any actor (incl. the web hero's own
            // identity) since it can't be recorded through the headless UI.
            if (voiceUri) {
              await injector.sendMediaAs(beat.actor, {
                location: voiceUri, mimetype: "audio/mpeg", fileName: "voice-note.mp3", duration: beat.seconds ?? 4,
              });
            } else {
              log("voice skipped — no audio asset");
            }
            await sleep(SETTLE);
            break;
          }
          case "reconnect": {
            await page.context().setOffline(true);
            log(`network OFFLINE (${beat.offlineMs ?? 4000}ms)`);
            // Messages sent by others while we are offline backfill on reconnect.
            for (const m of beat.duringOffline ?? []) {
              await injector.sendAs(m.actor, m.text);
            }
            await sleep(beat.offlineMs ?? 4000);
            await page.context().setOffline(false);
            log("network ONLINE — awaiting reconnect + backfill");
            await sleep(6000);
            break;
          }
          case "switchRoom": {
            if (world.room2) {
              const open = async (jid: string) =>
                page.locator(`[data-roomjid="${jid}"], [data-testid="room_row_${jid.split("@")[0]}"]`).first().click({ timeout: 8000 });
              const backToList = async () => page.getByTestId("chat_back_button").first().click({ timeout: 5000 }).catch(() => {});
              // Single-pane (phone) layout: back arrow → room list → open the other room → back → open the original.
              await backToList(); await sleep(1200);
              await open(world.room2.jid); await sleep(2500);
              await backToList(); await sleep(1200);
              await open(world.room!.jid); await sleep(2500);
            } else {
              log("switchRoom skipped — no second room provisioned");
            }
            break;
          }
          case "wait":
            await sleep(beat.ms);
            break;
          case "screenshot":
            if (beat.surface === "web" || beat.surface === "both") await shot(beat.label);
            break;
        }
      } catch (e) {
        log(`beat ${beat.kind} error: ${String((e as Error).message).slice(0, 100)}`);
      }
    }

    await sleep(1500);
    return { screenshots, videoDir: outDir, captions };
  } finally {
    await injector.close();
    await ctx?.close(); // flushes video
    await browser?.close();
    server.proc?.kill();
  }
}

// --- Best-effort message interactions (UI menus vary; never fail the run) ---

/**
 * Open the per-message context menu and wait until `item` is visible. Edit/
 * Delete only render on the hero's own messages (isUser), so target
 * `data-is-user="true"` bubbles. The menu is a right-click (onContextMenu);
 * retry it a few times since the first right-click can land before the bubble
 * is hit-testable or get swallowed by a closing overlay.
 */
async function openMessageMenu(page: Page, text: string, item: string, ownOnly = true) {
  const sel = ownOnly
    ? `[data-testid="chat_message"][data-is-user="true"]`
    : `[data-testid="chat_message"]`;
  const bubble = page.locator(sel, { hasText: text }).first();
  await bubble.scrollIntoViewIfNeeded();
  // Right-click the text element (inside the bubble), not the container: own
  // messages are right-aligned, so the full-width container's centre can fall
  // in the empty gutter and miss the bubble's onContextMenu handler.
  const target = bubble.getByText(text).first();
  for (let attempt = 0; attempt < 4; attempt++) {
    await target.click({ button: "right" });
    try {
      await page.getByTestId(item).waitFor({ state: "visible", timeout: 1500 });
      return;
    } catch {
      await sleep(400);
    }
  }
  throw new Error(`context menu item "${item}" never appeared for "${text}"`);
}

/** React to any message with an emoji (reaction id: heart, joy, fire, +1, smile, scream). */
async function reactWebMessage(page: Page, target: string, emojiId: string) {
  await openMessageMenu(page, target, `reaction_${emojiId}`, false);
  await page.getByTestId(`reaction_${emojiId}`).click();
}

/** Threaded reply to any message. */
async function replyWebMessage(page: Page, target: string, text: string) {
  await openMessageMenu(page, target, "msg_reply", false);
  await page.getByTestId("msg_reply").click();
  const input = page.getByTestId("chat_input").first();
  await input.click();
  await input.fill(text);
  await page.getByTestId("chat_send_button").first().click();
}

/**
 * Prepare a voice-note audio asset as a base64 data: URI. Generates a short
 * MP3 via ffmpeg if missing. Returns "" if ffmpeg is unavailable.
 */
let _voiceUri: string | null = null;
function prepareVoiceDataUri(assetsDir: string): string {
  if (_voiceUri !== null) return _voiceUri;
  const mp3 = resolve(assetsDir, "media", "voice-note.mp3");
  try {
    if (!existsSync(mp3)) {
      execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=320:duration=4", "-b:a", "48k", mp3], { stdio: "ignore" });
    }
    const b64 = readFileSync(mp3).toString("base64");
    _voiceUri = `data:audio/mpeg;base64,${b64}`;
  } catch {
    _voiceUri = "";
  }
  return _voiceUri;
}

async function editWebMessage(page: Page, target: string, next: string) {
  await openMessageMenu(page, target, "msg_edit");
  await page.getByTestId("msg_edit").click();
  // Edit mode loads the original text into the compose input; replace it.
  const input = page.getByTestId("chat_input").first();
  await input.click();
  await input.fill(next);
  await page.getByTestId("chat_send_button").first().click();
}

async function deleteWebMessage(page: Page, target: string) {
  await openMessageMenu(page, target, "msg_delete");
  await page.getByTestId("msg_delete").click();
  // Delete opens a confirmation modal; confirm it.
  await page.getByTestId("modal_confirm_button").click({ timeout: 4000 });
}

async function scrollHistory(page: Page) {
  // Scroll the message list to the top to trigger older-history load.
  const msg = page.getByTestId("chat_message").first();
  await msg.scrollIntoViewIfNeeded();
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -600);
    await sleep(300);
  }
}

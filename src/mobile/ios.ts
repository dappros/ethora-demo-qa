import { execFileSync, execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { HarnessConfig } from "../config.js";
import type { Scenario } from "../scenarios/types.js";
import { EthoraApi } from "../provision/ethora-api.js";
import type { World } from "../provision/state.js";

const BUNDLE_ID = "com.ethora.chatcomponentrn";
const CREDS_KEY = "@apploginchatsrn/creds"; // the demo app's AsyncStorage key
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`  [ios] ${m}`);

/**
 * Seed the demo app's AsyncStorage directly so it auto-connects on launch.
 *
 * This is the reliable injection path: it bypasses Metro entirely (the
 * JSON-import hook is defeated by Metro's transform cache on a live dev
 * server). RCTAsyncLocalStorage stores large values in a file named by the
 * lowercase-hex MD5 of the key, with manifest.json mapping the key -> null.
 */
function seedAsyncStorage(udid: string, credsJson: string): void {
  const data = execSync(`xcrun simctl get_app_container ${udid} ${BUNDLE_ID} data`).toString().trim();
  const dir = join(data, "Library", "Application Support", BUNDLE_ID, "RCTAsyncLocalStorage_V1");
  mkdirSync(dir, { recursive: true });
  const md5 = createHash("md5").update(CREDS_KEY).digest("hex");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ [CREDS_KEY]: null }));
  writeFileSync(join(dir, md5), credsJson);
  log(`seeded AsyncStorage creds (${dir.split("/Application Support/")[1]})`);
}

/** Resolve the booted simulator UDID matching the configured device name. */
export function resolveUdid(deviceName: string): string {
  const out = execSync(`xcrun simctl list devices booted`).toString();
  const line = out.split("\n").find((l) => l.includes(deviceName) && l.includes("Booted"));
  const m = line?.match(/\(([0-9A-F-]{36})\)/);
  if (!m) throw new Error(`No booted simulator named "${deviceName}". Boot it first: xcrun simctl boot "${deviceName}"`);
  return m[1]!;
}

/** Build the demo app's Creds object for the iOS hero (logs in fresh). */
export async function buildIosCreds(cfg: HarnessConfig, world: World, heroHandle: string): Promise<Record<string, unknown>> {
  if (!world.room) throw new Error("no room in world");
  const api = new EthoraApi(cfg.server.apiUrl);
  const rec = world.users[heroHandle];
  if (!rec) throw new Error(`iOS hero "${heroHandle}" not provisioned`);
  const login = await api.login(world.app.token, rec.email, rec.password);
  const lu: any = login.user;
  return {
    mode: "email",
    jwt: "",
    appToken: world.app.token,
    email: rec.email,
    password: rec.password,
    resolvedUser: {
      _id: lu._id,
      firstName: lu.firstName,
      lastName: lu.lastName,
      email: lu.email,
      token: login.token,
      refreshToken: login.refreshToken,
      xmppUsername: lu.xmppUsername,
      xmppPassword: lu.xmppPassword,
      walletAddress: lu.defaultWallet?.walletAddress,
      defaultWallet: lu.defaultWallet,
      profileImage: lu.profileImage,
    },
    baseUrl: cfg.server.apiUrl,
    xmppHost: cfg.server.xmppHost,
    // The RN demo app builds the WS URL as `wss://${xmppDevServer}/ws`, so this
    // field is the bare host (NOT the full wss:// URL the web component takes).
    xmppDevServer: cfg.server.xmppHost,
    conference: cfg.server.xmppConference,
    singleRoom: true,
    singleRoomJid: world.room.jid,
  };
}

export class IosDriver {
  readonly udid: string;
  private outDir: string;
  constructor(cfg: HarnessConfig, runId: string) {
    this.udid = resolveUdid(cfg.iosSimulator);
    this.outDir = resolve(cfg.paths.artifacts, runId, "ios");
    mkdirSync(this.outDir, { recursive: true });
  }

  /**
   * Force the expo-dev-client to drop its cached JS bundle and re-fetch the
   * current one from Metro. `simctl launch` reuses the cached bundle, so JS
   * edits (and our SDK fixes) wouldn't take. Maestro `clearState` wipes app
   * data — including the cached bundle — and the subsequent cold start
   * re-fetches from Metro. Storage is wiped too, so seed creds AFTER this.
   */
  private refreshBundle(): void {
    const flow = [`appId: ${BUNDLE_ID}`, `---`, `- stopApp`, `- launchApp:`, `    clearState: true`, ``].join("\n");
    const flowPath = resolve(tmpdir(), `ethora-ios-refresh-${Date.now()}.yaml`);
    writeFileSync(flowPath, flow);
    try {
      execSync(`maestro --device ${this.udid} test ${flowPath}`, { stdio: "ignore", timeout: 90000 });
      log("cleared app state -> fresh bundle fetch");
    } catch (e) {
      log(`bundle refresh (clearState) failed: ${String((e as Error).message).slice(0, 80)}`);
    } finally {
      rmSync(flowPath, { force: true });
    }
  }

  /** Refresh bundle, seed AsyncStorage with the given creds, then cold-launch. */
  async launchWithCreds(credsJson: string): Promise<void> {
    if (process.env.SKIP_BUNDLE_REFRESH !== "1") this.refreshBundle(); // wipes cached bundle + storage, re-fetches JS
    await sleep(12000);             // let the fresh bundle load + cache
    try { execFileSync("xcrun", ["simctl", "terminate", this.udid, BUNDLE_ID], { stdio: "ignore" }); } catch { /* not running */ }
    await sleep(1500);
    seedAsyncStorage(this.udid, credsJson);
    execFileSync("xcrun", ["simctl", "launch", this.udid, BUNDLE_ID], { stdio: "ignore" });
    log("app launched with seeded creds (fresh bundle)");
  }

  private recProc: ChildProcess | null = null;

  /** Start recording the simulator screen to an mp4 (runs until stopRecording). */
  startRecording(): string {
    const file = resolve(this.outDir, "ios.mp4");
    rmSync(file, { force: true });
    this.recProc = spawn(
      "xcrun",
      ["simctl", "io", this.udid, "recordVideo", "--codec", "h264", "--force", file],
      { stdio: "ignore" }
    );
    log("recording simulator -> ios.mp4");
    return file;
  }

  /** Stop recording — SIGINT lets simctl finalize the mp4 cleanly. */
  async stopRecording(): Promise<void> {
    if (!this.recProc) return;
    const proc = this.recProc;
    this.recProc = null;
    await new Promise<void>((res) => {
      proc.on("close", () => res());
      proc.kill("SIGINT");
      setTimeout(res, 5000); // safety net
    });
    log("simulator recording finalized");
  }

  async screenshot(label: string): Promise<string> {
    const p = resolve(this.outDir, `${label}.png`);
    execFileSync("xcrun", ["simctl", "io", this.udid, "screenshot", p], { stdio: "ignore" });
    log(`screenshot ${label}`);
    return p;
  }

  /** Drive a text send via Maestro using the SDK's wired testIDs. */
  async sendText(text: string): Promise<void> {
    const flow = [
      `appId: ${BUNDLE_ID}`,
      `---`,
      `- tapOn:`,
      `    id: "chat-message-input"`,
      `- inputText: ${JSON.stringify(text)}`,
      `- tapOn:`,
      `    id: "chat-send-button"`,
      ``,
    ].join("\n");
    const flowPath = resolve(tmpdir(), `ethora-ios-send-${Date.now()}.yaml`);
    writeFileSync(flowPath, flow);
    try {
      execSync(`maestro --device ${this.udid} test ${flowPath}`, { stdio: "ignore", timeout: 60000 });
      log(`sent: ${text.slice(0, 40)}`);
    } catch (e) {
      log(`send via Maestro failed (continuing): ${String((e as Error).message).slice(0, 80)}`);
    } finally {
      rmSync(flowPath, { force: true });
    }
  }
}

/** Standalone iOS run: auto-connect the hero, screenshot the rendered room. */
export async function runIos(cfg: HarnessConfig, scenario: Scenario, world: World, runId: string): Promise<{ screenshots: string[] }> {
  const creds = await buildIosCreds(cfg, world, scenario.heroes.ios);
  const drv = new IosDriver(cfg, runId);
  await drv.launchWithCreds(JSON.stringify(creds));
  await sleep(12000); // allow JS boot + XMPP connect + room open
  const screenshots: string[] = [];
  screenshots.push(await drv.screenshot("ios-00-room-open"));
  // Drive the iOS hero's scripted lines.
  for (const beat of scenario.script) {
    if (beat.kind === "message" && beat.actor === scenario.heroes.ios) {
      await drv.sendText(beat.text);
      await sleep(1500);
      screenshots.push(await drv.screenshot(`ios-sent-${screenshots.length}`));
    }
  }
  return { screenshots };
}

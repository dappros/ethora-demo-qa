import type { HarnessConfig } from "../config.js";
import type { Scenario } from "../scenarios/types.js";
import { EthoraApi } from "./ethora-api.js";
import { HarnessXmpp, type XmppIdentity } from "../xmpp/client.js";
import { saveWorld, type World } from "./state.js";

const log = (m: string) => console.log(`  ${m}`);

export interface LiveUser {
  handle: string;
  token: string;
  identity: XmppIdentity;
  xmpp?: HarnessXmpp;
}

/** Log in every cast member and return their fresh tokens + XMPP identities. */
export async function loginCast(
  cfg: HarnessConfig,
  world: World
): Promise<Record<string, LiveUser>> {
  const api = new EthoraApi(cfg.server.apiUrl);
  const out: Record<string, LiveUser> = {};
  for (const [handle, u] of Object.entries(world.users)) {
    const login = await api.login(world.app.token, u.email, u.password);
    const lu = login.user as any;
    const wallet = lu?.defaultWallet?.walletAddress;
    const xmppPassword = lu?.xmppPassword;
    const xmppUsername = lu?.xmppUsername || (lu?.appId && lu?._id ? `${lu.appId}_${lu._id}` : undefined);
    if (!xmppUsername || !xmppPassword) {
      throw new Error(`Login for ${handle} did not return XMPP credentials`);
    }
    out[handle] = {
      handle,
      token: login.token,
      identity: {
        xmppUsername,
        xmppPassword,
        walletAddress: wallet || "",
        firstName: u.firstName,
        lastName: u.lastName,
        photo: lu?.profileImage || "",
      },
    };
  }
  return out;
}

/**
 * (Re)build the live room for a scenario: optionally destroy the previous
 * room, create a fresh one owned by the web hero, subscribe the whole cast,
 * and seed the backstory history in order. Persists world.room.
 */
export async function setupRoom(
  cfg: HarnessConfig,
  scenario: Scenario,
  world: World,
  opts: { destroyPrevious?: boolean } = {}
): Promise<World> {
  const cast = await loginCast(cfg, world);
  const heroWebHandle = scenario.heroes.web;

  // Open XMPP connections for everyone (kept open to preserve message order).
  for (const u of Object.values(cast)) {
    u.xmpp = new HarnessXmpp({
      service: cfg.server.xmppWebSocket,
      conference: cfg.server.xmppConference,
      identity: u.identity,
    });
    await u.xmpp.connect();
  }
  log(`Connected ${Object.keys(cast).length} cast members over XMPP`);

  try {
    // Destroy the prior room if asked (clear old run state).
    if (opts.destroyPrevious && world.room?.jid) {
      const owner = cast[heroWebHandle];
      const destroyed = await owner!.xmpp!.destroyRoom(world.room.jid);
      log(`Previous room ${destroyed ? "destroyed" : "destroy not confirmed"}: ${world.room.jid}`);
    }

    // Create the new room as the web hero (a demo-app user).
    const owner = cast[heroWebHandle];
    if (!owner) throw new Error(`web hero "${heroWebHandle}" not provisioned`);
    const roomJid = await owner.xmpp!.createRoom(scenario.roomTitle, scenario.theme);
    log(`Room created: ${roomJid}`);

    // Subscribe everyone (so the room appears in each client's room list).
    for (const u of Object.values(cast)) {
      await u.xmpp!.joinAndSubscribe(roomJid);
    }
    log(`Subscribed ${Object.keys(cast).length} members to the room`);

    // Seed backstory history in order.
    for (const line of scenario.history) {
      const u = cast[line.actor];
      if (!u) {
        log(`  ! history actor "${line.actor}" not provisioned; skipping line`);
        continue;
      }
      await u.xmpp!.sendText(roomJid, line.text);
    }
    if (scenario.history.length) log(`Seeded ${scenario.history.length} backstory messages`);

    world.room = { jid: roomJid, title: scenario.roomTitle };
    const path = saveWorld(cfg.paths.secrets, world);
    log(`World updated: ${path}`);
    return world;
  } finally {
    for (const u of Object.values(cast)) {
      await u.xmpp?.disconnect();
    }
  }
}

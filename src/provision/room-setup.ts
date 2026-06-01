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
  const api = new EthoraApi(cfg.server.apiUrl);
  const cast = await loginCast(cfg, world);
  const heroWeb = cast[scenario.heroes.web];
  if (!heroWeb) throw new Error(`web hero "${scenario.heroes.web}" not provisioned`);
  const heroToken = heroWeb.token;

  // 1. Tear down the previous room (REST), if any.
  if (opts.destroyPrevious && world.room?.name) {
    try {
      await api.deleteChat(heroToken, world.room.name);
      log(`Deleted previous room: ${world.room.title}`);
    } catch (e) {
      log(`Previous room delete skipped: ${String((e as Error).message).slice(0, 80)}`);
    }
  }

  // 2. Create a fresh backend-registered room owned by the web hero.
  const chat = await api.createChat(heroToken, {
    title: scenario.roomTitle,
    description: scenario.theme,
    type: "group",
  });
  const roomJid = `${chat.name}@${cfg.server.xmppConference}`;
  log(`Room created: "${chat.title}" (${roomJid})`);

  // 3. Add the rest of the cast as members.
  const otherIds = Object.values(world.users)
    .filter((u) => u.handle !== scenario.heroes.web && u.userId)
    .map((u) => u.userId!) as string[];
  if (otherIds.length) {
    await api.addChatMembers(heroToken, chat.name, otherIds);
    log(`Added ${otherIds.length} members`);
  }

  // 4. Seed backstory history over XMPP (one connection per history actor).
  const actors = [...new Set(scenario.history.map((h) => h.actor))];
  const conns = new Map<string, HarnessXmpp>();
  try {
    for (const handle of actors) {
      const u = cast[handle];
      if (!u) continue;
      const x = new HarnessXmpp({
        service: cfg.server.xmppWebSocket,
        conference: cfg.server.xmppConference,
        identity: u.identity,
      });
      await x.connect();
      await x.joinAndSubscribe(roomJid);
      conns.set(handle, x);
    }
    for (const line of scenario.history) {
      await conns.get(line.actor)?.sendText(roomJid, line.text);
    }
    if (scenario.history.length) log(`Seeded ${scenario.history.length} backstory messages`);
  } finally {
    for (const x of conns.values()) await x.disconnect();
  }

  world.room = { jid: roomJid, name: chat.name, title: chat.title };
  const path = saveWorld(cfg.paths.secrets, world);
  log(`World updated: ${path}`);
  return world;
}

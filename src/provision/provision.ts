import { randomBytes } from "node:crypto";
import type { HarnessConfig } from "../config.js";
import type { Scenario } from "../scenarios/types.js";
import { EthoraApi, EthoraApiError, BASE_APP_DOMAIN } from "./ethora-api.js";
import { AvatarRasterizer } from "./avatar.js";
import { loadWorld, saveWorld, type World, type ProvisionedUser } from "./state.js";

const log = (m: string) => console.log(`  ${m}`);

function rand(n = 5): string {
  return randomBytes(8).toString("hex").slice(0, n);
}

/** Throwaway email on mailinator (valid domain, never delivers, excluded from CRM). */
function demoEmail(scenarioId: string, handle: string, suffix: string): string {
  return `ethora.demoqa.${scenarioId}.${handle}.${suffix}@mailinator.com`;
}

const DEMO_PASSWORD = "Midsummer!Demo123"; // throwaway, QA-only, never a real account

export interface ProvisionOptions {
  fresh?: boolean;
  skipAvatars?: boolean;
}

/**
 * Ensure a live "world" exists for the scenario on the configured server.
 * Idempotent: reuses secrets/world.<env>.<id>.json unless `fresh` is set.
 */
export async function provision(
  cfg: HarnessConfig,
  scenario: Scenario,
  opts: ProvisionOptions = {}
): Promise<World> {
  const api = new EthoraApi(cfg.server.apiUrl);

  const existing = opts.fresh ? null : loadWorld(cfg.paths.secrets, cfg.env, scenario.id);
  if (existing) {
    log(`Reusing existing world: secrets/world.${cfg.env}.${scenario.id}.json`);
    log(`  app=${existing.app.id} room=${existing.room?.jid ?? "(none)"} users=${Object.keys(existing.users).length}`);
    return existing;
  }

  log(`Provisioning a fresh world on ${cfg.env} (${cfg.server.apiUrl})`);
  const suffix = `${Date.now().toString(36)}${rand(3)}`;

  // 0. Bootstrap base app token (authorizes register/login).
  const baseApp = await api.getBaseAppConfig(BASE_APP_DOMAIN);
  log(`Base app resolved: ${baseApp._id}`);

  // 1. Owner account (under base app, which allows new-app creation).
  const owner = {
    email: demoEmail(scenario.id, "owner", suffix),
    password: DEMO_PASSWORD,
    firstName: "Demo",
    lastName: "Director",
  };
  await api.register(baseApp.appToken, owner.email, owner.firstName, owner.lastName, owner.password);
  const ownerLogin = await api.login(baseApp.appToken, owner.email, owner.password);
  log(`Owner account created: ${owner.email}`);

  // 2. Create the demo app.
  const domainName = `demoqa${scenario.id}${suffix}`.toLowerCase().replace(/[^a-z0-9]/g, "");
  const app = await api.createApp(ownerLogin.token, `${scenario.title} (Demo)`, domainName);
  log(`App created: ${app._id} (${app.domainName})`);

  // 3. Cast — register each under the new app, then set name + avatar.
  const raster = opts.skipAvatars ? null : new AvatarRasterizer();
  if (raster) await raster.init();
  const users: Record<string, ProvisionedUser> = {};
  for (const member of scenario.cast) {
    const email = demoEmail(scenario.id, member.handle, suffix);
    await api.register(app.appToken, email, member.firstName, member.lastName, DEMO_PASSWORD);
    const login = await api.login(app.appToken, email, DEMO_PASSWORD);
    const u: ProvisionedUser = {
      handle: member.handle,
      email,
      password: DEMO_PASSWORD,
      firstName: member.firstName,
      lastName: member.lastName,
      userId: login.user?._id,
    };
    if (raster) {
      try {
        const png = await raster.toPng({ firstName: member.firstName, lastName: member.lastName, seed: member.avatarSeed, color: member.avatarColor });
        await api.updateOwnProfile(login.token, { firstName: member.firstName, lastName: member.lastName, description: member.role }, png);
        u.avatarUploaded = true;
      } catch (e) {
        const msg = e instanceof EthoraApiError ? `${e.status}` : String(e);
        log(`  ! avatar upload failed for ${member.handle} (${msg}) — client will fall back to initials`);
      }
    }
    users[member.handle] = u;
    log(`Cast: ${member.firstName} ${member.lastName} (${member.handle})${u.avatarUploaded ? " +avatar" : ""}`);
  }
  await raster?.close();

  // The group room itself is created over XMPP per-run (see room-setup.ts),
  // because room creation is an XMPP operation, not a REST one, and the room
  // is meant to be torn down + rebuilt on each scenario run.
  const world: World = {
    env: cfg.env,
    scenarioId: scenario.id,
    createdAt: new Date().toISOString(),
    owner: { ...owner, userId: ownerLogin.user?._id },
    app: { id: app._id, token: app.appToken, secret: app.appSecret, domainName: app.domainName, displayName: app.displayName },
    users,
  };
  const path = saveWorld(cfg.paths.secrets, world);
  log(`World saved (gitignored): ${path}`);
  return world;
}

/** Re-upload PNG avatars for an already-provisioned cast (idempotent). */
export async function refreshAvatars(cfg: HarnessConfig, scenario: Scenario, world: World): Promise<void> {
  const api = new EthoraApi(cfg.server.apiUrl);
  const raster = new AvatarRasterizer();
  await raster.init();
  try {
    for (const member of scenario.cast) {
      const rec = world.users[member.handle];
      if (!rec) continue;
      const login = await api.login(world.app.token, rec.email, rec.password);
      const png = await raster.toPng({ firstName: member.firstName, lastName: member.lastName, seed: member.avatarSeed, color: member.avatarColor });
      await api.updateOwnProfile(login.token, { firstName: member.firstName, lastName: member.lastName, description: member.role }, png);
      rec.avatarUploaded = true;
      log(`Avatar refreshed: ${member.firstName} (${member.handle})`);
    }
    saveWorld(cfg.paths.secrets, world);
  } finally {
    await raster.close();
  }
}

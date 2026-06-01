import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { EnvName } from "../config.js";

/**
 * The provisioned "world" — everything created on the Ethora server for a
 * scenario. Persisted to secrets/world.<env>.<scenarioId>.json, which is
 * gitignored. This file holds credentials and MUST never be committed.
 */
export interface ProvisionedUser {
  handle: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  userId?: string;
  /** Last login token (short-lived; refreshed on demand, not relied upon). */
  token?: string;
  avatarUploaded?: boolean;
}

export interface World {
  env: EnvName;
  scenarioId: string;
  createdAt: string;
  owner: { email: string; password: string; firstName: string; lastName: string; userId?: string };
  app: { id: string; token: string; secret?: string; domainName: string; displayName: string };
  users: Record<string, ProvisionedUser>;
  room?: { jid: string; title: string };
}

export function worldPath(secretsDir: string, env: EnvName, scenarioId: string): string {
  return resolve(secretsDir, `world.${env}.${scenarioId}.json`);
}

export function loadWorld(secretsDir: string, env: EnvName, scenarioId: string): World | null {
  const p = worldPath(secretsDir, env, scenarioId);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as World;
}

export function saveWorld(secretsDir: string, world: World): string {
  mkdirSync(secretsDir, { recursive: true });
  const p = worldPath(secretsDir, world.env, world.scenarioId);
  writeFileSync(p, JSON.stringify(world, null, 2) + "\n", { mode: 0o600 });
  return p;
}

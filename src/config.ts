import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { SERVERS, type ServerEndpoints } from "./provision/ethora-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");

/** Tiny .env loader (no dotenv dependency). */
function loadEnvFile(): void {
  const envPath = resolve(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile();

export type EnvName = "qa" | "prod";

export interface HarnessConfig {
  env: EnvName;
  server: ServerEndpoints;
  paths: {
    root: string;
    secrets: string;
    artifacts: string;
    assets: string;
    webComponent: string;
    rnComponent: string;
    maestro: string;
  };
  iosSimulator: string;
}

export function loadConfig(): HarnessConfig {
  const env = (process.env.ETHORA_ENV as EnvName) || "qa";
  if (env !== "qa" && env !== "prod") {
    throw new Error(`ETHORA_ENV must be "qa" or "prod", got "${env}"`);
  }
  const server = { ...SERVERS[env] };
  if (process.env.ETHORA_API_BASE_URL) server.apiUrl = process.env.ETHORA_API_BASE_URL;
  if (process.env.ETHORA_XMPP_WS) server.xmppWebSocket = process.env.ETHORA_XMPP_WS;
  if (process.env.ETHORA_XMPP_HOST) server.xmppHost = process.env.ETHORA_XMPP_HOST;
  if (process.env.ETHORA_XMPP_CONFERENCE) server.xmppConference = process.env.ETHORA_XMPP_CONFERENCE;

  return {
    env,
    server,
    paths: {
      root: REPO_ROOT,
      secrets: resolve(REPO_ROOT, "secrets"),
      artifacts: resolve(REPO_ROOT, "artifacts"),
      assets: resolve(REPO_ROOT, "assets"),
      webComponent: resolve(REPO_ROOT, process.env.WEB_COMPONENT_PATH || "../ethora-chat-component"),
      rnComponent: resolve(REPO_ROOT, process.env.RN_COMPONENT_PATH || "../ethora-chat-component-rn"),
      maestro: resolve(REPO_ROOT, "maestro"),
    },
    iosSimulator: process.env.IOS_SIMULATOR || "iPhone 16",
  };
}

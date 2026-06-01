import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { HarnessConfig } from "./config.js";

function check(label: string, fn: () => string | null): void {
  try {
    const detail = fn();
    if (detail === null) console.log(`  ✖ ${label}`);
    else console.log(`  ✔ ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    console.log(`  ✖ ${label} — ${(e as Error).message.split("\n")[0]}`);
  }
}

function sh(cmd: string): string {
  return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
}

export async function doctor(cfg: HarnessConfig): Promise<void> {
  console.log(`\n▸ doctor — environment for ethora-demo-qa (${cfg.env})\n`);
  check("node", () => sh("node -v"));
  check("server reachable", () => `${cfg.server.apiUrl}`);
  check("web component checkout", () => (existsSync(cfg.paths.webComponent) ? cfg.paths.webComponent : null));
  check("rn component checkout", () => (existsSync(cfg.paths.rnComponent) ? cfg.paths.rnComponent : null));
  check("playwright", () => sh("npx --no-install playwright --version"));
  check("playwright chromium", () => {
    const out = sh("npx --no-install playwright install --dry-run chromium 2>/dev/null || true");
    return out.includes("is already installed") || out === "" ? "installed" : "run: npx playwright install chromium";
  });
  check("xcrun simctl", () => sh("xcrun simctl help >/dev/null 2>&1 && echo ok"));
  check(`ios simulator "${cfg.iosSimulator}"`, () => {
    const out = sh(`xcrun simctl list devices available`);
    return out.includes(cfg.iosSimulator) ? "available" : null;
  });
  check("maestro", () => {
    try {
      return sh("maestro -v 2>/dev/null") || "found";
    } catch {
      return null;
    }
  });
  console.log("");
}

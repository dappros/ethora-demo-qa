import { loadConfig } from "./config.js";
import { provision, refreshAvatars } from "./provision/provision.js";
import { setupRoom, loginCast } from "./provision/room-setup.js";
import { loadWorld } from "./provision/state.js";
import { runWeb } from "./web/runner.js";
import { midsummer } from "./scenarios/midsummer.js";
import type { Scenario } from "./scenarios/types.js";

const SCENARIOS: Record<string, Scenario> = {
  midsummer,
};

function getScenario(id: string | undefined): Scenario {
  const s = SCENARIOS[id || "midsummer"];
  if (!s) throw new Error(`Unknown scenario "${id}". Known: ${Object.keys(SCENARIOS).join(", ")}`);
  return s;
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const cfg = loadConfig();
  const scenario = getScenario(flags.scenario as string | undefined);

  switch (cmd) {
    case "provision": {
      console.log(`\n▸ provision — scenario "${scenario.id}" on ${cfg.env}\n`);
      let world = await provision(cfg, scenario, { fresh: !!flags.fresh, skipAvatars: !!flags["skip-avatars"] });
      if (!flags["no-room"]) {
        world = await setupRoom(cfg, scenario, world, { destroyPrevious: false });
      }
      console.log(`\n✔ world ready. app=${world.app.id} room=${world.room?.jid}\n`);
      break;
    }
    case "reset": {
      console.log(`\n▸ reset — rebuild room for "${scenario.id}" on ${cfg.env}\n`);
      const world = loadWorld(cfg.paths.secrets, cfg.env, scenario.id);
      if (!world) throw new Error(`No world found. Run: npm run provision`);
      const updated = await setupRoom(cfg, scenario, world, { destroyPrevious: true });
      console.log(`\n✔ fresh room ready: ${updated.room?.jid}\n`);
      break;
    }
    case "doctor": {
      const { doctor } = await import("./doctor.js");
      await doctor(cfg);
      break;
    }
    case "run": {
      const surface = (flags.surface as string) || "both";
      const world = loadWorld(cfg.paths.secrets, cfg.env, scenario.id);
      if (!world?.room) throw new Error(`No room. Run: npm run provision (or npm run reset)`);
      const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${scenario.id}`;
      console.log(`\n▸ run [${surface}] — "${scenario.id}" runId=${runId}\n`);
      // Identities for every cast member (used by the XMPP injector).
      const cast = await loginCast(cfg, world);
      const idents = Object.fromEntries(Object.entries(cast).map(([h, u]) => [h, { identity: u.identity }]));

      if (surface === "ios") {
        const { runIos } = await import("./mobile/ios.js");
        const res = await runIos(cfg, scenario, world, runId);
        console.log(`\n  ios: ${res.screenshots.length} screenshots in artifacts/${runId}/ios`);
      } else if (surface === "both") {
        // Cross-platform: bring the iOS hero online in the room first, then
        // drive the web hero through the scenario (with the iOS hero's lines
        // injected so the web side reads complete), while the live iOS client
        // mirrors the whole exchange. Capture iOS before + after.
        const { IosDriver, buildIosCreds } = await import("./mobile/ios.js");
        const iosCreds = await buildIosCreds(cfg, world, scenario.heroes.ios);
        const ios = new IosDriver(cfg, runId);
        await ios.launchWithCreds(JSON.stringify(iosCreds));
        await new Promise((r) => setTimeout(r, 12000));
        await ios.screenshot("ios-00-before");
        const res = await runWeb(cfg, scenario, world, idents, runId, {
          headless: flags.headed ? false : true,
          injectIosHero: true,
        });
        await ios.screenshot("ios-99-after");
        console.log(`\n  web: ${res.screenshots.length} screenshots + video; ios: mirror screenshots in artifacts/${runId}/ios`);
      } else {
        const res = await runWeb(cfg, scenario, world, idents, runId, {
          headless: flags.headed ? false : true,
          injectIosHero: true,
        });
        console.log(`\n  web: ${res.screenshots.length} screenshots + video in ${res.videoDir}`);
      }
      console.log(`\n✔ run complete. artifacts/${runId}/\n`);
      break;
    }
    case "avatars": {
      console.log(`\n▸ avatars — refresh PNG avatars for "${scenario.id}"\n`);
      const world = loadWorld(cfg.paths.secrets, cfg.env, scenario.id);
      if (!world) throw new Error(`No world. Run: npm run provision`);
      await refreshAvatars(cfg, scenario, world);
      console.log(`\n✔ avatars refreshed\n`);
      break;
    }
    case "seed":
      console.log(`(${cmd}) folded into reset — use: npm run reset`);
      break;
    default:
      console.log(`Usage: tsx src/cli.ts <provision|run|reset|seed|doctor> [--scenario midsummer] [--fresh] [--surface web|ios|both]`);
  }
}

main().catch((e) => {
  console.error("\n✖ error:", e?.message || e);
  if (e?.body) console.error("  body:", String(e.body).slice(0, 800));
  process.exit(1);
});

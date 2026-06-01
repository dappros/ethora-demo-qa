import { loadConfig } from "./config.js";
import { provision } from "./provision/provision.js";
import { setupRoom } from "./provision/room-setup.js";
import { loadWorld } from "./provision/state.js";
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
    case "run":
    case "seed":
      console.log(`(${cmd}) not yet wired — building runners next.`);
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

// jsm-hq — start HQ for the git repo you're in.
//
//   jsm-hq [--repo <path>] [--port 7420] [--dev] [--no-open]
//   jsm-hq reset-owner        on the host: forget the owner's credentials and write a new setup code
//
// One HQ runs every project in the company store, plus the repo it is started
// in (never HQ's own source). See docs/adr/0009-one-hq-many-projects.md.
//
// --dev: the UI is served by Vite (pnpm dev:hq); HQ prints/opens the Vite URL.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { companyHome, openCompany } from "./company";
import { hqSourceRoot } from "./hqSource";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { ensurePtyHelperExecutable } from "./lib/ptyFix";
import { OwnerAuth } from "./ownerAuth";
import { startHq } from "./startHq";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/** Recovery that needs the host (SR-C-18): the owner enrolls again with a new setup code. Run it with HQ stopped. */
function resetOwner() {
  const home = companyHome();
  const company = openCompany({ home, repoRoot: null });
  try {
    company.humans.reset("owner");
    const auth = new OwnerAuth({ accounts: company.humans, clock: company.clock, audit: company.audit, allowedOrigins: [], setupFile: join(home, "owner-setup.txt") });
    const file = auth.prepareSetup();
    log.info(`The owner's password, PIN and authenticator were forgotten. Start HQ and enroll again with the setup code in ${file}.`);
  } finally {
    company.close();
  }
}

async function main() {
  if (process.argv.includes("reset-owner")) return resetOwner();
  ensurePtyHelperExecutable();
  const dev = flag("dev");
  const port = Number(arg("port") ?? process.env.HQ_PORT ?? 7420);
  const distDir = join(hqSourceRoot(), "dist");
  const uiPort = Number(process.env.HQ_UI_PORT ?? 5173);
  const uiOrigin = dev ? `http://localhost:${uiPort}` : `http://127.0.0.1:${port}`;
  if (!dev && !existsSync(join(distDir, "index.html"))) log.warn("No built UI found. Run `pnpm build` first, or use `pnpm dev:hq`.");
  // Extra dashboard origins, such as the Tailscale name the phone uses (M0-G sets it).
  const extraOrigins = (process.env.HQ_DASHBOARD_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const hq = await startHq({
    start: resolve(arg("repo") ?? process.env.HQ_REPO ?? process.cwd()),
    port,
    dev,
    distDir: dev ? null : distDir,
    uiOrigin,
    extraOrigins: [`http://127.0.0.1:${uiPort}`, ...extraOrigins],
  });

  log.info(`

  JSM HQ is running → ${hq.url}
`);
  // The setup code itself is never printed: whoever enrolls must be able to read the file on this machine.
  if (hq.setupFile) log.info(`  No owner yet. Open ${hq.url} and enter the setup code from ${hq.setupFile}
`);
  if (!flag("no-open")) {
    // Windows: rundll32 hands the URL to the default browser without a shell.
    const [opener, args] = process.platform === "darwin" ? ["open", [hq.url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", hq.url]] : ["xdg-open", [hq.url]];
    // Give Vite a moment in dev.
    setTimeout(() => void run(opener, args), dev ? 1500 : 0);
  }

  const quit = () => {
    log.info("stopping HQ and its agents — tmux sessions keep running; sandboxes and folders are kept");
    hq.close();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

main().catch((err) => {
  if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    log.error(`Port ${arg("port") ?? 7420} is in use — another HQ may be running. Stop it, or pick another port: npx @therealjsmastery/jsm-hq --port 7421`);
    process.exit(1);
  }
  if ((err as NodeJS.ErrnoException)?.code === "EACCES") {
    const port = arg("port") ?? 7420;
    log.error(
      process.platform === "win32"
        ? `Windows reserved port ${port} (Hyper-V, WSL and Docker reserve port ranges). Pick another: npx @therealjsmastery/jsm-hq --port 8420\n  See the reserved ranges with: netsh interface ipv4 show excludedportrange protocol=tcp`
        : `Not allowed to use port ${port}. Pick another: npx @therealjsmastery/jsm-hq --port 8420`,
    );
    process.exit(1);
  }
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

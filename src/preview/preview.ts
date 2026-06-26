/**
 * Live preview (roadmap headline). The clickable/interactive preview for our SERVER-SIDE architecture
 * is the app's own dev server booted on demand, behind a real URL — exactly what makes Base44/Lovable
 * feel alive, minus their WebContainers (which we removed). `vibehard preview <dir>` installs if
 * needed, optionally seeds (so the preview opens onto a LIVING app, not an empty one), boots the dev
 * server, and reports the URL it advertises.
 *
 * Pure helpers (devCommand, parsePreviewUrl) are unit-tested; runPreview drives a long-lived process.
 * The same runPreview powers a future dashboard-embedded preview (the URL gets iframed) — no rework.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installStale } from "../gate/verify.ts";

export interface PkgLike {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface DevCommand {
  cmd: string;
  args: string[];
}

/** The dev-server command for a generated app: prefer the package's own `dev` script (next dev /
 *  vite), else a framework default. Generated Next.js apps always have a `dev` script. */
export function devCommand(pkg: PkgLike | null): DevCommand {
  if (pkg?.scripts?.dev) return { cmd: "npm", args: ["run", "dev"] };
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (deps.next) return { cmd: "npx", args: ["next", "dev"] };
  if (deps.vite) return { cmd: "npx", args: ["vite"] };
  return { cmd: "npm", args: ["start"] };
}

/** Pull a localhost preview URL out of a dev-server log line (Next: "Local: http://localhost:3000",
 *  Vite: "Local:   http://localhost:5173/"). Trailing punctuation stripped. */
export function parsePreviewUrl(line: string): string | null {
  const m = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s'"]*/i);
  return m ? m[0].replace(/[).,]+$/, "") : null;
}

function readPkg(dir: string): PkgLike | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PkgLike;
  } catch {
    return null;
  }
}

export interface PreviewHandle {
  url: string;
  /** the running dev-server process; await `.exited` to keep alive, or kill to stop. */
  proc: ReturnType<typeof Bun.spawn>;
}

export interface PreviewOptions {
  seed?: boolean; // run scripts/seed.ts first if present + Supabase creds are set
  onLog?: (line: string) => void;
  /** how long to wait for the server to advertise a URL before giving up. */
  readyTimeoutMs?: number;
}

/** Boot the app's dev server and resolve once it advertises a URL. Caller owns `proc` (await/kill). */
export async function runPreview(dir: string, opts: PreviewOptions = {}): Promise<PreviewHandle> {
  const log = opts.onLog ?? ((l: string) => process.stdout.write(l + "\n"));
  const pkg = readPkg(dir);
  if (!pkg) throw new Error(`no package.json in ${dir}`);

  // 1) install if needed
  if (!existsSync(join(dir, "node_modules")) || installStale(dir)) {
    log("  ▸ installing dependencies…");
    const inst = Bun.spawnSync(["npm", "install", "--no-audit", "--no-fund"], { cwd: dir, stdout: "inherit", stderr: "inherit" });
    if (inst.exitCode !== 0) throw new Error("npm install failed");
  }

  // 2) optional seed (only if the script + Supabase creds exist — else the preview just renders empty)
  if (opts.seed && existsSync(join(dir, "scripts/seed.ts")) && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    log("  ▸ seeding demo data…");
    Bun.spawnSync(["bun", "scripts/seed.ts"], { cwd: dir, stdout: "inherit", stderr: "inherit", env: { ...process.env } });
  }

  // 3) boot the dev server; watch its output for the URL it advertises
  const { cmd, args } = devCommand(pkg);
  log(`  ▸ starting dev server (${cmd} ${args.join(" ")})…`);
  const proc = Bun.spawn([cmd, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env } });

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 60_000);
  const decoder = new TextDecoder();
  async function watch(stream: ReadableStream<Uint8Array> | null): Promise<string | null> {
    if (!stream) return null;
    for await (const chunk of stream) {
      for (const line of decoder.decode(chunk).split("\n")) {
        if (line.trim()) log(`    ${line.trim()}`);
        const url = parsePreviewUrl(line);
        if (url) return url;
      }
      if (Date.now() > deadline) return null;
    }
    return null;
  }
  // race stdout/stderr (Next prints the URL on stdout; some setups on stderr)
  const url = await Promise.race([watch(proc.stdout as ReadableStream<Uint8Array>), watch(proc.stderr as ReadableStream<Uint8Array>)]);
  if (!url) {
    proc.kill();
    throw new Error("dev server did not advertise a URL in time");
  }
  return { url, proc };
}

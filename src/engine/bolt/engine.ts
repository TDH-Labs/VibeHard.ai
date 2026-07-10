/**
 * bolt.diy engine adapter — the first (and, per §12, only) Engine implementation.
 *
 * Discipline (PROJECT_BRIEF.md §13): we invest in the SEAM, not the adapter. The
 * real bolt.diy fork couples to us at exactly ONE point — the `BoltDriver` below,
 * which yields bolt's native protocol text for a prompt. Everything else (event
 * normalization, file materialization into OUR workspace, lifecycle) is ours and
 * is engine-swappable. Durable state lives on our side; the engine is a stateless
 * function over it, so it's dispose()-able / ephemeral-container friendly.
 *
 * M2 ships the seam with an injectable driver. The real driver (bolt.diy + an LLM)
 * drops in behind this interface later with nothing above the seam changing.
 */
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import type { Engine, EngineConfig, EngineEvent, EngineSession } from "../../types.ts";
import { parseBoltStream, segmentToEvent } from "./normalizer.ts";
import { MERGEABLE_BASENAMES, mergeConfigFile } from "./merge-config.ts";

/** Lockfiles the model must never hand-author. A real lockfile is a mechanical
 *  fingerprint of what the registry actually served (npm/bun computed it from a
 *  real install) — an LLM asked to produce one instead free-generates plausible-
 *  looking JSON/YAML from training-data patterns, including near-miss integrity
 *  hashes (right shape, wrong bytes: SHA-512's avalanche effect means a genuine
 *  mismatch looks nothing alike, but a hallucinated one differs by a character or
 *  two — that signature is how this was root-caused). A hallucinated hash fails
 *  `npm ci` in the clean-machine verify (EINTEGRITY) or, worse, silently resolves
 *  the wrong package version. Lockfiles are ONLY ever trustworthy when generated
 *  by the real package manager — ensureInstalled() in gate/verify.ts is the sole
 *  legitimate source; this is the write-side chokepoint that keeps the model out. */
const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
]);

/** Resolve `rel` under `root`, or null if it escapes the workspace. The model controls `seg.filePath`,
 *  so `join` alone is unsafe — it collapses `../../` and an ABSOLUTE path overrides the root entirely,
 *  letting generated output write anywhere on the host. Containment is enforced here, write-side. */
export function containedPath(root: string, rel: string): string | null {
  const base = resolve(root);
  // A leading "/" in a bolt filePath means the WORKSPACE root (a generator convention), NOT the host
  // root — strip it so it stays relative (matching the old join() behavior). Only `../` traversal that
  // genuinely escapes `base` is rejected.
  const abs = resolve(base, rel.replace(/^\/+/, ""));
  return abs === base || abs.startsWith(base + sep) ? abs : null;
}

/** The ONLY coupling point to the real engine: raw bolt-protocol text for a prompt. */
export interface BoltDriver {
  readonly name: string;
  /** Yield bolt's native protocol output (streamed in any number of chunks). */
  run(prompt: string, config: EngineConfig): AsyncIterable<string>;
  /** Optional teardown for driver-held resources (sockets, child processes…). */
  dispose?(): Promise<void>;
}

/** A replay driver over canned protocol chunks — for tests and offline demos. */
export function replayDriver(chunks: string[], name = "replay"): BoltDriver {
  return {
    name,
    async *run() {
      for (const c of chunks) yield c;
    },
  };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Per-absolute-path async mutex, serializing concurrent writes to the SAME file across ALL
 *  BoltSession instances in this process — module-level (not per-session) because `runTiers`
 *  (pool.ts) runs up to VIBEHARD_CODEGEN_CONCURRENCY (default 4) workstreams concurrently,
 *  EACH constructing its own BoltEngine/BoltSession (cli.ts's streamGeneration), all writing
 *  into the SAME workspace dir. Without this, two workstreams' `await mkdir` / `await Bun.write`
 *  calls for the SAME path can genuinely interleave (this is async, not multi-threaded, but the
 *  await points are real yield points) — a check-then-write merge would otherwise itself race.
 *  Standard promise-chain mutex: each call chains onto whatever's already queued for that key;
 *  `.catch(()=>{})` on the STORED continuation stops one queued failure from poisoning the next
 *  waiter, while the promise returned to the caller still carries the real outcome. */
const fileLocks = new Map<string, Promise<unknown>>();
async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = fileLocks.get(key) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  fileLocks.set(
    key,
    result.catch(() => {}),
  );
  return result;
}

class BoltSession implements EngineSession {
  private readonly seen = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly driver: BoltDriver,
    private readonly config: EngineConfig,
  ) {}

  workspacePath(): string {
    return this.dir;
  }

  async *prompt(text: string): AsyncIterable<EngineEvent> {
    // Progress indicator (§14 Gap 1 decision: keep accumulate-then-parse). We
    // consume the whole bolt stream before parsing, so without this the user sees
    // silence until every file lands at once. An immediate "working" signal is the
    // honest MVP until the front door exists; live per-file streaming is the
    // deferred incremental-parse path — and the seam (AsyncIterable<EngineEvent>)
    // already supports it, so that swap stays behind this boundary with zero
    // consumer changes. The deterministic gate is unaffected either way: it scans
    // the final materialized workspace, not the live stream.
    yield { type: "thinking", text: "Generating your app…" };

    let raw = "";
    try {
      for await (const chunk of this.driver.run(text, this.config)) raw += chunk;
    } catch (e) {
      yield { type: "error", message: `engine driver failed: ${errMessage(e)}` };
      return;
    }

    for (const seg of parseBoltStream(raw)) {
      const event = segmentToEvent(seg, this.seen);
      if (seg.kind === "file") {
        // Materialize into OUR durable workspace — this is exactly what the gate
        // chain scans before deploy. The engine writes; the gate disposes.
        try {
          const abs = containedPath(this.dir, seg.filePath);
          if (!abs) {
            // Path traversal / absolute path → refuse, write NOTHING outside the workspace.
            yield { type: "error", message: `refused to write outside the workspace: ${seg.filePath}` };
            continue;
          }
          if (LOCKFILE_BASENAMES.has(basename(abs))) {
            // Refuse a model-authored lockfile — see LOCKFILE_BASENAMES. The real one gets
            // generated by ensureInstalled()'s actual npm/bun install, never by the model.
            yield {
              type: "message",
              text: `skipped a model-authored lockfile (${seg.filePath}) — the real one is generated by npm/bun install`,
            };
            continue;
          }
          const conflicts = await withFileLock(abs, async () => {
            await mkdir(dirname(abs), { recursive: true });
            // Shared-config merge (ROADMAP.md "Parallel workstreams overwrite shared config
            // files"): if another workstream in this SAME tier already wrote package.json /
            // tsconfig.json here, don't blindly overwrite it — merge deterministically. Locked
            // so the read-then-write itself can't race a concurrent workstream's write to the
            // same path (mapPool runs up to 4 workstreams concurrently, each its own session).
            if (MERGEABLE_BASENAMES.has(basename(abs)) && (await Bun.file(abs).exists())) {
              const existing = await Bun.file(abs).text();
              const { merged, conflicts } = mergeConfigFile(basename(abs), existing, seg.content);
              await Bun.write(abs, merged);
              return conflicts;
            }
            await Bun.write(abs, seg.content);
            return [] as string[];
          });
          this.seen.add(seg.filePath);
          for (const c of conflicts) {
            yield { type: "message", text: `merged ${seg.filePath} with another workstream's version — ${c}` };
          }
        } catch (e) {
          yield { type: "error", message: `failed to write ${seg.filePath}: ${errMessage(e)}` };
          continue;
        }
      }
      if (event) yield event;
    }
    yield { type: "done" };
  }

  async dispose(): Promise<void> {
    await this.driver.dispose?.();
  }
}

export class BoltEngine implements Engine {
  readonly name = "bolt.diy";

  constructor(private readonly driver: BoltDriver) {}

  async startSession(projectPath: string, config: EngineConfig): Promise<EngineSession> {
    await mkdir(projectPath, { recursive: true });
    return new BoltSession(projectPath, this.driver, config);
  }
}

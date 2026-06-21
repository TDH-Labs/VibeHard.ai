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
import { dirname, join } from "node:path";
import type { Engine, EngineConfig, EngineEvent, EngineSession } from "../../types.ts";
import { parseBoltStream, segmentToEvent } from "./normalizer.ts";

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
          const abs = join(this.dir, seg.filePath);
          await mkdir(dirname(abs), { recursive: true });
          await Bun.write(abs, seg.content);
          this.seen.add(seg.filePath);
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

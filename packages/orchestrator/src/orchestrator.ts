/**
 * The build ORCHESTRATOR — the conversational owner of a build (backlog: human layer).
 * Instead of a dashboard you poll, this is an agent you message and that messages you:
 *   - PROACTIVE OUT: build events the human would act on (held + the localized reason,
 *     a gate failing, a decision needed, missing keys, shipped) become messages.
 *   - CONVERSATIONAL IN: "why'd it hold?", "retry", "ship it" → real actions on the build.
 *
 * Channel-agnostic by construction: the brain talks to a `Channel` (web panel today,
 * Slack/Telegram tomorrow) and acts through injected `BuildTools` (diagnose, gate, autofix,
 * ship — the things we already built). Two safety rails, both from this project's history:
 *   1. CONSEQUENTIAL actions (ship, spend) are GATED behind an explicit human confirm —
 *      the LLM never takes them on its own ("never put an LLM in the send path").
 *   2. The LLM only INTERPRETS fuzzy input into a known verb; the verbs run deterministic
 *      code. LLM proposes, deterministic disposes.
 */

export type OutboundKind = "info" | "held" | "decision" | "done" | "error";
export interface OutboundMessage {
  kind: OutboundKind;
  text: string;
}

/** Where messages go to the human (and, by the adapter, come back). */
export interface Channel {
  send(message: OutboundMessage): Promise<void> | void;
}

/** Events the build/gate/autofix loop emits; the orchestrator decides what to surface. */
export type BuildEvent =
  | { type: "stage"; stage: string }
  | { type: "gate"; gate: string; status: "pass" | "block" }
  | { type: "held"; ticket: string; reason: string }
  | { type: "needs-keys"; keys: string[] }
  | { type: "shipped" }
  | { type: "done"; ok: boolean; summary?: string };

/** The orchestrator's "hands" — real actions, injected so the brain is testable without
 *  the heavy pipeline. `ship` is consequential: the orchestrator gates it behind confirm. */
export interface BuildTools {
  status(): Promise<string>;
  why(): Promise<string>; // the current blocker, localized (diagnose)
  retry(): Promise<string>; // re-run the autofix loop
  ship(): Promise<string>; // CONSEQUENTIAL
  setModel(stage: string, model: string): string;
}

export type Intent = "status" | "why" | "retry" | "ship" | "set-model" | "help" | "chat";
export interface Classification {
  intent: Intent;
  arg?: string;
}
/** Maps a free-form human message to a known verb (LLM-backed in production, faked in tests).
 *  Only invoked when deterministic keyword routing doesn't already match. */
export type Classifier = (message: string, context: string) => Promise<Classification>;

/** Consequential verbs need an explicit confirm before they run. */
const CONSEQUENTIAL: ReadonlySet<Intent> = new Set<Intent>(["ship"]);

/** Where the pending-confirm slot lives. Injected so a host application can back it with
 *  durable, cross-process storage — without this, "ship" then "yes" only works if BOTH
 *  messages land on the same process (a real bug on a multi-machine web tier: the confirm
 *  and its "yes" can be routed to different machines, each with its own in-memory
 *  Orchestrator instance, and the "yes" gets silently reclassified as a fresh message). */
export interface ConfirmStore {
  get(): Promise<Intent | null>;
  set(intent: Intent | null): Promise<void>;
}

/** Default: in-process only, exactly today's behavior. Correct for a single-process host
 *  (tests, a standalone CLI) — a host with a multi-machine web tier must inject a durable
 *  implementation (e.g. backed by the same per-tenant store used for the outbound Channel). */
export class InMemoryConfirmStore implements ConfirmStore {
  private value: Intent | null = null;
  async get(): Promise<Intent | null> {
    return this.value;
  }
  async set(intent: Intent | null): Promise<void> {
    this.value = intent;
  }
}

const AFFIRM = /^(y|yes|yep|yeah|do it|confirm|go|ship it|proceed|ok|okay)\b/i;
const DENY = /^(n|no|nope|cancel|stop|wait|don'?t|abort)\b/i;

/** Deterministic keyword routing — the common commands never need the LLM. */
export function routeKeyword(message: string): Classification | null {
  const m = message.trim().toLowerCase();
  if (/\b(status|where are we|how'?s it going|progress|update)\b/.test(m)) return { intent: "status" };
  if (/\b(why|what'?s wrong|what broke|reason|blocker|held|stuck|fail)\b/.test(m)) return { intent: "why" };
  if (/\b(retry|try again|fix it|re-?run|keep going|resume)\b/.test(m)) return { intent: "retry" };
  if (/\b(ship|deploy|release|publish|go live)\b/.test(m)) return { intent: "ship" };
  if (/\b(help|what can you do|commands)\b/.test(m)) return { intent: "help" };
  const model = /\buse\s+([\w.\-]+)(?:\s+for\s+(\w+))?/.exec(m);
  if (model) return { intent: "set-model", arg: model[2] ? `${model[2]} ${model[1]}` : (model[1] ?? "") };
  return null;
}

const HELP = [
  "I'm watching this build. You can say:",
  "  • status — where it's at",
  "  • why — the current blocker (localized to the file)",
  "  • retry — run the auto-fix loop again",
  "  • use <model> [for <stage>] — switch the model",
  "  • ship — deploy it (I'll confirm with you first)",
].join("\n");

/** Pure: a build event → the message to push (or null to stay quiet — not every event
 *  is worth interrupting a human for). */
export function proactiveMessage(e: BuildEvent): OutboundMessage | null {
  switch (e.type) {
    case "held":
      return { kind: "held", text: `🛑 Held for review (${e.ticket}). ${e.reason}\nSay "why" for detail, "retry" to try again, or tell me how to fix it.` };
    case "needs-keys":
      return { kind: "decision", text: `🔑 This build needs keys before it can run: ${e.keys.join(", ")}. Add them and say "retry".` };
    case "shipped":
      return { kind: "done", text: "🚀 Shipped." };
    case "done":
      return { kind: e.ok ? "done" : "error", text: e.ok ? `✅ Build passed all gates.${e.summary ? ` ${e.summary}` : ""}` : `❌ Build stopped.${e.summary ? ` ${e.summary}` : ""}` };
    case "gate":
      return e.status === "block" ? { kind: "info", text: `gate ${e.gate} is blocking — working on it.` } : null; // passes are noise
    case "stage":
      return null; // progress is for the UI, not a ping
  }
}

/** The conversational brain. Stateless except for a single pending-confirm slot, which lives
 *  behind the injected `ConfirmStore` (durable by default in a host that supplies one). */
export class Orchestrator {
  constructor(
    private readonly tools: BuildTools,
    private readonly channel: Channel,
    private readonly classify: Classifier,
    private readonly confirmStore: ConfirmStore = new InMemoryConfirmStore(),
  ) {}

  /** Push a proactive message for a build event, if it warrants one. */
  async onEvent(e: BuildEvent): Promise<void> {
    const m = proactiveMessage(e);
    if (m) await this.channel.send(m);
  }

  /** Handle an inbound human message; returns the reply (also useful for tests). */
  async onMessage(text: string): Promise<OutboundMessage> {
    // 1) resolve a pending confirmation first
    const pendingConfirm = await this.confirmStore.get();
    if (pendingConfirm) {
      const verb = pendingConfirm;
      if (AFFIRM.test(text.trim())) {
        await this.confirmStore.set(null);
        return this.run({ intent: verb });
      }
      if (DENY.test(text.trim())) {
        await this.confirmStore.set(null);
        return { kind: "info", text: "Okay, holding off." };
      }
      // not a yes/no → drop the pending action and treat as a new message
      await this.confirmStore.set(null);
    }

    // 2) deterministic keyword routing, else the LLM maps it to a verb
    const routed = routeKeyword(text) ?? (await this.classify(text, await this.safeStatus()));

    // 3) consequential verbs require an explicit confirm before running
    if (CONSEQUENTIAL.has(routed.intent)) {
      await this.confirmStore.set(routed.intent);
      return { kind: "decision", text: `You want me to ${routed.intent} this build. That's not reversible from here — confirm? (yes/no)` };
    }
    return this.run(routed);
  }

  private async run(c: Classification): Promise<OutboundMessage> {
    try {
      switch (c.intent) {
        case "status":
          return { kind: "info", text: await this.tools.status() };
        case "why":
          return { kind: "info", text: await this.tools.why() };
        case "retry":
          return { kind: "info", text: await this.tools.retry() };
        case "ship":
          return { kind: "done", text: await this.tools.ship() };
        case "set-model": {
          const [stage, model] = (c.arg ?? "").split(" ");
          return { kind: "info", text: this.tools.setModel(stage ?? "codegen", model ?? stage ?? "") };
        }
        case "help":
          return { kind: "info", text: HELP };
        case "chat":
        default:
          return { kind: "info", text: c.arg?.trim() ? c.arg : `${HELP}` };
      }
    } catch (e) {
      return { kind: "error", text: `That didn't work: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async safeStatus(): Promise<string> {
    try {
      return await this.tools.status();
    } catch {
      return "(status unavailable)";
    }
  }
}

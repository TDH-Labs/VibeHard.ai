import { describe, expect, test } from "bun:test";
import { Orchestrator, proactiveMessage, routeKeyword, InMemoryConfirmStore, type BuildTools, type Channel, type Classifier, type ConfirmStore, type Intent, type OutboundMessage } from "./orchestrator.ts";

function fakeTools(over: Partial<BuildTools> = {}): BuildTools {
  return {
    status: async () => "status: in codegen",
    why: async () => "blocker: app/x.ts:5 type error",
    retry: async () => "re-ran the loop",
    ship: async () => "shipped",
    setModel: (s, m) => `set ${s} → ${m}`,
    ...over,
  };
}
function capture(): { channel: Channel; sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return { channel: { send: (m) => void sent.push(m) }, sent };
}
const neverClassify: Classifier = async () => {
  throw new Error("classifier should not be called");
};

describe("routeKeyword", () => {
  test("common verbs route deterministically (no LLM)", () => {
    expect(routeKeyword("status?")?.intent).toBe("status");
    expect(routeKeyword("why did it stop")?.intent).toBe("why");
    expect(routeKeyword("retry please")?.intent).toBe("retry");
    expect(routeKeyword("ship it")?.intent).toBe("ship");
    expect(routeKeyword("use kimi-k2.7-code for codegen")).toEqual({ intent: "set-model", arg: "codegen kimi-k2.7-code" });
  });
  test("free-form falls through to the classifier", () => {
    expect(routeKeyword("hmm what do you make of all this")).toBeNull();
  });
});

describe("proactiveMessage", () => {
  test("a hold surfaces the reason + next steps", () => {
    const m = proactiveMessage({ type: "held", ticket: "esc-1", reason: "build failed at x.ts" })!;
    expect(m.kind).toBe("held");
    expect(m.text).toContain("esc-1");
    expect(m.text).toContain("build failed at x.ts");
  });
  test("passing gates and stage progress are NOT pinged (noise)", () => {
    expect(proactiveMessage({ type: "gate", gate: "sast", status: "pass" })).toBeNull();
    expect(proactiveMessage({ type: "stage", stage: "codegen" })).toBeNull();
  });
});

describe("Orchestrator inbound", () => {
  test("status runs the tool", async () => {
    const { channel } = capture();
    const o = new Orchestrator(fakeTools(), channel, neverClassify);
    expect((await o.onMessage("where are we?")).text).toBe("status: in codegen");
  });

  test("CONSEQUENTIAL ship is gated behind an explicit confirm (never auto-runs)", async () => {
    let shipped = false;
    const { channel } = capture();
    const o = new Orchestrator(fakeTools({ ship: async () => ((shipped = true), "shipped") }), channel, neverClassify);

    const first = await o.onMessage("ship it");
    expect(first.kind).toBe("decision");
    expect(shipped).toBe(false); // did NOT ship on the verb alone

    const confirm = await o.onMessage("yes");
    expect(shipped).toBe(true);
    expect(confirm.text).toBe("shipped");
  });

  test("declining a pending confirm cancels it", async () => {
    let shipped = false;
    const { channel } = capture();
    const o = new Orchestrator(fakeTools({ ship: async () => ((shipped = true), "shipped") }), channel, neverClassify);
    await o.onMessage("deploy");
    const no = await o.onMessage("no");
    expect(shipped).toBe(false);
    expect(no.text).toContain("holding off");
  });

  test("a non-yes/no during a pending confirm drops it and handles the new message", async () => {
    const { channel } = capture();
    const o = new Orchestrator(fakeTools(), channel, neverClassify);
    await o.onMessage("ship"); // arms confirm
    const reply = await o.onMessage("actually, status"); // not yes/no → treat fresh
    expect(reply.text).toBe("status: in codegen");
  });

  test("free-form goes to the classifier, which maps it to a verb", async () => {
    const classify: Classifier = async () => ({ intent: "why" });
    const { channel } = capture();
    const o = new Orchestrator(fakeTools(), channel, classify);
    expect((await o.onMessage("so what's the holdup exactly")).text).toContain("type error");
  });

  test("a tool error is reported, not thrown", async () => {
    const { channel } = capture();
    const o = new Orchestrator(fakeTools({ retry: async () => { throw new Error("boom"); } }), channel, neverClassify);
    const r = await o.onMessage("retry");
    expect(r.kind).toBe("error");
    expect(r.text).toContain("boom");
  });
});

describe("Orchestrator outbound", () => {
  test("onEvent pushes a held message to the channel", async () => {
    const { channel, sent } = capture();
    const o = new Orchestrator(fakeTools(), channel, neverClassify);
    await o.onEvent({ type: "held", ticket: "esc-9", reason: "verify failed" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe("held");
  });
  test("onEvent stays silent on noise events", async () => {
    const { channel, sent } = capture();
    const o = new Orchestrator(fakeTools(), channel, neverClassify);
    await o.onEvent({ type: "gate", gate: "rls", status: "pass" });
    expect(sent).toHaveLength(0);
  });
});

/** A store backed by a plain object, standing in for "a real durable store shared across
 *  process boundaries" — exercises the SAME cross-instance behavior a Postgres-backed
 *  ConfirmStore would give in production, without needing a real database in this test. */
function sharedStore(): ConfirmStore {
  const box: { value: Intent | null } = { value: null };
  return {
    get: async () => box.value,
    set: async (intent) => {
      box.value = intent;
    },
  };
}

describe("Orchestrator — durable ConfirmStore (W7)", () => {
  test("default (no store injected) behaves exactly as before: in-process only", async () => {
    let shipped = false;
    const { channel } = capture();
    const o = new Orchestrator(fakeTools({ ship: async () => ((shipped = true), "shipped") }), channel, neverClassify);
    const first = await o.onMessage("ship it");
    expect(first.kind).toBe("decision");
    expect(shipped).toBe(false);
    const confirm = await o.onMessage("yes");
    expect(shipped).toBe(true);
    expect(confirm.text).toBe("shipped");
  });

  test("an explicit InMemoryConfirmStore behaves identically to the default", async () => {
    let shipped = false;
    const { channel } = capture();
    const o = new Orchestrator(fakeTools({ ship: async () => ((shipped = true), "shipped") }), channel, neverClassify, new InMemoryConfirmStore());
    await o.onMessage("ship it");
    await o.onMessage("yes");
    expect(shipped).toBe(true);
  });

  test("THE BUG THIS CLOSES: a confirm proposed on one Orchestrator instance is honored by a DIFFERENT instance sharing the same durable store — simulating the 'yes' landing on a different machine", async () => {
    let shipped = false;
    const store = sharedStore();
    const { channel: channelA } = capture();
    const { channel: channelB } = capture();
    // Two separate Orchestrator instances — exactly what web/server.ts's getOrchestrator
    // constructs fresh on a cache miss (a different process, or this process restarted) —
    // sharing only the durable store, not any in-memory state.
    const machineA = new Orchestrator(fakeTools({ ship: async () => ((shipped = true), "shipped") }), channelA, neverClassify, store);
    const machineB = new Orchestrator(fakeTools({ ship: async () => ((shipped = true), "shipped") }), channelB, neverClassify, store);

    const proposal = await machineA.onMessage("ship it");
    expect(proposal.kind).toBe("decision");
    expect(shipped).toBe(false);

    // "yes" is handled by a DIFFERENT Orchestrator instance (machineB) — with the OLD
    // in-memory-only design this would silently reclassify "yes" as a fresh, unrelated
    // message instead of executing the previously-proposed ship.
    const confirmed = await machineB.onMessage("yes");
    expect(shipped).toBe(true);
    expect(confirmed.text).toBe("shipped");
  });

  test("declining on a different instance than the one that proposed also works, via the shared store", async () => {
    let shipped = false;
    const store = sharedStore();
    const { channel: channelA } = capture();
    const { channel: channelB } = capture();
    const machineA = new Orchestrator(fakeTools({ ship: async () => ((shipped = true), "shipped") }), channelA, neverClassify, store);
    const machineB = new Orchestrator(fakeTools({ ship: async () => ((shipped = true), "shipped") }), channelB, neverClassify, store);

    await machineA.onMessage("ship it");
    const declined = await machineB.onMessage("no");
    expect(shipped).toBe(false);
    expect(declined.text).toContain("holding off");

    // and the pending state is genuinely cleared in the shared store, not just on machineB
    expect(await store.get()).toBeNull();
  });
});

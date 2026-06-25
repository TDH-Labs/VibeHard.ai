import { describe, expect, test } from "bun:test";
import { Orchestrator, proactiveMessage, routeKeyword, type BuildTools, type Channel, type Classifier, type OutboundMessage } from "./orchestrator.ts";

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

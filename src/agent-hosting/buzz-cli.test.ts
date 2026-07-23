import { describe, expect, test } from "bun:test";
import { addChannelMember, createChannel, listChannels, runBuzz, type BuzzExec } from "./buzz-cli.ts";

const opts = (exec: BuzzExec) => ({ relayUrl: "wss://acme.communities.buzz.xyz", privateKey: () => "deadbeef", exec });

describe("runBuzz — the verified exit-code/JSON contract", () => {
  test("exit 0 + JSON stdout → ok with parsed data", () => {
    const r = runBuzz<{ name: string }[]>(
      opts(() => ({ exitCode: 0, stdout: '[{"name":"general"}]', stderr: "" })),
      ["channels", "list"],
    );
    expect(r).toEqual({ ok: true, data: [{ name: "general" }] });
  });

  test("the LIVE-observed 403 shape → kind auth with the relay's message", () => {
    // Exactly what onboarding.communities.buzz.xyz returned on 2026-07-23.
    const r = runBuzz(
      opts(() => ({ exitCode: 3, stdout: "", stderr: '{"error":"auth_error","message":"relay error 403: relay_membership_required","retryable":false}' })),
      ["channels", "list"],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("auth");
      expect(r.message).toContain("relay_membership_required");
    }
  });

  test("every documented exit code maps to its kind; unknown → other", () => {
    const kinds = [1, 2, 3, 4, 5, 42].map((exitCode) => {
      const r = runBuzz(opts(() => ({ exitCode, stdout: "", stderr: "boom" })), ["x"]);
      return r.ok ? "ok" : r.kind;
    });
    expect(kinds).toEqual(["user", "network", "auth", "other", "write-conflict", "other"]);
  });

  test("exit 0 with garbage stdout is an error, not a silent success", () => {
    const r = runBuzz(opts(() => ({ exitCode: 0, stdout: "not-json{", stderr: "" })), ["x"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("non-JSON");
  });

  test("the private key reaches the subprocess env, never argv", () => {
    let sawEnv: Record<string, string> = {};
    let sawArgv: string[] = [];
    const exec: BuzzExec = (argv, env) => {
      sawArgv = argv;
      sawEnv = env;
      return { exitCode: 0, stdout: "null", stderr: "" };
    };
    runBuzz(opts(exec), ["channels", "list"]);
    expect(sawEnv.BUZZ_PRIVATE_KEY).toBe("deadbeef");
    expect(sawEnv.BUZZ_RELAY_URL).toBe("wss://acme.communities.buzz.xyz");
    expect(sawArgv.join(" ")).not.toContain("deadbeef");
  });
});

describe("provisioning helpers build the documented argv", () => {
  const capture = () => {
    const calls: string[][] = [];
    const exec: BuzzExec = (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
    return { calls, exec };
  };

  test("createChannel defaults to a PRIVATE stream (customer data is tenant-private by default)", () => {
    const { calls, exec } = capture();
    createChannel(opts(exec), "agents-hq");
    expect(calls[0]).toEqual(["channels", "create", "--name", "agents-hq", "--type", "stream", "--visibility", "private"]);
  });

  test("listChannels / addChannelMember argv shapes", () => {
    const { calls, exec } = capture();
    listChannels(opts(exec));
    addChannelMember(opts(exec), "chan-uuid", "f".repeat(64));
    expect(calls[0]).toEqual(["channels", "list"]);
    expect(calls[1]).toEqual(["channels", "add-member", "--channel", "chan-uuid", "--pubkey", "f".repeat(64)]);
  });
});

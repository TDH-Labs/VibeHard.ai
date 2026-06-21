import { describe, expect, test } from "bun:test";
import { normalizeBoltStream, parseBoltStream, segmentToEvent } from "./normalizer.ts";

const STREAM = [
  "Sure — here's a tiny app.\n",
  '<boltArtifact id="app" title="Tiny app">',
  '<boltAction type="file" filePath="server.js">console.log(1)</boltAction>',
  '<boltAction type="file" filePath="server.js">console.log(2)</boltAction>',
  '<boltAction type="shell">npm install</boltAction>',
  '<boltAction type="start">npm run dev</boltAction>',
  "</boltArtifact>",
  "All done!",
].join("");

describe("parseBoltStream (pure)", () => {
  test("splits prose, file/shell/start actions, in order", () => {
    const segs = parseBoltStream(STREAM);
    expect(segs).toEqual([
      { kind: "text", text: "Sure — here's a tiny app.\n" },
      { kind: "file", filePath: "server.js", content: "console.log(1)" },
      { kind: "file", filePath: "server.js", content: "console.log(2)" },
      { kind: "shell", command: "npm install" },
      { kind: "start", command: "npm run dev" },
      { kind: "text", text: "All done!" },
    ]);
  });

  test("no artifact → the whole message is one text segment", () => {
    expect(parseBoltStream("just talking")).toEqual([{ kind: "text", text: "just talking" }]);
  });

  test("empty input → no segments; never throws", () => {
    expect(parseBoltStream("")).toEqual([]);
  });
});

describe("segmentToEvent (pure)", () => {
  test("first write is create, repeat write is edit", () => {
    const seen = new Set<string>();
    expect(segmentToEvent({ kind: "file", filePath: "a.ts", content: "" }, seen)).toEqual({
      type: "file-changed",
      path: "a.ts",
      action: "create",
    });
    seen.add("a.ts");
    expect(segmentToEvent({ kind: "file", filePath: "a.ts", content: "" }, seen)).toEqual({
      type: "file-changed",
      path: "a.ts",
      action: "edit",
    });
  });

  test("empty prose is dropped", () => {
    expect(segmentToEvent({ kind: "text", text: "   \n " }, new Set())).toBeNull();
  });

  test("shell/start become $-prefixed messages", () => {
    expect(segmentToEvent({ kind: "shell", command: "ls" }, new Set())).toEqual({ type: "message", text: "$ ls" });
    expect(segmentToEvent({ kind: "start", command: "run" }, new Set())).toEqual({ type: "message", text: "$ run" });
  });
});

describe("normalizeBoltStream (full pipeline)", () => {
  test("maps a whole bolt message onto our EngineEvent union, ending in done", () => {
    expect(normalizeBoltStream(STREAM)).toEqual([
      { type: "message", text: "Sure — here's a tiny app." },
      { type: "file-changed", path: "server.js", action: "create" },
      { type: "file-changed", path: "server.js", action: "edit" },
      { type: "message", text: "$ npm install" },
      { type: "message", text: "$ npm run dev" },
      { type: "message", text: "All done!" },
      { type: "done" },
    ]);
  });
});

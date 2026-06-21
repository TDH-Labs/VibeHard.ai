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

describe("parseBoltStream — multi-artifact (§14 Gap 2 regression)", () => {
  // The real bolt parser is stateful + multi-artifact. The old single-.exec parser
  // kept only the FIRST artifact and silently dropped every file after it.
  const MULTI = [
    "First, the backend.",
    '<boltArtifact id="a1" title="backend">',
    '<boltAction type="file" filePath="server.js">A</boltAction>',
    "</boltArtifact>",
    "Now the frontend.",
    '<boltArtifact id="a2" title="frontend">',
    '<boltAction type="file" filePath="index.html">B</boltAction>',
    '<boltAction type="file" filePath="app.js">C</boltAction>',
    "</boltArtifact>",
    "Done.",
  ].join("");

  test("parses ALL artifacts, in order, with prose preserved between them", () => {
    expect(parseBoltStream(MULTI)).toEqual([
      { kind: "text", text: "First, the backend." },
      { kind: "file", filePath: "server.js", content: "A" },
      { kind: "text", text: "Now the frontend." },
      { kind: "file", filePath: "index.html", content: "B" },
      { kind: "file", filePath: "app.js", content: "C" },
      { kind: "text", text: "Done." },
    ]);
  });

  test("no file from a later artifact is dropped", () => {
    const files = parseBoltStream(MULTI).filter((s) => s.kind === "file");
    expect(files.map((f) => (f.kind === "file" ? f.filePath : ""))).toEqual(["server.js", "index.html", "app.js"]);
  });

  test("tolerates an unterminated trailing artifact (partial stream)", () => {
    const partial = '<boltArtifact id="a"><boltAction type="file" filePath="x.js">X</boltAction>';
    expect(parseBoltStream(partial)).toEqual([{ kind: "file", filePath: "x.js", content: "X" }]);
  });
});

describe("parseBoltStream — supabase actions (security-critical routing)", () => {
  // bolt emits DB changes as supabase actions; the migration carries the SQL file
  // the RLS gate scans. Routing it anywhere but `file` blinds the gate.
  const SUPA = [
    '<boltArtifact id="db" title="Create users">',
    '<boltAction type="supabase" operation="migration" filePath="/supabase/migrations/create_users.sql">',
    "create table public.users (id uuid primary key);",
    "</boltAction>",
    '<boltAction type="supabase" operation="query" projectId="p1">',
    "create table public.users (id uuid primary key);",
    "</boltAction>",
    "</boltArtifact>",
  ].join("");

  test("a supabase migration becomes a FILE (materialized → RLS gate sees it)", () => {
    const segs = parseBoltStream(SUPA);
    const file = segs.find((s) => s.kind === "file");
    expect(file).toEqual({
      kind: "file",
      filePath: "/supabase/migrations/create_users.sql",
      content: "create table public.users (id uuid primary key);",
    });
  });

  test("a supabase query carries no file → surfaced as a command, not materialized", () => {
    const segs = parseBoltStream(SUPA);
    expect(segs.filter((s) => s.kind === "file")).toHaveLength(1);
    expect(segs.some((s) => s.kind === "shell")).toBe(true);
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

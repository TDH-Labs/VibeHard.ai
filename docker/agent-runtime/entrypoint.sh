#!/usr/bin/env bash
# Agent-runtime entrypoint/supervisor (AHP-4). Contract with machines.ts:
#   PACK_TGZ_B64  — base64 tar.gz of the account's persona pack
#   AGENTS_JSON   — [{name, keyEnvVar, args[], env{}}] one entry per buzz-acp process
#   AGENT_KEY_*   — per-agent Nostr secret keys, mapped to BUZZ_PRIVATE_KEY per child
#
# Supervision model (documented tradeoff of the shared tier): all agents run in one
# process group; if ANY buzz-acp exits, the whole Machine exits non-zero and Fly's
# restart policy (always) brings the full set back. Isolated-tier Machines run one
# agent each, so a crash there restarts only that agent.
set -euo pipefail

PACK_DIR="$HOME/.buzz/packs/account-pack"
WORK_ROOT="$HOME/work"

if [ -z "${AGENTS_JSON:-}" ]; then
  echo "entrypoint: AGENTS_JSON is required" >&2
  exit 64
fi

# 1) Unpack the persona pack (small by contract — machines.ts guards the size).
mkdir -p "$PACK_DIR" "$WORK_ROOT"
if [ -n "${PACK_TGZ_B64:-}" ]; then
  echo "$PACK_TGZ_B64" | base64 -d | tar -xz -C "$PACK_DIR"
fi

# 2) Spawn one buzz-acp per agent entry. Each child gets:
#    - BUZZ_PRIVATE_KEY from its own AGENT_KEY_* var (never exported globally)
#    - its own $AGENT_CWD workdir, with pack skills copied to .agents/skills/
#      (the copy step is "planned" in buzz-acp per PERSONA_PACK_SPEC §6 — we do it
#      here so skills work regardless of harness version)
#    - the pack dir itself for persona resolution
pids=()
count="$(printf '%s' "$AGENTS_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).length))')"

for i in $(seq 0 $((count - 1))); do
  spec="$(printf '%s' "$AGENTS_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify(JSON.parse(d)['"$i"'])))')"
  name="$(printf '%s' "$spec" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).name))')"
  key_var="$(printf '%s' "$spec" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).keyEnvVar))')"

  agent_cwd="$WORK_ROOT/$name"
  mkdir -p "$agent_cwd/.agents/skills"
  if [ -d "$PACK_DIR/skills" ]; then
    cp -R "$PACK_DIR/skills/." "$agent_cwd/.agents/skills/" 2>/dev/null || true
  fi

  # Child env: spec.env + mapped private key + AGENT_CWD; args from spec.args.
  # env -i style isolation is NOT used — goose/buzz need PATH/HOME — but the key
  # only ever lands in THIS child's env.
  (
    export AGENT_CWD="$agent_cwd"
    export BUZZ_PRIVATE_KEY="${!key_var:?missing $key_var}"
    while IFS='=' read -r k v; do [ -n "$k" ] && export "$k"="$v"; done < <(
      printf '%s' "$spec" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d).env||{};for(const[k,v]of Object.entries(e))console.log(`${k}=${v}`)})'
    )
    args_nl="$(printf '%s' "$spec" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log((JSON.parse(d).args||[]).join("\n")))')"
    args=()
    while IFS= read -r a; do [ -n "$a" ] && args+=("$a"); done <<< "$args_nl"
    echo "supervisor: starting buzz-acp for agent '$name' (cwd $agent_cwd)"
    exec buzz-acp "${args[@]}"
  ) &
  pids+=($!)
done

# 3) If any child exits, take the Machine down with it (Fly restarts the set).
wait -n "${pids[@]}"
code=$?
echo "supervisor: an agent process exited (code $code) — restarting the fleet" >&2
kill "${pids[@]}" 2>/dev/null || true
exit 1

# Spec: reviewer moat (backlog #3)

## Goal
Make the human-review half of the moat operable. The escalation system already
queues SCOPED packets (blocking findings + ±3-line code slices + specialty
routing) and applies reviewer decisions deterministically. What's missing is the
REVIEWER side: an SWE reviewer identity, getting NOTIFIED when work is queued,
CLAIMING a packet (routed to their specialty), reviewing the scoped slice, and
RESOLVING it. This is vibehard's differentiator — expert eyes on exactly the
risky slice, not the whole app.

## What already exists (reuse, don't rebuild)
- `EscalationPacket` / `EscalationItem` / `CodeSlice` — already scoped to blocking
  findings + line ranges + per-item `specialty` (src/escalation/packet.ts).
- `EscalationSink` (open/claim/resolve/get/list) + `LocalEscalationSink`
  (src/escalation/queue.ts); states needs-human → claimed → resolved.
- `ReviewDecision` / `waiversFromDecisions` / `applyWaivers` (src/escalation/review.ts).
- `routeFinding` → `Specialty` = security | database | reliability | general.
- `FileTenantStore` is the persistence pattern to mirror.

## What's absent (build)
1. **Reviewer identity** — who claims work, and what they're qualified for.
2. **Notification seam** — ping reviewers when a packet is queued (Slack).
3. **CLI review flow** — signup / claim / review / resolve.

## Acceptance criteria
1. `vibehard reviewer signup "<name>" [specialty…]` creates a reviewer with
   validated specialties (security|database|reliability|general; default
   general), persisted; `vibehard reviewer list` shows them.
2. `vibehard claim <ticket-id> <reviewer-id>` claims a needs-human ticket FOR a
   registered reviewer, and REFUSES if the reviewer covers none of the packet's
   specialties (the routing moat) — with a clear message. An inactive/unknown
   reviewer is refused.
3. `vibehard review <ticket-id>` prints the scoped slice (each finding + its
   file:line code slice) — exactly what the reviewer judges, nothing more.
4. `vibehard resolve <ticket-id> <approved|rejected|fixed> [justification]`
   records a decision (by the claiming reviewer) for the ticket's findings and
   moves it to resolved. `approved` requires a justification (it becomes a
   waiver); without one it's refused (never silently honored).
5. When a packet is queued (escalate, and the auto-fix hold path), a Notifier is
   fired. `slackNotifier` posts a formatted summary to a webhook; the default
   `nullNotifier` is a silent no-op so nothing breaks when no webhook is set.
6. The notifier NEVER blocks or fails the escalation (best-effort; a Slack
   outage doesn't lose the queued ticket).

## Out of scope (v1)
- Per-finding mixed verdicts in one CLI call (v1 applies one verdict to the
  ticket; the web layer can do per-finding later).
- The re-gate after resolve — that's the existing resume/applyWaivers path.
- A reviewer marketplace UI / payments (later backlog).
- Reviewer auth on the web (CLI-operator first).

## Design
- `src/reviewer/reviewer.ts`: `Reviewer` {id,name,specialties,status,createdAt};
  `FileReviewerStore` (mirror FileTenantStore); pure `parseSpecialties` (validate
  input), `matchesPacket(reviewer, packet)` (specialty intersection + active),
  `makeReviewer(name, specialties, now)`.
- `src/escalation/notify.ts`: `Notifier` {name, notifyOpened(ticket)}; pure
  `formatOpenedMessage(ticket)`; `nullNotifier`; `slackNotifier(webhookUrl, fetch?)`
  (POST, fetch injected for tests, errors swallowed).
- `src/escalation/routing.ts`: export `SPECIALTIES` + `isSpecialty` (single source).
- `src/cli.ts`: reviewer/claim/review/resolve commands; build a notifier from
  `VIBEHARD_SLACK_WEBHOOK` and fire it (best-effort) in the escalate + fix paths.

## Verify
- tsc clean; full suite green.
- Unit: parseSpecialties (valid/invalid/default), matchesPacket (match,
  no-match, inactive), FileReviewerStore (create/get/list/dup), formatOpenedMessage
  (contains blocking count + specialties + ticket id), slackNotifier (posts to the
  injected fetch; swallows a thrown fetch), nullNotifier (no-op).

## Eval / live-validate
- CLI walk-through on a real escalation: signup a reviewer → escalate a blocked
  app → claim (and confirm a mismatched-specialty reviewer is refused) → review
  the slice → resolve. Confirm the ticket moves needs-human → claimed → resolved
  and an `approved` without justification is refused.

## Adversarial review
- Fresh-context review of: the claim specialty-gate (can an unqualified reviewer
  still claim? can claim race?), the resolve justification rule (can an approve
  slip through without justification?), and the notifier's best-effort contract
  (can a Slack failure lose or block a ticket?).

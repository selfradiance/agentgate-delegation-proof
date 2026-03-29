# Delegation Identity Proof — v0.1 Design Spec (Rev.3)

**Status:** Rev.3 final — incorporating rounds 1, 2, and 3 audit findings (Gemini, Grok, ChatGPT). Ready to build pending one integration test (idle bond expiry).
**Working names:** AgentWarrant / AgentPass / Delegation Proof (final name TBD)
**Repo:** New standalone repo (not an AgentGate extension)
**Relationship to AgentGate:** Client of AgentGate — calls AgentGate REST API for identity, bonds, and settlement. Same pattern as Agents 001–006.

---

## What This Is

A proof-of-concept that demonstrates **delegated authority with economic accountability**. A human delegates bounded authority to an AI agent. Both parties post bonds. The agent acts within the delegated scope. AgentGate settles the outcome.

The missing layer this adds: existing AgentGate agents prove "I posted bond and acted." This project proves "a specific human authorized me to act, within this specific scope, and both of us have stake committed."

---

## What Problem It Solves

Today's agent identity approaches (OAuth tokens, API keys, CIBA flows) answer "is this agent authenticated?" but not "who authorized this agent to do this specific thing, and what happens if it goes wrong?"

AgentGate already makes bad actions costly. The delegation proof adds the question that comes *before* the action: who gave the agent permission, under what constraints, and with what accountability?

---

## v0.1 Scope: Single-Hop Delegation

v0.1 is deliberately minimal. One human delegates to one agent. No chains, no sub-delegation, no recursive anything. Clean, testable, and article-ready.

### What Is IN Scope

- Human-to-agent delegation (single hop)
- Bounded scope (what the agent is allowed to do)
- Dual bonds (human posts a commitment bond, agent posts an action bond)
- Delegation lifecycle with explicit state machine and closure-cause separation
- Accountability trail (who delegated what to whom, what happened, including local rejections)
- CLI tool that demonstrates the full lifecycle
- Integration tests against live AgentGate

### What Is Explicitly NOT in v0.1

- Recursive delegation (agent → sub-agent) — that's v0.2
- Permission attenuation — that's v0.2
- Delegation DAG / parent_delegation_id — that's v0.2 (added via ALTER TABLE migration)
- Human bond slashing for "reckless delegation" — deferred to v0.2 (see Dual Bond Mechanics)
- The delegation_issuance action pattern — evaluated and rejected (see Design Decisions)
- Hardware-backed identity (YubiKey/FIDO2) — future enhancement
- Web UI or dashboard — CLI only
- Multi-agent delegation (one human → many agents in one delegation) — future
- Delegation transfer or reassignment — future

---

## Design Decisions Log

### Why there is no delegation_issuance action

Rev.1 proposed that the human execute a dummy `delegation_issuance` action in AgentGate to anchor the human's bond in the action-resolution lifecycle. Rev.2 adopted this pattern. Round 2 adversarial audits revealed three fatal problems:

1. **Self-resolution forbidden.** AgentGate returns `403 SELF_RESOLUTION_FORBIDDEN` when an identity tries to resolve its own action. The delegation engine runs as the human's identity and cannot resolve the issuance action. (Found by: Gemini R2, Grok R2, ChatGPT R2 — unanimous)

2. **Sweeper griefing.** If the issuance action stays open and the bond TTL expires, AgentGate's sweeper auto-slashes it as malicious — destroying the human's reputation and bond through no fault of their own. A stalling agent can weaponize this. (Found by: Gemini R2, Grok R2)

3. **Collateral damage.** The issuance action consumes rate-limit quota, pollutes reputation history, requires an exposure_cents value that has no meaningful purpose, and creates an "article-killing" credibility problem — a fake action to hold a bond open signals that the substrate doesn't natively model delegation. (Found by: Grok R2, ChatGPT R2)

**Resolution:** The human locks an AgentGate bond with no action attached. The bond's natural TTL handles the lifecycle — funds return when the TTL expires. No dummy action, no self-resolution problem, no sweeper risk. The human's bond is a commitment deposit and Sybil-resistance stake in v0.1. True human-side slashing (requiring a properly designed resolution flow with a third-party resolver) is deferred to v0.2.

### Why closure cause is stored separately from status

Rev.2 mixed the *reason* a delegation ended (revoked, expired, exhausted, explicitly closed) with the *operational state* (pending, accepted, active, settling, completed). This created ambiguity: "expired" was sometimes a terminal state and sometimes a label applied after settlement. Round 2 audits identified this as a source of state-machine holes.

**Resolution:** Status tracks operational state only. A separate `terminal_reason` field records why the delegation ended. All settled delegations reach `completed` as their final status, regardless of whether they were revoked, expired, or exhausted. (Recommended by: ChatGPT R2)

### Why the agent posts bond upfront on accept

Two options were evaluated: upfront commitment (agent posts bond on acceptance) vs. pay-as-you-go (agent posts bond per action). Round 1 auditors split: Gemini favored pay-as-you-go (citing TTL rotation for long delegations), Grok and ChatGPT favored upfront (citing commitment signal and simplicity).

**Resolution:** Upfront for v0.1. It makes acceptance meaningful, prevents "accept and ghost" attacks, and keeps the state machine simpler. The TTL rotation issue is real but only matters for delegations longer than 24 hours — v0.1 demos should stay well within that window. Bond rotation for longer delegations is a documented v0.2 concern.

---

## Core Concepts

### The Delegation Record

```
Delegation {
  id:                          string       // unique delegation ID (UUID)
  delegator_id:                string       // human's Ed25519 public key
  delegate_id:                 string       // agent's Ed25519 public key
  scope:                       DelegationScope
  delegator_bond_id:           string       // human's bond ID in AgentGate (commitment deposit)
  delegate_bond_id:            string | null // agent's bond ID (set on acceptance)
  delegator_bond_outcome:      string | null // released / expired (set on settlement)
  delegator_bond_resolved_at:  string | null // ISO timestamp
  delegation_outcome:          string | null // success / failed / agent-malicious (computed)
  status:                      DelegationStatus
  terminal_reason:             string | null // revoked / expired / exhausted / closed (null until terminal)
  created_at:                  string       // ISO timestamp
  accepted_at:                 string | null // ISO timestamp
  expires_at:                  string       // ISO timestamp
  completed_at:                string | null // ISO timestamp (when terminal state reached)
}
```

### Delegation Scope

```
DelegationScope {
  allowed_actions:          string[]     // action type allowlist
  max_actions:              number       // maximum number of actions under this delegation
  max_exposure_cents:       number       // maximum per-action exposure in cents
  max_total_exposure_cents: number       // maximum aggregate exposure across all actions
  description:              string       // human-readable description
}
```

**Design decisions:**
- Scope is an allowlist, not a blocklist.
- `max_total_exposure_cents` caps aggregate risk across all actions.
- No resource path constraints in v0.1. Deferred to v0.2 with attenuation.
- **Scope enforcement is client-side only.** The delegation engine validates scope before calling AgentGate, but AgentGate itself does not know about scope. A malicious agent with direct API access could bypass the CLI and act outside scope. This is a known architectural limitation of the "AgentGate stays unaware" design. Server-side scope enforcement is a v0.2 concern. (Found by: Grok R2, ChatGPT R2)

### Capacity Math Alignment

AgentGate calculates effective exposure as `ceil(declared_exposure × 1.2)`. The delegation engine's scope validator **must replicate this math** when checking whether an action fits within `max_total_exposure_cents`. Without this, the local validator will approve actions that AgentGate rejects with `INSUFFICIENT_BOND_CAPACITY`.

Example: Agent declares 100¢ exposure. AgentGate treats this as 120¢ effective. The scope validator must track 120¢ against the total exposure ceiling, not 100¢. (Found by: Gemini R2)

### Delegation Status (State Machine)

Status tracks **operational state only**. The reason for reaching a terminal state is stored in `terminal_reason`.

**Six operational states:**

| Status | Meaning | Entry condition |
|---|---|---|
| `pending` | Human created delegation, waiting for agent | Delegation created, human bond locked |
| `accepted` | Agent accepted and posted bond, no actions yet | Agent calls accept, posts bond |
| `active` | At least one action executed under this delegation | First successful execute_bonded_action |
| `settling` | No new actions allowed, open actions still resolving | Expiry or revocation while actions are open |
| `completed` | Terminal. All obligations resolved. | All actions resolved, or no actions existed |
| `failed` | Terminal. System-level failure prevented completion. | Unrecoverable error (optional, for robustness) |

**Terminal reason** (set when entering a terminal state):

| Reason | Meaning |
|---|---|
| `exhausted` | All max_actions used and resolved |
| `closed` | Human explicitly closed the delegation (all actions resolved) |
| `revoked` | Human revoked the delegation |
| `expired` | Delegation passed expires_at |

### State Transitions

| From | To | Trigger | Guard | Side effects |
|---|---|---|---|---|
| `pending` | `accepted` | Agent accepts + posts bond | status = pending, delegation not expired | `accepted_at` set, `delegate_bond_id` recorded |
| `pending` | `completed` | Human revokes before acceptance | status = pending | `terminal_reason` = revoked, human bond TTL handles release |
| `pending` | `completed` | `expires_at` reached | status = pending | `terminal_reason` = expired |
| `accepted` | `active` | Agent executes first action within scope | status = accepted, `now < expires_at` | Action recorded in delegation_actions |
| `accepted` | `completed` | Human revokes after acceptance, no actions | status = accepted | `terminal_reason` = revoked, both bonds released via TTL |
| `accepted` | `completed` | `expires_at` reached, no actions | status = accepted | `terminal_reason` = expired |
| `active` | `active` | Agent executes additional action within scope | status = active, `now < expires_at`, actions < max_actions, total exposure < max_total | Action recorded |
| `active` | `settling` | Expiry or revocation while actions are open | status = active, open actions > 0 | No new actions. `terminal_reason` set (revoked or expired). |
| `active` | `completed` | All max_actions resolved | status = active, open actions = 0 | `terminal_reason` = exhausted, `delegation_outcome` computed |
| `active` | `completed` | Human explicitly closes, zero open actions | status = active, open actions = 0 | `terminal_reason` = closed, `delegation_outcome` computed |
| `active` | `completed` | Human revokes, zero open actions | status = active, open actions = 0 | `terminal_reason` = revoked, `delegation_outcome` computed |
| `active` | `completed` | `expires_at` reached, zero open actions | status = active, open actions = 0 | `terminal_reason` = expired, `delegation_outcome` computed |
| `settling` | `completed` | All remaining open actions resolved | open actions = 0 | `delegation_outcome` computed |

**Guard clauses (invalid transitions — enforce in code):**
- Cannot accept if status ≠ pending
- Cannot accept if `now ≥ expires_at`
- Cannot act if status ∉ {accepted, active}
- Cannot act if `now ≥ expires_at` (check inside critical section immediately before AgentGate call)
- Cannot act if actions_taken ≥ max_actions
- Cannot act if total_effective_exposure + ceil(new_exposure × 1.2) > max_total_exposure_cents
- Cannot revoke if status ∈ {completed, failed}
- Cannot double-accept, double-revoke, or double-complete

### Transaction Isolation

State mutations use a **two-phase local state** pattern. The critical rule: **never hold a SQLite write lock across an HTTP call to AgentGate.** Holding `BEGIN IMMEDIATE` open during a network round-trip blocks all other writes and creates brittle crash recovery. (Found by: ChatGPT R3)

Instead, use short transactions on each side of the HTTP call:

**Accept path (two-phase):**
```
Phase 1 — Claim (short transaction):
  BEGIN IMMEDIATE;
  UPDATE delegations SET status = 'accepting'
    WHERE id = ? AND status = 'pending';
  -- check rows affected = 1, else abort (someone else got there first)
  COMMIT;

Phase 2 — External call:
  POST lock_bond to AgentGate (agent's bond)

Phase 3 — Finalize (short transaction):
  IF AgentGate succeeded:
    BEGIN IMMEDIATE;
    UPDATE delegations SET status = 'accepted', accepted_at = ?, delegate_bond_id = ?
      WHERE id = ? AND status = 'accepting';
    COMMIT;
  ELSE:
    BEGIN IMMEDIATE;
    UPDATE delegations SET status = 'pending'
      WHERE id = ? AND status = 'accepting';
    COMMIT;
```

**Act path (two-phase):**
```
Phase 1 — Validate and reserve (short transaction):
  BEGIN IMMEDIATE;
  Check now < expires_at
  Validate scope (action type, count, exposure with 1.2× multiplier)
  INSERT delegation_action with status 'pending'
  COMMIT;

Phase 2 — External call:
  POST execute_bonded_action to AgentGate

Phase 3 — Finalize (short transaction):
  IF AgentGate succeeded:
    BEGIN IMMEDIATE;
    UPDATE delegation_action SET agentgate_action_id = ?
      WHERE id = ? AND status = 'pending';
    UPDATE delegations SET status = 'active'
      WHERE id = ? AND status IN ('accepted', 'active');
    COMMIT;
  ELSE:
    BEGIN IMMEDIATE;
    DELETE FROM delegation_actions WHERE id = ? AND status = 'pending';
    COMMIT;
```

**Transient states:** `accepting` (for accept path) is a transient claim state visible only during the HTTP call window. If the process crashes between phase 1 and phase 3, a startup recovery sweep should revert any `accepting` rows back to `pending`.

This prevents concurrent accept/revoke races, double-accept with stranded bonds, and stale-expiry action leaks — without holding write locks across the network. (Originally recommended by: Grok R2, ChatGPT R2; two-phase pattern from: ChatGPT R3)

### Aggregate Delegation Outcome

When a delegation reaches `completed`, the `delegation_outcome` is computed deterministically from the delegation_actions:

| Action outcomes | Delegation outcome |
|---|---|
| All actions resolved `success` | `success` |
| Any action resolved `malicious` | `agent-malicious` |
| Any action resolved `failed`, none `malicious` | `failed` |
| No actions taken (revoked/expired before any actions) | `none` |

This is a computed value, not a judgment call. The resolver resolves individual actions; the delegation engine computes the aggregate. (Recommended by: ChatGPT R2)

### Dual Bond Mechanics

Both parties post bonds. The human's bond is a **commitment deposit**; the agent's bond is **fully at risk**.

**Human's delegation bond:**
- Locked when the human creates the delegation (no action attached)
- Bond TTL should exceed the delegation's expires_at by a comfortable margin
- **Idle bond expiry behavior: UNVERIFIED.** The spec assumes that an idle bond (no action attached) releases its funds when the TTL expires. AgentGate's documented bond lifecycle is `active → occupied → released / burned / slashed`, and the sweeper only targets open *actions* on expired bonds — not idle bonds. An idle bond is safe from the sweeper, but whether AgentGate has an explicit idle-bond release path (returning the bond to `released` status and freeing funds) must be confirmed by integration test before this assumption is cemented. If AgentGate does not expose this path, the design will need an explicit release mechanism (e.g., a new endpoint, or the human accepting that the bond simply sits until manually addressed). **This is the first integration test to write.** (Found by: ChatGPT R3)
- **Not slashable in v0.1.** No action is attached, so the sweeper cannot touch it. The bond proves the human has committed capital and is not creating frivolous delegations.
- **v0.2: proper slashing.** A third-party resolver flow will be designed to enable human bond slashing for recklessly scoped delegations. This requires solving the self-resolution problem with a dedicated resolver identity.

**Agent's action bond:**
- Posted when the agent accepts the delegation (upfront commitment)
- Standard AgentGate bond — same mechanics as every other agent project
- Slashed if the agent acts maliciously within the delegated scope
- Released when actions resolve successfully
- **Known limitation:** AgentGate bonds have a 24-hour max TTL. v0.1 delegations should stay within that window. Bond rotation for longer delegations is a v0.2 concern.

**v0.1 bond outcomes:**

| Scenario | Human bond | Agent bond |
|---|---|---|
| All actions succeeded | Released (TTL — see note) | Released |
| Agent acted maliciously within scope | Released (TTL — see note) | Slashed |
| Agent acted outside scope (caught locally) | Released (TTL — see note) | N/A (action never reached AgentGate) |
| Human revoked, no actions | Released (TTL — see note) | Released (TTL — see note) |
| Delegation expired, no actions | Released (TTL — see note) | Released (TTL — see note) |
| Delegation expired, actions settling | Released (TTL — see note) | Per-action outcomes |

**Note:** "Released (TTL)" means the bond has no action attached and the spec assumes funds return when the TTL expires. This idle-bond expiry behavior is UNVERIFIED against AgentGate and is the first integration test to run.

### Resolution: Who Resolves?

- **Agent actions** are resolved by a third-party resolver identity, same as every other AgentGate agent. The resolver sees the action payload (which includes delegation metadata) for context.
- **The human's bond** has no action attached and requires no resolution. The spec assumes it releases when the TTL expires, but this must be confirmed by integration test (see Assumptions).
- **Delegation outcome** is computed deterministically by the delegation engine from action outcomes. No resolver judgment on the delegation itself.

---

## Architecture

```
┌──────────────────────────────────┐
│  Human (CLI)                     │  ← Creates delegation, locks bond (no action)
├──────────────────────────────────┤
│  Delegation Engine               │  ← Manages delegation records, state machine,
│  (src/delegation.ts)             │     lifecycle transitions, outcome computation
├──────────────────────────────────┤
│  Agent (CLI or automated)        │  ← Accepts delegation, posts bond, acts within scope
├──────────────────────────────────┤
│  Scope Validator                 │  ← Checks scope with AgentGate-aligned capacity math.
│  (src/scope.ts)                  │     Logs rejections to events table.
├──────────────────────────────────┤
│  AgentGate Client                │  ← Existing pattern: identity, bond, execute,
│  (src/agentgate-client.ts)       │     resolve with Ed25519 signing
├──────────────────────────────────┤
│  AgentGate Server (external)     │  ← Running separately — handles bonds and settlement
└──────────────────────────────────┘
```

**Architectural constraint:** AgentGate remains semantically unaware of delegations. The delegation layer is client-side governance.

**Auditability convention:** Every action executed under a delegation embeds a metadata block in the AgentGate action payload:
```json
{
  "delegation_id": "...",
  "delegator_id": "...",
  "scope_hash": "..."
}
```
This is a **convention, not enforcement**. AgentGate stores it as opaque payload and never parses it. A malicious agent with direct API access can omit or forge this metadata. The local delegation_events table is the authoritative audit trail. The payload convention provides a secondary cross-reference for anyone querying AgentGate's database directly. (Limitation documented per: Grok R2, ChatGPT R2)

---

## Lifecycle: The Happy Path

1. **Human registers identity** in AgentGate (or loads existing)
2. **Human creates a delegation:**
   - Defines scope (allowed actions, max count, max per-action exposure, max total exposure)
   - Locks a bond in AgentGate (commitment deposit, no action attached)
   - Delegation record created locally with status `pending`
   - Event logged: `delegation_created`
3. **Agent registers identity** in AgentGate (or loads existing)
4. **Agent accepts the delegation:**
   - Local atomic claim: status → `accepted` (BEGIN IMMEDIATE, compare-and-swap)
   - Agent posts its own bond to AgentGate
   - If bond posting fails, local claim rolled back
   - `accepted_at` set, `delegate_bond_id` recorded
   - Event logged: `delegation_accepted`
5. **Agent acts within scope:**
   - Check `now < expires_at` inside critical section
   - Scope validator checks: action type allowed? Action count < max_actions? Per-action exposure within limit? Total effective exposure (using 1.2× multiplier) within max_total_exposure_cents?
   - If valid → record action locally → call AgentGate execute_bonded_action with delegation metadata in payload → if AgentGate fails, roll back local record. Status moves to `active` on first action.
   - If out of scope → action rejected locally, never reaches AgentGate. Event logged: `action_rejected_scope` with reason.
6. **Resolver resolves each action** via AgentGate (success / failed / malicious)
   - Outcome recorded in delegation_actions
   - Event logged: `action_resolved`
7. **Delegation reaches terminal state:**
   - `delegation_outcome` computed from aggregate action outcomes
   - `terminal_reason` set (exhausted / closed / revoked / expired)
   - Status → `completed`
   - Human bond releases when its TTL expires (no action to resolve)
   - Event logged: `delegation_completed` with outcome and reason

---

## Data Storage

Local SQLite database, separate from AgentGate's database.

### Tables

**delegations**

| Column | Type | Description |
|---|---|---|
| id | TEXT PRIMARY KEY | UUID |
| delegator_id | TEXT NOT NULL | Human's public key |
| delegate_id | TEXT NOT NULL | Agent's public key |
| scope_json | TEXT NOT NULL | JSON-serialized DelegationScope |
| delegator_bond_id | TEXT NOT NULL | Human's bond in AgentGate |
| delegate_bond_id | TEXT | Agent's bond (null until accepted) |
| delegator_bond_outcome | TEXT | released / expired (null until settled) |
| delegator_bond_resolved_at | TEXT | ISO timestamp (null until settled) |
| delegation_outcome | TEXT | success / failed / agent-malicious / none (null until computed) |
| status | TEXT NOT NULL | pending / accepted / active / settling / completed / failed |
| terminal_reason | TEXT | revoked / expired / exhausted / closed (null until terminal) |
| created_at | TEXT NOT NULL | ISO timestamp |
| accepted_at | TEXT | ISO timestamp |
| expires_at | TEXT NOT NULL | ISO timestamp |
| completed_at | TEXT | ISO timestamp |

**delegation_actions**

| Column | Type | Description |
|---|---|---|
| id | TEXT PRIMARY KEY | UUID |
| delegation_id | TEXT NOT NULL | FK to delegations |
| agentgate_action_id | TEXT NOT NULL | Action ID from AgentGate |
| action_type | TEXT NOT NULL | Action type string |
| declared_exposure_cents | INTEGER NOT NULL | Declared exposure |
| effective_exposure_cents | INTEGER NOT NULL | ceil(declared × 1.2) — for tracking against total cap |
| outcome | TEXT | success / failed / malicious (null until resolved) |
| created_at | TEXT NOT NULL | ISO timestamp |
| resolved_at | TEXT | ISO timestamp |

**delegation_events**

| Column | Type | Description |
|---|---|---|
| id | TEXT PRIMARY KEY | UUID |
| delegation_id | TEXT NOT NULL | FK to delegations |
| event_type | TEXT NOT NULL | See event types below |
| detail_json | TEXT | Optional JSON with event-specific data |
| created_at | TEXT NOT NULL | ISO timestamp |

**Event types:**
- `delegation_created` — human created the delegation
- `delegation_accepted` — agent accepted
- `delegation_revoked` — human revoked
- `delegation_expired` — clock expiry triggered
- `delegation_completed` — terminal settlement computed (detail: outcome, reason)
- `action_executed` — agent executed an action within scope
- `action_rejected_scope` — agent attempted an action outside scope (detail: reason)
- `action_rejected_expired` — agent attempted an action after expiry (detail: attempted action)
- `action_rejected_rate_limited` — AgentGate returned 429 (does NOT decrement max_actions)
- `action_resolved` — resolver resolved an action (detail: outcome)

---

## CLI Interface

All bond amounts are Tier 1-compatible (100¢ cap for new identities).

```bash
# Human side: create a delegation
npx tsx src/cli.ts delegate \
  --to <agent-public-key> \
  --actions email-rewrite,file-transform \
  --max-actions 3 \
  --max-exposure 83 \
  --max-total-exposure 250 \
  --bond 100 \
  --ttl 3600 \
  --description "Rewrite up to 3 emails, max 83 cents exposure each"

# Agent side: accept a delegation
npx tsx src/cli.ts accept --delegation <delegation-id> --bond 100

# Agent side: act under delegation
npx tsx src/cli.ts act \
  --delegation <delegation-id> \
  --action-type email-rewrite \
  --exposure 83 \
  --payload '{"file": "draft.txt", "instruction": "make it formal"}'

# Resolver side: resolve an action
npx tsx src/cli.ts resolve --action <action-id> --outcome success

# Human side: revoke a delegation
npx tsx src/cli.ts revoke --delegation <delegation-id>

# Human side: explicitly close a completed delegation
npx tsx src/cli.ts close --delegation <delegation-id>

# Anyone: view delegation status, actions, and full event trail
npx tsx src/cli.ts status --delegation <delegation-id>
```

---

## Tech Stack

Same as every prior agent project:
- TypeScript, Node.js 20+, tsx
- Vitest for testing
- Zod for validation
- better-sqlite3 for local delegation storage
- Ed25519 signing via AgentGate client pattern
- AgentGate REST API (local: http://127.0.0.1:3000, remote: https://agentgate.run)

---

## What "Done" Looks Like for v0.1

1. Delegation record CRUD with Zod-validated scope (including max_total_exposure_cents)
2. State machine with 6 operational states, terminal_reason separation, and guard clauses
3. Transaction isolation (BEGIN IMMEDIATE + compare-and-swap) on all state mutations
4. Human bond locked with no action (commitment deposit, released via TTL)
5. Agent bond posted upfront on accept
6. Scope validation with AgentGate-aligned capacity math (1.2× multiplier)
7. Full lifecycle: create → accept → act → resolve → complete
8. Revocation path with settling state for open actions
9. Expiry path with expires_at check in critical section
10. Aggregate delegation outcome computed deterministically
11. Accountability trail: CLI `status` shows delegation + actions + events
12. Delegation metadata embedded in AgentGate action payloads (convention)
13. Out-of-scope rejections logged in delegation_events
14. 429 rate-limit responses handled without decrementing max_actions
15. Unit tests for scope validation, state machine, guard clauses, capacity math, edge cases
16. Integration tests against live AgentGate
17. README, AGENTS.md, LICENSE (MIT), .gitignore, project context file
18. Tagged v0.1.0 release

---

## Known Limitations (v0.1)

1. **Human bond is not slashable.** No action is attached to the human's bond. It is a commitment deposit that releases via TTL. True human accountability (with a properly designed third-party resolver flow) is deferred to v0.2.

2. **Scope enforcement is client-side only.** AgentGate does not know about delegation scope. A malicious agent with direct API access can bypass the CLI and act outside scope. Actions are still bonded and resolvable, but the scope gate is local governance, not substrate enforcement.

3. **Payload convention is unenforceable.** The delegation_id embedded in AgentGate action payloads is a convention. A malicious agent can omit or forge it. The local delegation_events table is the authoritative audit trail.

4. **Bond TTL ceiling.** AgentGate caps bond TTL at 24 hours. v0.1 delegations should stay within that window. Bond rotation is a v0.2 concern.

5. **Human grief-revoke.** A malicious human can create delegations and immediately revoke after the agent posts a bond, wasting the agent's bond time. Both bonds release, but the agent loses opportunity cost. A grace period or creation rate limit is a v0.2 defense.

6. **Reputation laundering.** The delegation layer does not add extra anti-farming controls. AgentGate's existing distinct-resolver and minimum-exposure rules are the reputation defense. The article should not claim delegation provides stronger reputation guarantees.

7. **Out-of-scope probing.** A malicious agent can repeatedly attempt out-of-scope actions with no AgentGate-level consequence (rejections are local). The events table records attempts; auto-revocation after N rejections is a possible v0.2 feature.

---

## Article Framing Guidance

The article must be honest about what v0.1 proves and what it doesn't.

**What v0.1 proves:**
- A human can delegate bounded authority to an agent with a cryptographic audit trail
- The agent's actions are economically accountable (bond at risk, slashable on malicious behavior)
- The delegation scope is enforced client-side with full event logging
- The human commits capital to the delegation (Sybil resistance, anti-frivolous commitment)

**What v0.1 does NOT prove (yet):**
- Mutual economic accountability — the human's bond is a deposit, not a slashable stake
- Server-side scope enforcement — scope is local governance only
- Recursive delegation or chain-of-custody — that's v0.2

**Recommended framing:** "In v0.1, the agent's bond is fully at risk. The human posts a commitment deposit. The mechanism for human-side slashing exists in the architecture but is not exercised until v0.2, when structured review criteria and a third-party resolver flow are designed." Honesty about limitations is the better article strategy.

---

## v0.2 Preview (Not In Scope)

v0.2 introduces recursive delegation and human accountability:

- **parent_delegation_id** added via ALTER TABLE migration — enables delegation chains
- **Permission attenuation** — sub-delegation scope must be ≤ parent scope
- **Delegation DAG** — every action traceable to root human delegator
- **Human bond slashing** — dedicated resolver identity, structured criteria for reckless scope
- **Bond rotation** — agent can rotate expired bonds during long-running delegations
- **Resource constraints** — optional structured scope object for path patterns, object IDs
- **Server-side scope enforcement** — delegation awareness pushed into AgentGate (or a proxy)
- **Grace period on revocation** — prevents human grief-revoke attacks
- **Auto-revocation on repeated scope violations** — defense against out-of-scope probing

---

## Assumptions

| Assumption | Status | Risk |
|---|---|---|
| AgentGate's existing API is sufficient — no new endpoints needed | VERIFIED — human bond uses lock_bond only, agent uses standard execute/resolve | LOW |
| Human bond with no action is safe from the sweeper | VERIFIED — sweeper targets open actions on expired bonds; no action = no target | LOW |
| Idle bond expiry releases funds automatically | **UNVERIFIED** — AgentGate's documented lifecycle doesn't explicitly cover idle bond TTL expiry behavior. **First integration test to write.** If AgentGate does not release idle bonds, the design needs an explicit release mechanism. | **HIGH** |
| Local SQLite is fine for delegation storage | VERIFIED — same pattern as AgentGate | LOW |
| Ed25519 identity model works for both human and agent | VERIFIED — every prior agent uses this | LOW |
| Bond TTL of ≤24h is sufficient for v0.1 demo delegations | VERIFIED — CLI demo uses --ttl 3600 (1 hour) | LOW |
| Two-phase local state (short transactions around HTTP calls) prevents races | VERIFIED — standard pattern for SQLite + external service coordination | LOW |
| Scope validator replicating ceil(exposure × 1.2) matches AgentGate's math | UNVERIFIED — needs integration test confirmation | LOW |
| The 6-state machine with terminal_reason separation covers all real v0.1 cases | UNVERIFIED — needs implementation stress-testing | MEDIUM |

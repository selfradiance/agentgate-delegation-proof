# Delegation Identity Proof

A proof-of-concept for bounded human-to-agent delegation with economic accountability. A human delegates scoped authority to an agent, both parties post bonds, and actions are settled through AgentGate.

v0.2.0 adds a narrow server-mediated scope-enforcement path for delegated actions. The local delegation system only recognizes, accounts for, and bounds delegated actions that pass through this repo's checkpoint. Direct AgentGate calls outside that checkpoint are outside delegation accounting. AgentGate itself remains semantically unchanged.

## Why This Exists

Current agent identity systems answer "who is this agent?" but not "who authorized it, to do what, within what limits, and with what accountability?" Delegation Identity Proof fills that gap. The human has skin in the game too — not just the agent.

## What v0.2 Proves

- Delegated actions are only recognized, accounted for, and bounded when they pass through the local checkpoint in this repo.
- The checkpoint enforces delegation existence, delegate binding, request freshness, allowed action type, per-action exposure, total exposure, and max-actions limits before forwarding anything to AgentGate.
- Direct AgentGate calls outside the checkpoint are outside the delegation system's accounting and are not treated as delegated in-scope actions.
- AgentGate remains unchanged. The delegation checkpoint is a sidecar layer in this repo, not a change to AgentGate core semantics.

## Server-Mediated Scope Enforcement

```text
delegate request
  -> checkpoint in this repo
     -> validate + authenticate
     -> enforce delegated scope + local accounting
     -> reserve locally
     -> forward to AgentGate execute
     -> attach returned agentgate_action_id
     -> later resolve through AgentGate
     -> finalize locally

direct AgentGate call
  -> AgentGate only
  -> outside delegation accounting in this repo
```

## How It Relates to AgentGate

[AgentGate](https://github.com/selfradiance/agentgate) is the enforcement substrate. This project calls AgentGate's REST API for identity registration, bond management, action execution, and resolution. No changes to AgentGate core were needed — this is a client, not an extension.

AgentGate must be running for this project to work.

## Proof Path

1. `POST /v1/delegations/:id/execute`
   Validates and authenticates the delegated request, enforces local delegated scope, creates a local reservation, starts the forward attempt, performs the real AgentGate execute call, attaches the returned `agentgate_action_id`, and returns either a `forwarded` result or a narrow pre-attachment failure.
2. `POST /v1/delegations/:id/actions/:reservationId/finalize`
   Accepts only `success` or `failed`, requires a forwarded and attached checkpoint reservation, resolves through AgentGate, lands in the local finalize seam, and returns either a `finalized` result or a narrow resolution failure.

## What You Should See

- An in-scope delegated action reaches `stage: "forwarded"` and carries both a local `reservationId` and an attached `agentgateActionId`.
- The explicit finalize step reaches `stage: "finalized"` with `outcome: "success"` or `outcome: "failed"`.
- A disallowed action type is rejected before any AgentGate execute call.
- An exposure-limit violation is rejected before any AgentGate execute call.
- A pre-attachment AgentGate execute failure returns a machine-readable failure and lands in the local pre-attachment failure seam.

## What's Implemented

- 6-state machine: pending → accepted → active → settling → completed (+ failed)
- Terminal reason separation: exhausted, closed, revoked, expired
- Two-phase transaction pattern (no SQLite locks across HTTP calls)
- Zod-validated delegation scope with capacity math
- Dual bond mechanics (human commitment deposit + agent action bond)
- CLI with 7 commands: delegate, accept, act, resolve, revoke, close, status
- Ed25519 signed requests for human, agent, and resolver roles
- Bond TTL alignment (human bond = delegation TTL + 1hr margin)
- Auto-complete on scope exhaustion
- Crash recovery for orphaned action reservations
- Checkpoint execute endpoint: `POST /v1/delegations/:id/execute`
- Checkpoint finalize endpoint: `POST /v1/delegations/:id/actions/:reservationId/finalize`
- Real AgentGate execute handoff plus explicit AgentGate resolution bridge for checkpoint-managed actions
- Narrow local seams for reservation, forward start, attachment, pre-attachment failure, and finalization

## Quick Start

```bash
# 1. Start AgentGate
cd ~/Desktop/projects/agentgate && npm run restart

# 2. Run Delegation Proof
cd ~/Desktop/projects/delegation-identity-proof
cp .env.example .env  # add AGENTGATE_REST_KEY
npm install

# Create a delegation
npx tsx src/cli.ts delegate --max-actions 5 --max-exposure 500 --ttl 3600

# Agent accepts
npx tsx src/cli.ts accept --delegation-id <id>

# Agent acts
npx tsx src/cli.ts act --delegation-id <id> --action "file-transform" --exposure 100

# Check status
npx tsx src/cli.ts status --delegation-id <id>
```

## Non-Goals / Limits

- The checkpoint does not globally block all direct AgentGate calls. Calls made outside it are simply outside delegation accounting in this repo.
- AgentGate does not understand delegation scope. It still sees normal execute and resolve calls.
- No retries, queues, background workers, or broader orchestration.
- No recursive chain-of-custody.
- No transparency log, generalized authorization framework, or UI.
- Human bond remains a commitment deposit rather than a slashable delegation stake.

## Tests

183 tests across 8 files. 3 integration tests (opt-in via `RUN_INTEGRATION_TESTS=1`, requires live AgentGate).

```bash
npm test
```

## Related Projects

- [AgentGate](https://github.com/selfradiance/agentgate) — the core execution engine
- [MCP Firewall](https://github.com/selfradiance/agentgate-mcp-firewall) — governance proxy for MCP tool calls

## Status

v0.1.0 shipped and credible. v0.2.0 now proves a narrow server-mediated delegated execution path with explicit execute and finalize checkpoint entrypoints. 183 tests.

Design note: [v0.2 server-mediated scope enforcement](docs/v0.2-server-mediated-scope-enforcement.md).

## License

MIT

# Agent Instructions

## Files That Must Never Be Committed

- `.env` (contains API keys)
- Any `*_PROJECT_CONTEXT.md` (private project context)
- Any `agent-identity*.json` (contains private keys)

## Git Rules

- Never use `git add .`, `git add -A`, or `git add -f`
- Always stage files explicitly by name
- Confirm `.gitignore` is correct before every commit

## Workflow

- Read the project context file before making changes
- Make small, focused diffs — one concern per change
- Keep diffs under ~100 lines per change. If a change exceeds 300 lines, stop and break it into smaller pieces before proceeding.
- Run ALL tests after every change
- Commit with a clear message and push immediately
- If tests fail, fix them before doing anything else

### Slicing Strategies

- **Vertical slice:** implement one complete feature top to bottom (route, logic, test) before starting another
- **Risk-first slice:** tackle the riskiest or most uncertain piece first to surface problems early
- **Contract-first slice:** define the API contract or interface first, then implement behind it

## Anti-Rationalization

| Excuse | Rebuttal |
|--------|----------|
| "I'll add tests later" | Tests are not optional. Write them now. |
| "It's just a prototype" | Prototypes become production. Build it right. |
| "This change is too small to break anything" | Small changes cause subtle bugs. Run the tests. |
| "I already know this works" | You don't. Verify it. |
| "Cleaning up this adjacent code will save time" | Stay in scope. File it for later. |
| "The user probably meant X" | Don't assume. Ask. |
| "Skipping the audit since it's straightforward" | Straightforward changes still need verification. |
| "I'll commit everything at the end" | Commit after each verified change. No batching. |

## Tech Stack

- TypeScript, Node.js 20+, tsx
- Vitest for testing
- Zod for validation
- better-sqlite3 for local delegation storage
- Ed25519 signing via AgentGate client pattern
- AgentGate REST API (local: http://127.0.0.1:3000)

## Architecture

This project is a client of AgentGate. AgentGate remains semantically unaware of delegations. The delegation layer is client-side governance.

See DELEGATION_IDENTITY_PROOF_v0.1_SPEC_REV3.md for the authoritative design spec.

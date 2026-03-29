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
- Run ALL tests after every change
- Commit with a clear message and push immediately
- If tests fail, fix them before doing anything else

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

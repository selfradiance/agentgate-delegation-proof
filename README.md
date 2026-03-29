# Delegation Identity Proof

A proof-of-concept demonstrating delegated authority with economic accountability. A human delegates bounded authority to an AI agent. Both parties post bonds. The agent acts within the delegated scope. AgentGate settles the outcome.

## What Problem It Solves

Today's agent identity approaches (OAuth tokens, API keys, CIBA flows) answer "is this agent authenticated?" but not "who authorized this agent to do this specific thing, and what happens if it goes wrong?"

AgentGate already makes bad actions costly. The delegation proof adds the question that comes *before* the action: who gave the agent permission, under what constraints, and with what accountability?

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your AGENTGATE_REST_KEY

# Run tests
npm test

# Run the CLI
npx tsx src/cli.ts --help
```

## Tech Stack

- TypeScript, Node.js 20+, tsx
- Vitest for testing
- Zod for validation
- better-sqlite3 for local SQLite storage
- Ed25519 signing via AgentGate client pattern
- AgentGate REST API

## License

MIT

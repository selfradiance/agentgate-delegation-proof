import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../src/db";
import {
  claimForAccept,
  closeDelegation,
  createDelegation,
  finalizeAccept,
  finalizeAction,
  reserveAction,
  resolveAction,
  revokeDelegation,
} from "../src/delegation";
import { TRANSPARENCY_LOG_HASH_VERSION_1 } from "../src/transparency-log-canonical";
import { computeTransparencyLogEntryHashV1 } from "../src/transparency-log-hash";
import {
  appendTransparencyLogRow,
  verifyTransparencyLog,
} from "../src/transparency-log";

const TEST_SCOPE = {
  allowed_actions: ["email-rewrite"],
  max_actions: 3,
  max_exposure_cents: 83,
  max_total_exposure_cents: 300,
  description: "Test delegation scope",
};

function insertDelegation(delegationId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();

  db.prepare(
    `INSERT INTO delegations (id, delegator_id, delegate_id, scope_json, delegator_bond_id, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    delegationId,
    "delegator-pub-key",
    "delegate-pub-key",
    '{"allowed_actions":["email-rewrite"]}',
    "bond-123",
    "pending",
    now,
    expiresAt
  );
}

function makeTestDelegation() {
  return createDelegation({
    delegatorId: "delegator-pub-key",
    delegateId: "delegate-pub-key",
    scope: TEST_SCOPE,
    delegatorBondId: "bond-123",
    ttlSeconds: 3600,
  });
}

function insertLegacyTransparencyRow(params: {
  delegationId: string;
  createdAt: string;
  eventType:
    | "delegation_created"
    | "delegation_accepted"
    | "delegation_revoked"
    | "delegation_closed";
  actorKind: "delegator" | "delegate";
}): void {
  getDb()
    .prepare(
      `INSERT INTO delegation_transparency_log
       (id, delegation_id, reservation_id, event_type, actor_kind, agentgate_action_id, outcome, reason_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `${params.delegationId}-${params.eventType}-${params.createdAt}`,
      params.delegationId,
      null,
      params.eventType,
      params.actorKind,
      null,
      null,
      null,
      params.createdAt
    );
}

beforeEach(() => {
  process.env.DELEGATION_DB_PATH = ":memory:";
});

afterEach(() => {
  closeDb();
  delete process.env.DELEGATION_DB_PATH;
});

describe("transparency log", () => {
  it("appends one valid row", () => {
    insertDelegation("delegation-1");

    const row = appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_created",
      actorKind: "delegator",
    });

    const db = getDb();
    const stored = db
      .prepare("SELECT * FROM delegation_transparency_log WHERE id = ?")
      .get(row.id) as Record<string, unknown>;

    expect(stored).toMatchObject({
      id: row.id,
      delegation_id: "delegation-1",
      reservation_id: null,
      event_type: "delegation_created",
      actor_kind: "delegator",
      agentgate_action_id: null,
      outcome: null,
      reason_code: null,
      created_at: row.created_at,
      prev_hash: null,
      entry_hash: row.entry_hash,
      hash_version: TRANSPARENCY_LOG_HASH_VERSION_1,
    });
  });

  it("rejects unsupported event_type", () => {
    insertDelegation("delegation-1");

    expect(() =>
      appendTransparencyLogRow({
        delegationId: "delegation-1",
        eventType: "not_allowed" as never,
        actorKind: "checkpoint",
      })
    ).toThrow("Unsupported transparency log event_type: not_allowed");
  });

  it("rejects unsupported actor_kind", () => {
    insertDelegation("delegation-1");

    expect(() =>
      appendTransparencyLogRow({
        delegationId: "delegation-1",
        eventType: "checkpoint_action_reserved",
        actorKind: "operator" as never,
      })
    ).toThrow("Unsupported transparency log actor_kind: operator");
  });

  it("appending a second row leaves the first row untouched", () => {
    insertDelegation("delegation-1");

    const firstRow = appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_created",
      actorKind: "delegator",
    });

    const db = getDb();
    const firstStoredBefore = db
      .prepare("SELECT * FROM delegation_transparency_log WHERE id = ?")
      .get(firstRow.id) as Record<string, unknown>;

    appendTransparencyLogRow({
      delegationId: "delegation-1",
      reservationId: "reservation-1",
      eventType: "checkpoint_action_reserved",
      actorKind: "checkpoint",
      reasonCode: "policy_checked",
    });

    const firstStoredAfter = db
      .prepare("SELECT * FROM delegation_transparency_log WHERE id = ?")
      .get(firstRow.id) as Record<string, unknown>;
    const rowCount = db
      .prepare("SELECT COUNT(*) as count FROM delegation_transparency_log")
      .get() as { count: number };

    expect(firstStoredAfter).toEqual(firstStoredBefore);
    expect(rowCount.count).toBe(2);
  });

  it("chains fresh appended rows with prev_hash and entry_hash", () => {
    insertDelegation("delegation-1");

    const firstRow = appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_created",
      actorKind: "delegator",
    });
    const secondRow = appendTransparencyLogRow({
      delegationId: "delegation-1",
      reservationId: "reservation-1",
      eventType: "checkpoint_action_reserved",
      actorKind: "checkpoint",
    });

    expect(firstRow.prev_hash).toBeNull();
    expect(firstRow.hash_version).toBe(TRANSPARENCY_LOG_HASH_VERSION_1);
    expect(firstRow.entry_hash).toBe(
      computeTransparencyLogEntryHashV1(
        {
          id: firstRow.id,
          delegation_id: firstRow.delegation_id,
          reservation_id: firstRow.reservation_id,
          event_type: firstRow.event_type,
          actor_kind: firstRow.actor_kind,
          agentgate_action_id: firstRow.agentgate_action_id,
          outcome: firstRow.outcome,
          reason_code: firstRow.reason_code,
          created_at: firstRow.created_at,
          hash_version: TRANSPARENCY_LOG_HASH_VERSION_1,
        },
        null
      )
    );
    expect(secondRow.prev_hash).toBe(firstRow.entry_hash);
    expect(secondRow.hash_version).toBe(TRANSPARENCY_LOG_HASH_VERSION_1);
    expect(secondRow.entry_hash).toBe(
      computeTransparencyLogEntryHashV1(
        {
          id: secondRow.id,
          delegation_id: secondRow.delegation_id,
          reservation_id: secondRow.reservation_id,
          event_type: secondRow.event_type,
          actor_kind: secondRow.actor_kind,
          agentgate_action_id: secondRow.agentgate_action_id,
          outcome: secondRow.outcome,
          reason_code: secondRow.reason_code,
          created_at: secondRow.created_at,
          hash_version: TRANSPARENCY_LOG_HASH_VERSION_1,
        },
        firstRow.entry_hash
      )
    );
  });

  it("leaves legacy rows unchained and starts a new chain on the first new append", () => {
    insertDelegation("delegation-1");
    insertLegacyTransparencyRow({
      delegationId: "delegation-1",
      createdAt: "2026-04-23T10:00:00.000Z",
      eventType: "delegation_created",
      actorKind: "delegator",
    });

    const firstChainedRow = appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_accepted",
      actorKind: "delegate",
    });

    expect(firstChainedRow.prev_hash).toBeNull();
    expect(firstChainedRow.hash_version).toBe(TRANSPARENCY_LOG_HASH_VERSION_1);
    expect(verifyTransparencyLog()).toEqual({
      status: "ok",
      chainedRows: 1,
      legacyUnchainedRows: 1,
    });
  });
});

describe("transparency log verification", () => {
  it("passes for a clean chained log", () => {
    insertDelegation("delegation-1");
    appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_created",
      actorKind: "delegator",
    });
    appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_accepted",
      actorKind: "delegate",
    });

    expect(verifyTransparencyLog()).toEqual({
      status: "ok",
      chainedRows: 2,
      legacyUnchainedRows: 0,
    });
  });

  it("fails when a chained row is edited in place", () => {
    insertDelegation("delegation-1");
    const firstRow = appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_created",
      actorKind: "delegator",
    });
    appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_accepted",
      actorKind: "delegate",
    });

    getDb()
      .prepare(
        "UPDATE delegation_transparency_log SET reason_code = ? WHERE id = ?"
      )
      .run("tampered", firstRow.id);

    expect(verifyTransparencyLog()).toMatchObject({
      status: "broken",
      brokenRowId: firstRow.id,
      reasonCode: "ENTRY_HASH_MISMATCH",
    });
  });

  it("fails when chained rows are reordered by rowid", () => {
    insertDelegation("delegation-1");
    const firstRow = appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_created",
      actorKind: "delegator",
    });
    const secondRow = appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_accepted",
      actorKind: "delegate",
    });
    appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_revoked",
      actorKind: "delegator",
    });

    const db = getDb();
    db.prepare("UPDATE delegation_transparency_log SET rowid = -1 WHERE id = ?").run(
      secondRow.id
    );
    db.prepare("UPDATE delegation_transparency_log SET rowid = 2 WHERE id = ?").run(
      firstRow.id
    );
    db.prepare("UPDATE delegation_transparency_log SET rowid = 1 WHERE id = ?").run(
      secondRow.id
    );

    expect(verifyTransparencyLog()).toMatchObject({
      status: "broken",
      brokenRowId: secondRow.id,
      reasonCode: "UNEXPECTED_PREV_HASH_ON_CHAIN_START",
    });
  });

  it("fails at the successor when a middle chained row is deleted", () => {
    insertDelegation("delegation-1");
    appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_created",
      actorKind: "delegator",
    });
    const deletedRow = appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_accepted",
      actorKind: "delegate",
    });
    const successorRow = appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_revoked",
      actorKind: "delegator",
    });

    getDb()
      .prepare("DELETE FROM delegation_transparency_log WHERE id = ?")
      .run(deletedRow.id);

    expect(verifyTransparencyLog()).toMatchObject({
      status: "broken",
      brokenRowId: successorRow.id,
      reasonCode: "CHAIN_ROWID_GAP",
    });
  });

  it("reports legacy rows as unchained, not broken", () => {
    insertDelegation("legacy-1");
    insertDelegation("legacy-2");
    insertLegacyTransparencyRow({
      delegationId: "legacy-1",
      createdAt: "2026-04-23T10:00:00.000Z",
      eventType: "delegation_created",
      actorKind: "delegator",
    });
    insertLegacyTransparencyRow({
      delegationId: "legacy-2",
      createdAt: "2026-04-23T10:01:00.000Z",
      eventType: "delegation_created",
      actorKind: "delegator",
    });

    expect(verifyTransparencyLog()).toEqual({
      status: "ok",
      chainedRows: 0,
      legacyUnchainedRows: 2,
    });
  });
});

describe("transparency log lifecycle wiring", () => {
  it("successful delegation creation appends one delegation_created row", () => {
    const delegation = makeTestDelegation();
    const db = getDb();

    const rows = db
      .prepare(
        "SELECT delegation_id, event_type, actor_kind FROM delegation_transparency_log WHERE delegation_id = ? ORDER BY created_at"
      )
      .all(delegation.id) as Array<Record<string, unknown>>;

    expect(rows).toEqual([
      {
        delegation_id: delegation.id,
        event_type: "delegation_created",
        actor_kind: "delegator",
      },
    ]);
  });

  it("successful accept appends one delegation_accepted row", () => {
    const delegation = makeTestDelegation();
    claimForAccept(delegation.id, "delegate-pub-key");
    finalizeAccept(delegation.id, "agent-bond-456");
    const db = getDb();

    const rows = db
      .prepare(
        "SELECT delegation_id, event_type, actor_kind FROM delegation_transparency_log WHERE delegation_id = ? ORDER BY created_at"
      )
      .all(delegation.id) as Array<Record<string, unknown>>;

    expect(rows).toEqual([
      {
        delegation_id: delegation.id,
        event_type: "delegation_created",
        actor_kind: "delegator",
      },
      {
        delegation_id: delegation.id,
        event_type: "delegation_accepted",
        actor_kind: "delegate",
      },
    ]);
  });

  it("successful revoke appends one delegation_revoked row", () => {
    const delegation = makeTestDelegation();
    revokeDelegation(delegation.id);
    const db = getDb();

    const rows = db
      .prepare(
        "SELECT delegation_id, event_type, actor_kind FROM delegation_transparency_log WHERE delegation_id = ? ORDER BY created_at"
      )
      .all(delegation.id) as Array<Record<string, unknown>>;

    expect(rows).toEqual([
      {
        delegation_id: delegation.id,
        event_type: "delegation_created",
        actor_kind: "delegator",
      },
      {
        delegation_id: delegation.id,
        event_type: "delegation_revoked",
        actor_kind: "delegator",
      },
    ]);
  });

  it("successful close appends one delegation_closed row", () => {
    const delegation = makeTestDelegation();
    claimForAccept(delegation.id, "delegate-pub-key");
    finalizeAccept(delegation.id, "agent-bond-456");

    const reservation = reserveAction({
      delegationId: delegation.id,
      actorPublicKey: "delegate-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in reservation)) {
      throw new Error("Expected reservation");
    }

    finalizeAction(reservation.actionId, delegation.id, "ag-action-001");
    resolveAction(reservation.actionId, "success");
    closeDelegation(delegation.id);
    const db = getDb();

    const rows = db
      .prepare(
        "SELECT delegation_id, event_type, actor_kind FROM delegation_transparency_log WHERE delegation_id = ? ORDER BY created_at"
      )
      .all(delegation.id) as Array<Record<string, unknown>>;

    expect(rows).toEqual([
      {
        delegation_id: delegation.id,
        event_type: "delegation_created",
        actor_kind: "delegator",
      },
      {
        delegation_id: delegation.id,
        event_type: "delegation_accepted",
        actor_kind: "delegate",
      },
      {
        delegation_id: delegation.id,
        event_type: "delegation_closed",
        actor_kind: "delegator",
      },
    ]);
  });

  it("failed operations do not append misleading transparency rows", () => {
    const pendingDelegation = makeTestDelegation();

    expect(finalizeAccept(pendingDelegation.id, "agent-bond-456")).toBeNull();
    expect(closeDelegation(pendingDelegation.id)).toBeNull();

    const db = getDb();
    const pendingRows = db
      .prepare(
        "SELECT delegation_id, event_type, actor_kind FROM delegation_transparency_log WHERE delegation_id = ? ORDER BY created_at"
      )
      .all(pendingDelegation.id) as Array<Record<string, unknown>>;

    expect(pendingRows).toEqual([
      {
        delegation_id: pendingDelegation.id,
        event_type: "delegation_created",
        actor_kind: "delegator",
      },
    ]);

    const revokedDelegation = makeTestDelegation();

    expect(revokeDelegation(revokedDelegation.id)).not.toBeNull();
    expect(revokeDelegation(revokedDelegation.id)).toBeNull();

    const revokedRows = db
      .prepare(
        "SELECT delegation_id, event_type, actor_kind FROM delegation_transparency_log WHERE delegation_id = ? ORDER BY created_at"
      )
      .all(revokedDelegation.id) as Array<Record<string, unknown>>;

    expect(revokedRows).toEqual([
      {
        delegation_id: revokedDelegation.id,
        event_type: "delegation_created",
        actor_kind: "delegator",
      },
      {
        delegation_id: revokedDelegation.id,
        event_type: "delegation_revoked",
        actor_kind: "delegator",
      },
    ]);
  });
});

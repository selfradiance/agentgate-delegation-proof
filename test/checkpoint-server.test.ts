import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { createCheckpointServer } from "../src/checkpoint-server";
import { closeDb, getDb } from "../src/db";
import {
  claimForAccept,
  createDelegation,
  finalizeAccept,
  getActions,
  getEvents,
  type DelegationRow,
} from "../src/delegation";
import {
  signCheckpointRequest,
  type CheckpointSignerKeys,
} from "../src/checkpoint-auth";

const VALID_DELEGATION_ID = "11111111-1111-4111-8111-111111111111";
const VALID_REQUEST_TEMPLATE = {
  actionType: "email-rewrite",
  payload: {
    input: "Please rewrite this email",
  },
  declaredExposureCents: 83,
};

const serversToClose = new Set<Server>();

function base64UrlToBase64(value: string): string {
  return Buffer.from(value, "base64url").toString("base64");
}

function generateTestKeys(): CheckpointSignerKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" }) as { x?: string };
  const privateJwk = privateKey.export({ format: "jwk" }) as { d?: string };

  if (!publicJwk.x || !privateJwk.d) {
    throw new Error("Failed to generate Ed25519 test keys");
  }

  return {
    publicKey: base64UrlToBase64(publicJwk.x),
    privateKey: base64UrlToBase64(privateJwk.d),
  };
}

function createAcceptedDelegation(delegateKeys: CheckpointSignerKeys): DelegationRow {
  const delegation = createDelegation({
    delegatorId: "human-pub-key",
    delegateId: delegateKeys.publicKey,
    scope: {
      allowed_actions: ["email-rewrite"],
      max_actions: 3,
      max_exposure_cents: 83,
      max_total_exposure_cents: 250,
      description: "Rewrite emails",
    },
    delegatorBondId: "human-bond-123",
    ttlSeconds: 3600,
  });

  claimForAccept(delegation.id, delegateKeys.publicKey);
  finalizeAccept(delegation.id, "agent-bond-123");
  return delegation;
}

function buildSignedRequest(
  delegationId: string,
  signerKeys: CheckpointSignerKeys,
  overrides?: Partial<{
    delegateId: string;
    timestamp: string;
    actionType: string;
    declaredExposureCents: number;
    payload: unknown;
  }>
) {
  const delegateId = overrides?.delegateId ?? signerKeys.publicKey;
  const timestamp = overrides?.timestamp ?? new Date().toISOString();
  const actionType = overrides?.actionType ?? VALID_REQUEST_TEMPLATE.actionType;
  const declaredExposureCents =
    overrides?.declaredExposureCents ?? VALID_REQUEST_TEMPLATE.declaredExposureCents;
  const payload = overrides?.payload ?? VALID_REQUEST_TEMPLATE.payload;

  const signature = signCheckpointRequest(
    {
      delegationId,
      delegateId,
      actionType,
      declaredExposureCents,
      payload,
      timestamp,
    },
    signerKeys
  );

  return {
    actionType,
    payload,
    declaredExposureCents,
    auth: {
      delegateId,
      timestamp,
      signature,
    },
  };
}

beforeEach(() => {
  process.env.DELEGATION_DB_PATH = ":memory:";
});

afterEach(async () => {
  await Promise.all(
    Array.from(serversToClose, (server) =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        });
      })
    )
  );
  serversToClose.clear();
  closeDb();
  delete process.env.DELEGATION_DB_PATH;
  vi.restoreAllMocks();
});

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createCheckpointServer();
  serversToClose.add(server);

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

describe("checkpoint server — execute endpoint", () => {
  it('creates one reservation for a valid authenticated request and returns stage "reserved"', async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();
    const requestBody = buildSignedRequest(delegation.id, delegateKeys);

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      stage: "reserved",
      delegationId: delegation.id,
      actionType: "email-rewrite",
      reservationId: expect.any(String),
    });

    const actions = getActions(delegation.id);
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe(body.reservationId);
    expect(actions[0].delegation_id).toBe(delegation.id);
    expect(actions[0].action_type).toBe("email-rewrite");
    expect(actions[0].declared_exposure_cents).toBe(83);
    expect(actions[0].effective_exposure_cents).toBe(100);
    expect(actions[0].agentgate_action_id).toBeNull();
    expect(actions[0].outcome).toBeNull();
  });

  it("associates the reservation with the correct delegation and delegate event trail", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();
    const requestBody = buildSignedRequest(delegation.id, delegateKeys, {
      actionType: "file-transform",
      declaredExposureCents: 10,
      payload: { file: "draft.txt" },
    });

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const actions = getActions(delegation.id);
    const reserveEvents = getEvents(delegation.id).filter(
      (event) => event.event_type === "checkpoint_action_reserved"
    );

    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe(body.reservationId);
    expect(actions[0].delegation_id).toBe(delegation.id);
    expect(reserveEvents).toHaveLength(1);
    expect(JSON.parse(reserveEvents[0].detail_json ?? "{}")).toMatchObject({
      reservation_id: body.reservationId,
      delegate_id: delegateKeys.publicKey,
      action_type: "file-transform",
      declared_exposure_cents: 10,
      effective_exposure_cents: 12,
    });
  });

  it("writes one reservation and one checkpoint reservation event per successful call", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(delegation.id, delegateKeys)),
      }
    );

    expect(response.status).toBe(200);
    expect(getActions(delegation.id)).toHaveLength(1);
    expect(
      getEvents(delegation.id).filter(
        (event) => event.event_type === "checkpoint_action_reserved"
      )
    ).toHaveLength(1);
  });

  it("creates distinct reservations for two sequential authenticated calls", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();

    const firstResponse = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(delegation.id, delegateKeys)),
      }
    );

    const secondResponse = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildSignedRequest(delegation.id, delegateKeys, {
            declaredExposureCents: 20,
            payload: { input: "second call" },
          })
        ),
      }
    );

    const firstBody = await firstResponse.json();
    const secondBody = await secondResponse.json();
    const actions = getActions(delegation.id);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstBody.reservationId).not.toBe(secondBody.reservationId);
    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.id)).toEqual([
      firstBody.reservationId,
      secondBody.reservationId,
    ]);
  });

  it("returns DELEGATION_NOT_FOUND when the delegation does not exist", async () => {
    const delegateKeys = generateTestKeys();
    const { baseUrl } = await startServer();
    const requestBody = buildSignedRequest(VALID_DELEGATION_ID, delegateKeys);

    const response = await fetch(
      `${baseUrl}/v1/delegations/${VALID_DELEGATION_ID}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "DELEGATION_NOT_FOUND",
      message: "Delegation not found",
    });
  });

  it("rejects a delegation in the wrong state", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createDelegation({
      delegatorId: "human-pub-key",
      delegateId: delegateKeys.publicKey,
      scope: {
        allowed_actions: ["email-rewrite"],
        max_actions: 3,
        max_exposure_cents: 83,
        max_total_exposure_cents: 250,
        description: "Rewrite emails",
      },
      delegatorBondId: "human-bond-123",
      ttlSeconds: 3600,
    });
    const { baseUrl } = await startServer();
    const requestBody = buildSignedRequest(delegation.id, delegateKeys);

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "DELEGATION_NOT_ACTIVE",
      message: expect.stringContaining('status "pending"'),
    });
    expect(getActions(delegation.id)).toHaveLength(0);
  });

  it("rejects a request signed by the wrong key", async () => {
    const delegateKeys = generateTestKeys();
    const wrongSignerKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();
    const requestBody = buildSignedRequest(delegation.id, wrongSignerKeys, {
      delegateId: delegateKeys.publicKey,
    });

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "INVALID_SIGNATURE",
      message: "auth.signature did not verify for the bound delegate identity",
    });
    expect(getActions(delegation.id)).toHaveLength(0);
  });

  it("rejects a stale timestamp", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();
    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const requestBody = buildSignedRequest(delegation.id, delegateKeys, {
      timestamp: staleTimestamp,
    });

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "TIMESTAMP_OUT_OF_WINDOW",
      message: "auth.timestamp is outside the allowed freshness window",
    });
    expect(getActions(delegation.id)).toHaveLength(0);
  });

  it("rejects auth.delegateId mismatches with the stored delegate identity", async () => {
    const delegateKeys = generateTestKeys();
    const mismatchedKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();
    const requestBody = buildSignedRequest(delegation.id, mismatchedKeys);

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "DELEGATE_MISMATCH",
      message: "auth.delegateId does not match the bound delegate identity",
    });
    expect(getActions(delegation.id)).toHaveLength(0);
  });

  it("returns RESERVATION_FAILED and leaves no partial reservation when the write transaction fails", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();
    const db = getDb();
    const originalPrepare = db.prepare.bind(db);

    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO delegation_events")) {
        throw new Error("forced reservation event write failure");
      }

      return originalPrepare(sql);
    });

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(delegation.id, delegateKeys)),
      }
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "RESERVATION_FAILED",
      message: "Failed to create local checkpoint reservation",
    });
    expect(getActions(delegation.id)).toHaveLength(0);
    expect(
      getEvents(delegation.id).filter(
        (event) => event.event_type === "checkpoint_action_reserved"
      )
    ).toHaveLength(0);
  });

  it("rejects requests with missing required fields", async () => {
    const { baseUrl } = await startServer();
    const auth = {
      delegateId: "cHVibGljLWtleQ==",
      timestamp: new Date().toISOString(),
      signature: "c2lnbmF0dXJl",
    };
    const { actionType, payload, declaredExposureCents } = VALID_REQUEST_TEMPLATE;

    const response = await fetch(
      `${baseUrl}/v1/delegations/${VALID_DELEGATION_ID}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionType,
          payload,
          declaredExposureCents,
          auth: {
            delegateId: auth.delegateId,
            timestamp: auth.timestamp,
          },
        }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
    });
  });

  it("rejects invalid exposure values", async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${VALID_DELEGATION_ID}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_REQUEST_TEMPLATE,
          auth: {
            delegateId: "cHVibGljLWtleQ==",
            timestamp: new Date().toISOString(),
            signature: "c2lnbmF0dXJl",
          },
          declaredExposureCents: 0,
        }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
      message: expect.stringContaining("declaredExposureCents"),
    });
  });

  it("rejects malformed timestamps", async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${VALID_DELEGATION_ID}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_REQUEST_TEMPLATE,
          auth: {
            delegateId: "cHVibGljLWtleQ==",
            timestamp: "not-a-timestamp",
            signature: "c2lnbmF0dXJl",
          },
        }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
      message: expect.stringContaining("auth.timestamp"),
    });
  });

  it("rejects malformed signatures", async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${VALID_DELEGATION_ID}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_REQUEST_TEMPLATE,
          auth: {
            delegateId: "cHVibGljLWtleQ==",
            timestamp: new Date().toISOString(),
            signature: "***not-base64***",
          },
        }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
      message: expect.stringContaining("auth.signature"),
    });
  });

  it("rejects unknown extra fields with strict request parsing", async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${VALID_DELEGATION_ID}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_REQUEST_TEMPLATE,
          auth: {
            delegateId: "cHVibGljLWtleQ==",
            timestamp: new Date().toISOString(),
            signature: "c2lnbmF0dXJl",
          },
          unexpected: true,
        }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
      message: expect.stringContaining("Unrecognized key"),
    });
  });

  it("rejects an invalid delegation id in the route", async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/v1/delegations/not-a-uuid/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...VALID_REQUEST_TEMPLATE,
        auth: {
          delegateId: "cHVibGljLWtleQ==",
          timestamp: new Date().toISOString(),
          signature: "c2lnbmF0dXJl",
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "INVALID_DELEGATION_ID",
      message: "delegationId: Invalid uuid",
    });
  });
});

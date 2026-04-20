import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createCheckpointServer } from "../src/checkpoint-server";

const VALID_DELEGATION_ID = "11111111-1111-4111-8111-111111111111";
const VALID_REQUEST = {
  actionType: "email-rewrite",
  payload: {
    input: "Please rewrite this email",
  },
  declaredExposureCents: 83,
  auth: {
    delegateId: "cHVibGljLWtleQ==",
    timestamp: "2026-04-20T15:30:00Z",
    signature: "c2lnbmF0dXJl",
  },
};

const serversToClose = new Set<Server>();

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
  it("accepts a valid delegated execution request shape", async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${VALID_DELEGATION_ID}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(VALID_REQUEST),
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      stage: "validated",
      delegationId: VALID_DELEGATION_ID,
      actionType: "email-rewrite",
    });
  });

  it("rejects requests with missing required fields", async () => {
    const { baseUrl } = await startServer();
    const { auth, ...rest } = VALID_REQUEST;

    const response = await fetch(
      `${baseUrl}/v1/delegations/${VALID_DELEGATION_ID}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...rest,
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
          ...VALID_REQUEST,
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
          ...VALID_REQUEST,
          auth: {
            ...VALID_REQUEST.auth,
            timestamp: "not-a-timestamp",
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
          ...VALID_REQUEST,
          auth: {
            ...VALID_REQUEST.auth,
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
          ...VALID_REQUEST,
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
      body: JSON.stringify(VALID_REQUEST),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "INVALID_DELEGATION_ID",
      message: "delegationId: Invalid uuid",
    });
  });
});

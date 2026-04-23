import { describe, expect, it } from "vitest";
import {
  TRANSPARENCY_LOG_HASH_VERSION_1,
  canonicalizeTransparencyLogRowV1,
  canonicalizeValue,
} from "../src/transparency-log-canonical";

describe("transparency log canonical serialization", () => {
  it("serializes supported primitives in one locked form", () => {
    const canonical = canonicalizeValue({
      z: "hello",
      a: true,
      d: [null, false, 12.5, "caf\u00e9"],
      c: 0,
      b: null,
    });

    expect(canonical).toBe(
      '{"a":true,"b":null,"c":0,"d":[null,false,12.5,"café"],"z":"hello"}'
    );
  });

  it("serializes transparency-log rows with sorted keys", () => {
    const canonical = canonicalizeTransparencyLogRowV1({
      id: "row-123",
      delegation_id: "delegation-456",
      reservation_id: null,
      event_type: "delegation_created",
      actor_kind: "delegator",
      agentgate_action_id: null,
      outcome: null,
      reason_code: "caf\u00e9",
      created_at: "2026-04-23T10:11:12.000Z",
      hash_version: TRANSPARENCY_LOG_HASH_VERSION_1,
    });

    expect(canonical).toBe(
      '{"actor_kind":"delegator","agentgate_action_id":null,"created_at":"2026-04-23T10:11:12.000Z","delegation_id":"delegation-456","event_type":"delegation_created","hash_version":1,"id":"row-123","outcome":null,"reason_code":"café","reservation_id":null}'
    );
  });
});

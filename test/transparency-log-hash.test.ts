import { describe, expect, it } from "vitest";
import { computeTransparencyLogEntryHashV1 } from "../src/transparency-log-hash";
import { TRANSPARENCY_LOG_HASH_VERSION_1 } from "../src/transparency-log-canonical";

describe("transparency log hashes", () => {
  const row = {
    id: "row-123",
    delegation_id: "delegation-456",
    reservation_id: "reservation-789",
    event_type: "checkpoint_forward_attached",
    actor_kind: "checkpoint",
    agentgate_action_id: "ag-action-001",
    outcome: null,
    reason_code: null,
    created_at: "2026-04-23T10:11:12.000Z",
    hash_version: TRANSPARENCY_LOG_HASH_VERSION_1,
  };

  it("hashes the first chained row with an empty prev hash", () => {
    expect(computeTransparencyLogEntryHashV1(row, null)).toBe(
      "fe783c6ba605ad1a253ea8b9d621fe2d84dbd76df1d067d2edffa34e443116eb"
    );
  });

  it("hashes later chained rows with the previous entry hash", () => {
    expect(
      computeTransparencyLogEntryHashV1(
        row,
        "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff"
      )
    ).toBe("b1705e31b69a1cd909d5c81d27a5d959a64be5fb97d0b68145d29d3138961d1c");
  });
});

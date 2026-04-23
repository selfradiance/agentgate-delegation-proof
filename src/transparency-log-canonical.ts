export const TRANSPARENCY_LOG_HASH_VERSION_1 = 1 as const;

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export interface TransparencyLogHashableRowV1 {
  [key: string]: CanonicalValue;
  actor_kind: string;
  agentgate_action_id: string | null;
  created_at: string;
  delegation_id: string;
  event_type: string;
  hash_version: typeof TRANSPARENCY_LOG_HASH_VERSION_1;
  id: string;
  outcome: string | null;
  reason_code: string | null;
  reservation_id: string | null;
}

export function canonicalizeValue(value: CanonicalValue): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical serialization only supports finite numbers");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeValue(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalizeValue(value[key])}`)
    .join(",")}}`;
}

export function canonicalizeTransparencyLogRowV1(
  row: TransparencyLogHashableRowV1
): string {
  return canonicalizeValue(row);
}

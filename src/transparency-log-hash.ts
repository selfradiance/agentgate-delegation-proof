import { createHash } from "node:crypto";
import {
  canonicalizeTransparencyLogRowV1,
  type TransparencyLogHashableRowV1,
} from "./transparency-log-canonical";

export function computeTransparencyLogEntryHashV1(
  row: TransparencyLogHashableRowV1,
  prevHash: string | null
): string {
  return createHash("sha256")
    .update(canonicalizeTransparencyLogRowV1(row), "utf8")
    .update(prevHash ?? "", "utf8")
    .digest("hex");
}

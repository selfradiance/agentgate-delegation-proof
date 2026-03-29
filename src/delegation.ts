import { randomUUID } from "crypto";
import { getDb } from "./db";
import {
  DelegationScopeSchema,
  effectiveExposure,
  validateAction,
  type DelegationScope,
  type ScopeCheckResult,
} from "./scope";

// --- Types ---

export type DelegationStatus =
  | "pending"
  | "accepting"  // transient: claim during accept two-phase
  | "accepted"
  | "active"
  | "settling"
  | "completed"
  | "failed";

export type TerminalReason =
  | "exhausted"
  | "closed"
  | "revoked"
  | "expired";

export type DelegationOutcome =
  | "success"
  | "failed"
  | "agent-malicious"
  | "none";

export type ActionOutcome = "success" | "failed" | "malicious";

export interface DelegationRow {
  id: string;
  delegator_id: string;
  delegate_id: string;
  scope_json: string;
  delegator_bond_id: string;
  delegate_bond_id: string | null;
  delegator_bond_outcome: string | null;
  delegator_bond_resolved_at: string | null;
  delegation_outcome: string | null;
  status: DelegationStatus;
  terminal_reason: string | null;
  created_at: string;
  accepted_at: string | null;
  expires_at: string;
  completed_at: string | null;
}

export interface DelegationActionRow {
  id: string;
  delegation_id: string;
  agentgate_action_id: string | null;
  action_type: string;
  declared_exposure_cents: number;
  effective_exposure_cents: number;
  outcome: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface DelegationEventRow {
  id: string;
  delegation_id: string;
  event_type: string;
  detail_json: string | null;
  created_at: string;
}

// --- Event logging ---

function logEvent(
  delegationId: string,
  eventType: string,
  detail?: Record<string, unknown>
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO delegation_events (id, delegation_id, event_type, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    delegationId,
    eventType,
    detail ? JSON.stringify(detail) : null,
    new Date().toISOString()
  );
}

// --- Create delegation ---

export interface CreateDelegationParams {
  delegatorId: string;
  delegateId: string;
  scope: DelegationScope;
  delegatorBondId: string;
  ttlSeconds: number;
}

export function createDelegation(params: CreateDelegationParams): DelegationRow {
  // Validate scope with Zod
  DelegationScopeSchema.parse(params.scope);

  const db = getDb();
  const id = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + params.ttlSeconds * 1000);

  db.prepare(
    `INSERT INTO delegations
     (id, delegator_id, delegate_id, scope_json, delegator_bond_id, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    id,
    params.delegatorId,
    params.delegateId,
    JSON.stringify(params.scope),
    params.delegatorBondId,
    now.toISOString(),
    expiresAt.toISOString()
  );

  logEvent(id, "delegation_created", {
    delegator_id: params.delegatorId,
    delegate_id: params.delegateId,
    scope: params.scope,
    delegator_bond_id: params.delegatorBondId,
    ttl_seconds: params.ttlSeconds,
  });

  return getDelegation(id)!;
}

// --- Get delegation ---

export function getDelegation(id: string): DelegationRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM delegations WHERE id = ?")
    .get(id) as DelegationRow | undefined;
  return row ?? null;
}

// --- Accept delegation (Phase 1: claim) ---

/**
 * Phase 1 of accept: atomically claim the delegation by moving to 'accepting'.
 * Returns the delegation row if claim succeeded, null if someone else got there first.
 */
export function claimForAccept(delegationId: string): DelegationRow | null {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(
    `UPDATE delegations SET status = 'accepting'
     WHERE id = ? AND status = 'pending' AND expires_at > ?`
  ).run(delegationId, now);

  if (result.changes !== 1) return null;
  return getDelegation(delegationId);
}

/**
 * Phase 3 of accept: finalize after successful AgentGate bond posting.
 */
export function finalizeAccept(
  delegationId: string,
  delegateBondId: string
): DelegationRow | null {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(
    `UPDATE delegations
     SET status = 'accepted', accepted_at = ?, delegate_bond_id = ?
     WHERE id = ? AND status = 'accepting'`
  ).run(now, delegateBondId, delegationId);

  if (result.changes !== 1) return null;

  logEvent(delegationId, "delegation_accepted", {
    delegate_bond_id: delegateBondId,
  });

  return getDelegation(delegationId);
}

/**
 * Phase 3 of accept: revert after failed AgentGate bond posting.
 */
export function revertAccept(delegationId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE delegations SET status = 'pending'
     WHERE id = ? AND status = 'accepting'`
  ).run(delegationId);
}

// --- Act under delegation (Phase 1: validate and reserve) ---

export interface ActParams {
  delegationId: string;
  actionType: string;
  declaredExposureCents: number;
}

export interface ActReservation {
  actionId: string;
  delegation: DelegationRow;
}

/**
 * Phase 1 of act: validate scope and reserve an action slot.
 * Returns the action ID and delegation if valid, or a ScopeCheckResult if rejected.
 */
export function reserveAction(
  params: ActParams
): ActReservation | ScopeCheckResult {
  const db = getDb();
  const delegation = getDelegation(params.delegationId);

  if (!delegation) {
    return { valid: false, reason: "Delegation not found" };
  }

  // Guard: status must be accepted or active
  if (delegation.status !== "accepted" && delegation.status !== "active") {
    return {
      valid: false,
      reason: `Cannot act on delegation with status "${delegation.status}"`,
    };
  }

  // Guard: check expiry inside critical section
  const now = new Date().toISOString();
  if (now >= delegation.expires_at) {
    logEvent(params.delegationId, "action_rejected_expired", {
      action_type: params.actionType,
      declared_exposure_cents: params.declaredExposureCents,
    });
    return { valid: false, reason: "Delegation has expired" };
  }

  // Get scope and validate
  const scope: DelegationScope = JSON.parse(delegation.scope_json);

  // Count existing actions (exclude pending ones that might be in-flight from another two-phase)
  const actionRows = db
    .prepare(
      "SELECT * FROM delegation_actions WHERE delegation_id = ? AND agentgate_action_id IS NOT NULL"
    )
    .all(params.delegationId) as DelegationActionRow[];

  const actionsTaken = actionRows.length;
  const totalEffective = actionRows.reduce(
    (sum, a) => sum + a.effective_exposure_cents,
    0
  );

  const scopeCheck = validateAction(
    scope,
    params.actionType,
    params.declaredExposureCents,
    actionsTaken,
    totalEffective
  );

  if (!scopeCheck.valid) {
    logEvent(params.delegationId, "action_rejected_scope", {
      action_type: params.actionType,
      declared_exposure_cents: params.declaredExposureCents,
      reason: scopeCheck.reason,
    });
    return scopeCheck;
  }

  // Reserve action slot
  const actionId = randomUUID();
  const effective = effectiveExposure(params.declaredExposureCents);

  db.prepare(
    `INSERT INTO delegation_actions
     (id, delegation_id, action_type, declared_exposure_cents, effective_exposure_cents, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    actionId,
    params.delegationId,
    params.actionType,
    params.declaredExposureCents,
    effective,
    now
  );

  return { actionId, delegation };
}

/**
 * Phase 3 of act: finalize after successful AgentGate execute_bonded_action.
 */
export function finalizeAction(
  actionId: string,
  delegationId: string,
  agentgateActionId: string
): void {
  const db = getDb();

  db.prepare(
    `UPDATE delegation_actions SET agentgate_action_id = ?
     WHERE id = ? AND agentgate_action_id IS NULL`
  ).run(agentgateActionId, actionId);

  // Move delegation to active if it was accepted
  db.prepare(
    `UPDATE delegations SET status = 'active'
     WHERE id = ? AND status IN ('accepted', 'active')`
  ).run(delegationId);

  logEvent(delegationId, "action_executed", {
    action_id: actionId,
    agentgate_action_id: agentgateActionId,
  });
}

/**
 * Phase 3 of act: revert after failed AgentGate call.
 */
export function revertAction(actionId: string): void {
  const db = getDb();
  db.prepare(
    "DELETE FROM delegation_actions WHERE id = ? AND agentgate_action_id IS NULL"
  ).run(actionId);
}

// --- Resolve action ---

export function resolveAction(
  actionId: string,
  outcome: ActionOutcome
): DelegationActionRow | null {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(
    `UPDATE delegation_actions SET outcome = ?, resolved_at = ?
     WHERE id = ? AND outcome IS NULL`
  ).run(outcome, now, actionId);

  if (result.changes !== 1) return null;

  const action = db
    .prepare("SELECT * FROM delegation_actions WHERE id = ?")
    .get(actionId) as DelegationActionRow;

  logEvent(action.delegation_id, "action_resolved", {
    action_id: actionId,
    outcome,
  });

  // Check if delegation should auto-complete
  tryAutoComplete(action.delegation_id);

  return action;
}

// --- Revoke delegation ---

export function revokeDelegation(delegationId: string): DelegationRow | null {
  const delegation = getDelegation(delegationId);
  if (!delegation) return null;

  // Guard: cannot revoke terminal states
  if (delegation.status === "completed" || delegation.status === "failed") {
    return null;
  }

  const db = getDb();
  const now = new Date().toISOString();

  // Check for open (unresolved) actions
  const openActions = db
    .prepare(
      `SELECT COUNT(*) as count FROM delegation_actions
       WHERE delegation_id = ? AND outcome IS NULL AND agentgate_action_id IS NOT NULL`
    )
    .get(delegationId) as { count: number };

  if (openActions.count > 0) {
    // Move to settling — actions still need resolution
    db.prepare(
      `UPDATE delegations SET status = 'settling', terminal_reason = 'revoked'
       WHERE id = ?`
    ).run(delegationId);

    logEvent(delegationId, "delegation_revoked", { settling: true });
  } else {
    // No open actions — go straight to completed
    const outcome = computeOutcome(delegationId);
    db.prepare(
      `UPDATE delegations
       SET status = 'completed', terminal_reason = 'revoked',
           delegation_outcome = ?, completed_at = ?
       WHERE id = ?`
    ).run(outcome, now, delegationId);

    logEvent(delegationId, "delegation_revoked", { settling: false });
    logEvent(delegationId, "delegation_completed", {
      outcome,
      reason: "revoked",
    });
  }

  return getDelegation(delegationId);
}

// --- Close delegation ---

export function closeDelegation(delegationId: string): DelegationRow | null {
  const delegation = getDelegation(delegationId);
  if (!delegation) return null;

  // Guard: can only close active delegations with zero open actions
  if (delegation.status !== "active") return null;

  const db = getDb();

  const openActions = db
    .prepare(
      `SELECT COUNT(*) as count FROM delegation_actions
       WHERE delegation_id = ? AND outcome IS NULL AND agentgate_action_id IS NOT NULL`
    )
    .get(delegationId) as { count: number };

  if (openActions.count > 0) return null;

  const now = new Date().toISOString();
  const outcome = computeOutcome(delegationId);

  db.prepare(
    `UPDATE delegations
     SET status = 'completed', terminal_reason = 'closed',
         delegation_outcome = ?, completed_at = ?
     WHERE id = ?`
  ).run(outcome, now, delegationId);

  logEvent(delegationId, "delegation_completed", {
    outcome,
    reason: "closed",
  });

  return getDelegation(delegationId);
}

// --- Expiry check ---

export function checkExpiry(delegationId: string): DelegationRow | null {
  const delegation = getDelegation(delegationId);
  if (!delegation) return null;

  const now = new Date().toISOString();
  if (now < delegation.expires_at) return null; // not expired yet

  // Only expire non-terminal delegations
  if (delegation.status === "completed" || delegation.status === "failed") {
    return null;
  }

  const db = getDb();

  const openActions = db
    .prepare(
      `SELECT COUNT(*) as count FROM delegation_actions
       WHERE delegation_id = ? AND outcome IS NULL AND agentgate_action_id IS NOT NULL`
    )
    .get(delegationId) as { count: number };

  if (openActions.count > 0) {
    db.prepare(
      `UPDATE delegations SET status = 'settling', terminal_reason = 'expired'
       WHERE id = ?`
    ).run(delegationId);

    logEvent(delegationId, "delegation_expired", { settling: true });
  } else {
    const outcome = computeOutcome(delegationId);
    db.prepare(
      `UPDATE delegations
       SET status = 'completed', terminal_reason = 'expired',
           delegation_outcome = ?, completed_at = ?
       WHERE id = ?`
    ).run(outcome, now, delegationId);

    logEvent(delegationId, "delegation_expired", { settling: false });
    logEvent(delegationId, "delegation_completed", {
      outcome,
      reason: "expired",
    });
  }

  return getDelegation(delegationId);
}

// --- Aggregate outcome computation ---

export function computeOutcome(delegationId: string): DelegationOutcome {
  const db = getDb();
  const actions = db
    .prepare(
      "SELECT * FROM delegation_actions WHERE delegation_id = ? AND agentgate_action_id IS NOT NULL"
    )
    .all(delegationId) as DelegationActionRow[];

  if (actions.length === 0) return "none";

  const hasMalicious = actions.some((a) => a.outcome === "malicious");
  if (hasMalicious) return "agent-malicious";

  const hasFailed = actions.some((a) => a.outcome === "failed");
  if (hasFailed) return "failed";

  const allSuccess = actions.every((a) => a.outcome === "success");
  if (allSuccess) return "success";

  // Some actions still unresolved — shouldn't happen at completion time
  // but return "none" as safe default
  return "none";
}

// --- Auto-complete check ---

function tryAutoComplete(delegationId: string): void {
  const delegation = getDelegation(delegationId);
  if (!delegation) return;

  const db = getDb();

  // Auto-complete settling delegations when all actions are resolved
  if (delegation.status === "settling") {
    const openActions = db
      .prepare(
        `SELECT COUNT(*) as count FROM delegation_actions
         WHERE delegation_id = ? AND outcome IS NULL AND agentgate_action_id IS NOT NULL`
      )
      .get(delegationId) as { count: number };

    if (openActions.count === 0) {
      const now = new Date().toISOString();
      const outcome = computeOutcome(delegationId);
      db.prepare(
        `UPDATE delegations
         SET status = 'completed', delegation_outcome = ?, completed_at = ?
         WHERE id = ?`
      ).run(outcome, now, delegationId);

      logEvent(delegationId, "delegation_completed", {
        outcome,
        reason: delegation.terminal_reason,
      });
    }
  }

  // Auto-complete active delegations when all max_actions are exhausted and resolved
  if (delegation.status === "active") {
    const scope: DelegationScope = JSON.parse(delegation.scope_json);
    const actions = db
      .prepare(
        "SELECT * FROM delegation_actions WHERE delegation_id = ? AND agentgate_action_id IS NOT NULL"
      )
      .all(delegationId) as DelegationActionRow[];

    if (actions.length >= scope.max_actions) {
      const allResolved = actions.every((a) => a.outcome !== null);
      if (allResolved) {
        const now = new Date().toISOString();
        const outcome = computeOutcome(delegationId);
        db.prepare(
          `UPDATE delegations
           SET status = 'completed', terminal_reason = 'exhausted',
               delegation_outcome = ?, completed_at = ?
           WHERE id = ?`
        ).run(outcome, now, delegationId);

        logEvent(delegationId, "delegation_completed", {
          outcome,
          reason: "exhausted",
        });
      }
    }
  }
}

// --- Recovery: revert transient states on startup ---

export function recoverTransientStates(): number {
  const db = getDb();
  const result = db.prepare(
    `UPDATE delegations SET status = 'pending'
     WHERE status = 'accepting'`
  ).run();
  return result.changes;
}

// --- Query helpers ---

export function getActions(
  delegationId: string
): DelegationActionRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM delegation_actions WHERE delegation_id = ? ORDER BY created_at"
    )
    .all(delegationId) as DelegationActionRow[];
}

export function getEvents(
  delegationId: string
): DelegationEventRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM delegation_events WHERE delegation_id = ? ORDER BY created_at"
    )
    .all(delegationId) as DelegationEventRow[];
}

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  ExecuteDelegationPathParamsSchema,
  ExecuteDelegationRequestSchema,
  formatSchemaIssue,
} from "./checkpoint-schema";

export type CheckpointErrorCode =
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "INVALID_JSON"
  | "INVALID_DELEGATION_ID"
  | "INVALID_REQUEST";

interface CheckpointErrorResponse {
  ok: false;
  code: CheckpointErrorCode;
  message: string;
}

interface CheckpointSuccessResponse {
  ok: true;
  stage: "validated";
  delegationId: string;
  actionType: string;
}

type CheckpointResponse = CheckpointErrorResponse | CheckpointSuccessResponse;

const EXECUTE_ROUTE_PATTERN = /^\/v1\/delegations\/([^/]+)\/execute$/;

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: CheckpointResponse
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(rawBody);
}

function getExecuteRouteMatch(urlString: string | undefined): RegExpMatchArray | null {
  if (!urlString) return null;
  const url = new URL(urlString, "http://127.0.0.1");
  return url.pathname.match(EXECUTE_ROUTE_PATTERN);
}

function buildInvalidRequestMessage(message: string, fieldPath?: string): string {
  if (!fieldPath) {
    return message;
  }

  return `${fieldPath}: ${message}`;
}

export async function handleCheckpointRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const routeMatch = getExecuteRouteMatch(req.url);

  if (!routeMatch) {
    sendJson(res, 404, {
      ok: false,
      code: "NOT_FOUND",
      message: "Route not found",
    });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, {
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only POST is supported for this route",
    });
    return;
  }

  const pathResult = ExecuteDelegationPathParamsSchema.safeParse({
    delegationId: decodeURIComponent(routeMatch[1]),
  });

  if (!pathResult.success) {
    const issue = pathResult.error.issues[0];
    sendJson(res, 400, {
      ok: false,
      code: "INVALID_DELEGATION_ID",
      message: buildInvalidRequestMessage(
        issue?.message ?? "Invalid delegation id",
        issue ? formatSchemaIssue(issue.path) : undefined
      ),
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, {
      ok: false,
      code: "INVALID_JSON",
      message: "Request body must be valid JSON",
    });
    return;
  }

  const requestResult = ExecuteDelegationRequestSchema.safeParse(body);
  if (!requestResult.success) {
    const issue = requestResult.error.issues[0];
    sendJson(res, 400, {
      ok: false,
      code: "INVALID_REQUEST",
      message: buildInvalidRequestMessage(
        issue?.message ?? "Invalid request body",
        issue ? formatSchemaIssue(issue.path) : undefined
      ),
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    stage: "validated",
    delegationId: pathResult.data.delegationId,
    actionType: requestResult.data.actionType,
  });
}

export function createCheckpointServer() {
  return createServer((req, res) => {
    void handleCheckpointRequest(req, res).catch(() => {
      if (res.writableEnded) {
        return;
      }

      sendJson(res, 500, {
        ok: false,
        code: "INVALID_REQUEST",
        message: "Unexpected checkpoint server error",
      });
    });
  });
}

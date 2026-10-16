import {
  HttpErrorSchema,
  InventoryHoldCreateRequestSchema,
  InventoryHoldIdempotencyKeySchema,
  InventoryHoldResponseSchema,
  type InventoryHoldCreateRequest,
  type InventoryHoldResponse,
} from "@ticket-live/contracts";
import { z } from "zod";
import { env, serviceCredential } from "@ticket-live/runtime";
import { getTraceContext } from "@ticket-live/runtime";

const MAX_RETRIES = 2;
const DEFAULT_DEADLINE_MS = 2_000;

export class InventoryServiceError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type ClientOptions = {
  baseUrl: string;
  serviceToken: string;
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
};

/** HTTP client for service callers; every operation shares one total deadline. */
export class InventoryClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly deadlineMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.serviceToken = z
      .string()
      .regex(/^[\x21-\x7E]{32,}$/)
      .parse(options.serviceToken);
    this.deadlineMs = Math.max(
      100,
      Math.min(options.deadlineMs ?? DEFAULT_DEADLINE_MS, 5_000),
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  createHold(
    eventId: string,
    request: InventoryHoldCreateRequest,
  ): Promise<InventoryHoldResponse> {
    z.uuid().parse(eventId);
    const parsed = InventoryHoldCreateRequestSchema.parse(request);
    return this.request("POST", `/internal/events/${eventId}/holds`, {
      body: parsed,
      idempotencyKey: InventoryHoldIdempotencyKeySchema.parse(parsed.orderId),
    });
  }

  confirmHold(holdId: string): Promise<InventoryHoldResponse> {
    z.uuid().parse(holdId);
    return this.request("POST", `/internal/holds/${holdId}/confirm`);
  }

  releaseHold(holdId: string): Promise<InventoryHoldResponse> {
    z.uuid().parse(holdId);
    return this.request("POST", `/internal/holds/${holdId}/release`);
  }

  getHold(holdId: string): Promise<InventoryHoldResponse> {
    z.uuid().parse(holdId);
    return this.request("GET", `/internal/holds/${holdId}`);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: { body?: InventoryHoldCreateRequest; idempotencyKey?: string } = {},
  ): Promise<InventoryHoldResponse> {
    const deadline = Date.now() + this.deadlineMs;
    let lastFailure: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new InventoryServiceError("Inventory service deadline exceeded", 504);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), remainingMs);
      try {
        const traceContext = getTraceContext();
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.serviceToken}`,
            ...(traceContext
              ? {
                  "x-correlation-id": traceContext.correlationId,
                  traceparent: traceContext.traceparent,
                  ...(traceContext.tracestate ? { tracestate: traceContext.tracestate } : {}),
                }
              : {}),
            ...(options.body ? { "content-type": "application/json" } : {}),
            ...(options.idempotencyKey
              ? { "idempotency-key": options.idempotencyKey }
              : {}),
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });

        if (
          !response.ok && isRetryableStatus(response.status) &&
          attempt < MAX_RETRIES
        ) {
          await response.body?.cancel().catch(() => undefined);
          await waitBeforeRetry(attempt, deadline);
          continue;
        }

        let responseBody: unknown;
        try {
          responseBody = await response.json();
        } catch {
          throw new InventoryServiceError("Inventory service returned invalid JSON", 502);
        }

        if (!response.ok) {
          const parsedError = HttpErrorSchema.safeParse(responseBody);
          throw new InventoryServiceError(
            parsedError.success ? parsedError.data.error : "Inventory service request failed",
            response.status,
          );
        }

        const parsedResponse = InventoryHoldResponseSchema.safeParse(responseBody);
        if (!parsedResponse.success) {
          throw new InventoryServiceError("Inventory service returned an invalid hold", 502);
        }
        return parsedResponse.data;
      } catch (error) {
        lastFailure = error;
        if (error instanceof InventoryServiceError) {
          if (!isRetryableStatus(error.status) || attempt >= MAX_RETRIES) throw error;
        } else if (attempt >= MAX_RETRIES) {
          break;
        }

        if (Date.now() >= deadline) break;
        await waitBeforeRetry(attempt, deadline);
      } finally {
        clearTimeout(timeout);
      }
    }

    if (Date.now() >= deadline) {
      throw new InventoryServiceError("Inventory service deadline exceeded", 504);
    }
    throw new InventoryServiceError(
      lastFailure instanceof Error ? lastFailure.message : "Inventory service unavailable",
      503,
    );
  }
}

let configuredClient: InventoryClient | undefined;

export function getInventoryClient(): InventoryClient {
  if (configuredClient) return configuredClient;
  const serviceToken = serviceCredential("order-event");
  if (!serviceToken) {
    throw new InventoryServiceError(
      "Inventory service authentication is not configured",
      503,
    );
  }
  configuredClient = new InventoryClient({
    baseUrl: env.INVENTORY_SERVICE_URL,
    serviceToken,
  });
  return configuredClient;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 ||
    status === 503 || status === 504;
}

async function waitBeforeRetry(attempt: number, deadline: number): Promise<void> {
  const delayMs = Math.min(50 * (2 ** attempt), Math.max(0, deadline - Date.now()));
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

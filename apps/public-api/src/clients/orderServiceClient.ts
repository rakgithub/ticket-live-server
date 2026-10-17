import {
  CheckoutIdempotencyKeySchema,
  CheckoutResponseSchema,
  HttpErrorSchema,
  OrderListResponseSchema,
  type CheckoutRequest,
  type CheckoutResponse,
  type InternalCheckoutRequest,
  type OrderListResponse,
} from "@ticket-live/contracts";
import { z } from "zod";
import { env, serviceCredential } from "@ticket-live/runtime";
import { getTraceContext } from "@ticket-live/runtime";

const ReadinessSchema = z.object({ status: z.enum(["ready", "not_ready"]) });

export class OrderServiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "OrderServiceError";
  }
}

export class OrderServiceClient {
  private readonly baseUrl: string;
  private readonly serviceTokenOverride: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl?: string; serviceToken?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = (options.baseUrl ?? env.ORDER_SERVICE_URL).replace(/\/+$/, "");
    this.serviceTokenOverride = options.serviceToken
      ? z.string().regex(/^[\x21-\x7E]{32,}$/).parse(options.serviceToken)
      : undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async readiness(): Promise<boolean> {
    const result = await this.request("GET", "/health/ready");
    const parsed = ReadinessSchema.safeParse(result);
    return parsed.success && parsed.data.status === "ready";
  }

  async checkout(
    userId: string,
    input: CheckoutRequest,
    customer: InternalCheckoutRequest["customer"],
    idempotencyKey: string,
  ): Promise<CheckoutResponse> {
    const body: InternalCheckoutRequest = { ...input, customer };
    return CheckoutResponseSchema.parse(await this.request(
      "POST",
      "/internal/orders/checkout",
      body,
      userId,
      CheckoutIdempotencyKeySchema.parse(idempotencyKey),
    ));
  }

  async listOrders(userId: string): Promise<OrderListResponse> {
    return OrderListResponseSchema.parse(await this.request(
      "GET",
      "/internal/orders",
      undefined,
      userId,
    ));
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    actorUserId?: string,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const token = this.serviceTokenOverride ?? serviceCredential("public-api-order");
    if (!token) throw new OrderServiceError("Order service authentication is not configured", 503);
    const trace = getTraceContext();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.ORDER_SERVICE_TIMEOUT_MS);
    let response: Response;
    let data: unknown;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(actorUserId ? { "x-actor-user-id": actorUserId } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          ...(trace ? {
            "x-correlation-id": trace.correlationId,
            traceparent: trace.traceparent,
            ...(trace.tracestate ? { tracestate: trace.tracestate } : {}),
          } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      try {
        data = await response.json();
      } catch {
        throw new OrderServiceError("Order service returned invalid JSON", 502);
      }
    } catch (error) {
      if (error instanceof OrderServiceError) throw error;
      throw new OrderServiceError("Order service is unavailable; retry with the same Idempotency-Key", 503);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const parsed = HttpErrorSchema.safeParse(data);
      throw new OrderServiceError(parsed.success ? parsed.data.error : "Order service request failed", response.status);
    }
    return data;
  }
}

let client: OrderServiceClient | undefined;
export function getOrderServiceClient(): OrderServiceClient {
  client ??= new OrderServiceClient();
  return client;
}

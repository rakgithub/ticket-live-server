import {
  HttpErrorSchema,
  InternalPaymentChargeRequestSchema,
  InternalPaymentRecordSchema,
  type InternalPaymentChargeRequest,
  type InternalPaymentRecord,
} from "@ticket-live/contracts";
import { z } from "zod";
import { env, serviceCredential } from "@ticket-live/runtime";
import { getTraceContext } from "@ticket-live/runtime";

const deadlineMs = env.PAYMENT_SERVICE_TIMEOUT_MS;

export class PaymentServiceError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class PaymentServiceClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl?: string; serviceToken?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = (options.baseUrl ?? env.PAYMENT_SERVICE_URL).replace(/\/+$/, "");
    const token = options.serviceToken ?? serviceCredential("order-payment");
    if (!token) throw new PaymentServiceError("Payment service authentication is not configured", 503);
    this.serviceToken = z.string().regex(/^[\x21-\x7E]{32,}$/).parse(token);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  charge(request: InternalPaymentChargeRequest): Promise<InternalPaymentRecord> {
    return this.request("POST", "/internal/payments", InternalPaymentChargeRequestSchema.parse(request));
  }

  getByOrder(orderId: string): Promise<InternalPaymentRecord> {
    return this.request("GET", `/internal/payments/${z.uuid().parse(orderId)}`);
  }

  cancel(orderId: string): Promise<InternalPaymentRecord> {
    return this.request("POST", `/internal/payments/${z.uuid().parse(orderId)}/cancel`);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: InternalPaymentChargeRequest,
  ): Promise<InternalPaymentRecord> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const traceContext = getTraceContext();
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.serviceToken}`,
          ...(traceContext ? {
            "x-correlation-id": traceContext.correlationId,
            traceparent: traceContext.traceparent,
            ...(traceContext.tracestate ? { tracestate: traceContext.tracestate } : {}),
          } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        throw new PaymentServiceError("Payment service returned invalid JSON", 502);
      }
      if (!response.ok) {
        const parsed = HttpErrorSchema.safeParse(responseBody);
        throw new PaymentServiceError(parsed.success ? parsed.data.error : "Payment service request failed", response.status);
      }
      const parsed = InternalPaymentRecordSchema.safeParse(responseBody);
      if (!parsed.success) throw new PaymentServiceError("Payment service returned an invalid payment", 502);
      return parsed.data;
    } catch (error) {
      if (error instanceof PaymentServiceError) throw error;
      throw new PaymentServiceError("Payment service is unavailable", 503);
    } finally {
      clearTimeout(timeout);
    }
  }
}

let configuredClient: PaymentServiceClient | undefined;

export function getPaymentClient(): PaymentServiceClient {
  configuredClient ??= new PaymentServiceClient();
  return configuredClient;
}

import {
  HttpErrorSchema,
  TicketListResponseSchema,
  type Ticket,
  type TicketListResponse,
} from "@ticket-live/contracts";
import { env, serviceCredential } from "@ticket-live/runtime";
import { getTraceContext } from "@ticket-live/runtime";
import { z } from "zod";

const ReadinessSchema = z.object({ status: z.enum(["ready", "not_ready"]) });

export class TicketingServiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "TicketingServiceError";
  }
}

export class TicketingServiceClient {
  private readonly baseUrl: string;
  private readonly serviceTokenOverride: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl?: string; serviceToken?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = (options.baseUrl ?? env.TICKETING_SERVICE_URL).replace(/\/+$/, "");
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

  async listTickets(orderIds: string[]): Promise<TicketListResponse> {
    const tickets: Ticket[] = [];
    for (let offset = 0; offset < orderIds.length; offset += 500) {
      const result = TicketListResponseSchema.parse(await this.request(
        "POST",
        "/internal/tickets/query",
        { orderIds: orderIds.slice(offset, offset + 500) },
      ));
      tickets.push(...result.tickets);
    }
    tickets.sort((left, right) => Date.parse(left.issuedAt) - Date.parse(right.issuedAt) ||
      left.ticketNumber - right.ticketNumber);
    return TicketListResponseSchema.parse({ tickets });
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const token = this.serviceTokenOverride ?? serviceCredential("public-api-ticketing");
    if (!token) throw new TicketingServiceError("Ticketing service authentication is not configured", 503);
    const trace = getTraceContext();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.TICKETING_SERVICE_TIMEOUT_MS);
    let response: Response;
    let data: unknown;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
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
        throw new TicketingServiceError("Ticketing service returned invalid JSON", 502);
      }
    } catch (error) {
      if (error instanceof TicketingServiceError) throw error;
      throw new TicketingServiceError("Ticketing service is unavailable", 503);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const parsed = HttpErrorSchema.safeParse(data);
      throw new TicketingServiceError(parsed.success ? parsed.data.error : "Ticketing service request failed", response.status);
    }
    return data;
  }
}

let client: TicketingServiceClient | undefined;
export function getTicketingServiceClient(): TicketingServiceClient {
  client ??= new TicketingServiceClient();
  return client;
}

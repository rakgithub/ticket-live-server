import {
  EventCreateResponseSchema,
  EventListResponseSchema,
  EventSearchResponseSchema,
  HttpErrorSchema,
  InternalEventChatCardsResponseSchema,
  InternalEventSearchCandidatesResponseSchema,
  type EventChatCard,
  type EventGenre,
  type EventSearchCandidate,
} from "@ticket-live/contracts";
import { z } from "zod";
import { env, serviceCredential } from "@ticket-live/runtime";
import { getTraceContext } from "@ticket-live/runtime";

const EventReadinessSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  checks: z.object({ postgres: z.boolean(), elasticsearch: z.boolean() }),
});

export type EventCreateInput = {
  name: string; description: string; location: string; minPeople: number; maxPeople: number;
  ticketPriceCents: number; currencyCode: string; servesAlcohol: boolean; startsAt: string;
  genre?: EventGenre | null;
};

export class EventServiceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class EventServiceClient {
  private readonly baseUrl = env.EVENT_SERVICE_URL.replace(/\/+$/, "");

  async listEvents() { return EventListResponseSchema.parse(await this.request("GET", "/internal/events")); }
  async readiness() { return EventReadinessSchema.parse(await this.request("GET", "/health/ready")); }
  async search(query: string, limit: number) {
    return EventSearchResponseSchema.parse(await this.request("GET", `/internal/events/search?q=${encodeURIComponent(query)}&limit=${limit}`));
  }
  async createEvent(input: EventCreateInput, userId: string) {
    return EventCreateResponseSchema.parse(await this.request("POST", "/internal/events", input, userId));
  }
  async searchCandidates(criteria: { text?: string; location?: string; genre?: EventGenre }, limit: number): Promise<EventSearchCandidate[]> {
    const query = new URLSearchParams({ limit: String(limit), ...criteria });
    return InternalEventSearchCandidatesResponseSchema.parse(await this.request("GET", `/internal/event-search?${query}`)).candidates;
  }
  async getCards(
    ids: string[],
    limit: number,
    filters: { genre?: EventGenre; location?: string } = {},
  ): Promise<EventChatCard[]> {
    const query = new URLSearchParams({ ids: ids.join(","), limit: String(limit), ...filters });
    return InternalEventChatCardsResponseSchema.parse(await this.request("GET", `/internal/event-cards?${query}`)).cards;
  }
  private async request(method: "GET" | "POST", path: string, body?: unknown, actorUserId?: string): Promise<unknown> {
    const serviceToken = serviceCredential("public-api-event");
    if (!serviceToken) throw new EventServiceError("Event service authentication is not configured", 503);
    const trace = getTraceContext();
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      response = await fetch(`${this.baseUrl}${path}`, { method, headers: {
        authorization: `Bearer ${serviceToken}`,
        ...(actorUserId ? { "x-actor-user-id": actorUserId } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...(trace ? { "x-correlation-id": trace.correlationId, traceparent: trace.traceparent } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal });
    } catch { clearTimeout(timeout); throw new EventServiceError("Event service is unavailable", 503); }
    let data: unknown;
    try { data = await response.json(); } catch { clearTimeout(timeout); throw new EventServiceError("Event service returned invalid JSON", 502); }
    clearTimeout(timeout);
    if (!response.ok) {
      const parsed = HttpErrorSchema.safeParse(data);
      throw new EventServiceError(parsed.success ? parsed.data.error : "Event service request failed", response.status);
    }
    return data;
  }
}

let client: EventServiceClient | undefined;
export function getEventServiceClient(): EventServiceClient { client ??= new EventServiceClient(); return client; }

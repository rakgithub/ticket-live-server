import { describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  allEvents: vi.fn(),
  search: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
  candidates: vi.fn(),
  cards: vi.fn(),
}));
vi.mock("../services/eventsService.ts", () => ({
  getEvents: services.allEvents,
  searchEvents: services.search,
  createEvent: services.create,
  updateEvent: services.update,
  cancelEvent: services.cancel,
  deleteEvent: services.remove,
  getEventChatCards: services.cards,
  EventUpdateError: class EventUpdateError extends Error {},
}));
vi.mock("../services/eventsSearchService.ts", () => ({
  searchEventCandidates: services.candidates,
  searchEvents: services.search,
  EventSearchUnavailableError: class EventSearchUnavailableError extends Error {},
}));

import {
  createEventController,
  eventCards,
  eventSearchCandidates,
  listEvents,
  searchEventsController,
  updateEventController,
} from "./eventsController.ts";

function createResponse() {
  return {
    code: 200,
    body: undefined as unknown,
    status(code: number) {
      this.code = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

describe("event controllers", () => {
  it("lists events and rejects invalid search and card queries", async () => {
    services.allEvents.mockResolvedValueOnce([]);
    const listRes = createResponse();
    await listEvents({} as never, listRes as never);
    expect(listRes.body).toEqual({ events: [] });

    const invalidSearch = createResponse();
    await searchEventsController({ query: {} } as never, invalidSearch as never);
    expect(invalidSearch.code).toBe(400);

    const invalidCards = createResponse();
    await eventCards({ query: { ids: "bad" } } as never, invalidCards as never);
    expect(invalidCards.code).toBe(400);

    const invalidCandidates = createResponse();
    await eventSearchCandidates(
      { query: { genre: "bad" } } as never,
      invalidCandidates as never,
    );
    expect(invalidCandidates.code).toBe(400);
  });

  it("rejects invalid create and update requests before calling services", async () => {
    const createRes = createResponse();
    await createEventController(
      { body: {}, header: () => "bad" } as never,
      createRes as never,
    );
    expect(createRes.code).toBe(400);

    const updateRes = createResponse();
    await updateEventController(
      { params: { eventId: "bad" }, header: () => "bad", body: {} } as never,
      updateRes as never,
    );
    expect(updateRes.code).toBe(400);
    expect(services.create).not.toHaveBeenCalled();
    expect(services.update).not.toHaveBeenCalled();
    expect(services.cancel).not.toHaveBeenCalled();
    expect(services.remove).not.toHaveBeenCalled();
  });
});

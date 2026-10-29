type EventChatFinishReason = "completed" | "empty" | "unsupported" | "clarification" | "error";

const finishReasons: EventChatFinishReason[] = ["completed", "empty", "unsupported", "clarification", "error"];
const finishedRequests = new Map<EventChatFinishReason, number>(finishReasons.map((reason) => [reason, 0]));
let genreIntentOverrides = 0;
let rejectedCards = 0;

export function recordEventChatFinish(reason: EventChatFinishReason): void {
  finishedRequests.set(reason, (finishedRequests.get(reason) ?? 0) + 1);
}

export function recordEventChatGenreOverride(): void {
  genreIntentOverrides += 1;
}

export function recordEventChatRejectedCards(count: number): void {
  rejectedCards += count;
}

function renderCounter(name: string, help: string, value: number): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name} ${value}`];
}

export function renderEventChatMetrics(): string {
  const lines = [
    "# HELP ticketlive_event_chat_requests_total Completed event chat requests by outcome.",
    "# TYPE ticketlive_event_chat_requests_total counter",
  ];
  for (const reason of finishReasons) {
    lines.push(`ticketlive_event_chat_requests_total{outcome="${reason}"} ${finishedRequests.get(reason) ?? 0}`);
  }
  lines.push(
    ...renderCounter(
      "ticketlive_event_chat_genre_intent_overrides_total",
      "Explicit genre words that overrode a conflicting or missing model genre.",
      genreIntentOverrides,
    ),
    ...renderCounter(
      "ticketlive_event_chat_rejected_cards_total",
      "Event cards rejected by the final chat response filter.",
      rejectedCards,
    ),
  );
  return `${lines.join("\n")}\n`;
}

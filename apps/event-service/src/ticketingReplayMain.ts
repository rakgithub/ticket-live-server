process.env.TICKETLIVE_SERVICE = "event";
await import("./scripts/replayTicketInvalidations.ts");

process.env.TICKETLIVE_SERVICE = "order";
await import("./scripts/replayConfirmedTickets.ts");

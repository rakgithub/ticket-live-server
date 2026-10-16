// Select the Order-owned database credential before loading shared modules.
process.env.TICKETLIVE_SERVICE = "order";
await import("./server.ts");

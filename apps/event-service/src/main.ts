// Select the service-owned database credential before loading the shared
// configuration and database pool modules.
process.env.TICKETLIVE_SERVICE = "event";
await import("./server.ts");

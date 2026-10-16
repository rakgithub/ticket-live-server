process.env.TICKETLIVE_SERVICE = "order";
await import("./outboxWorkerMain.ts");

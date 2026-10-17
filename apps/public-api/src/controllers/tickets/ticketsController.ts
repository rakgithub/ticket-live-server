import type { Request, Response } from "express";
import { createLogger } from "@ticket-live/runtime";
import { getOrderServiceClient, OrderServiceError } from "../../clients/orderServiceClient.ts";
import { getTicketingServiceClient, TicketingServiceError } from "../../clients/ticketingServiceClient.ts";

const logger = createLogger("ticket-live-public-api");

export async function getTickets(req: Request, res: Response): Promise<void> {
  if (!req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const { orders } = await getOrderServiceClient().listOrders(req.auth.userId);
    const confirmedOrderIds = orders.filter((order) => order.status === "confirmed").map((order) => order.id);
    const ticketList = await getTicketingServiceClient().listTickets(confirmedOrderIds);
    res.status(200).json(ticketList);
  } catch (error) {
    if (error instanceof OrderServiceError || error instanceof TicketingServiceError) {
      logger.error("Ticket list request failed", { statusCode: error.status });
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
}

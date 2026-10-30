import type { Request, Response } from "express";
import { HttpErrorSchema, InternalTicketQueryRequestSchema, TicketCheckInRequestSchema, TicketCheckInResponseSchema, TicketListResponseSchema } from "@ticket-live/contracts";
import { checkInTicket, listTicketsForOrders, TicketCheckInError } from "../services/ticketService.ts";

export async function queryTickets(req: Request, res: Response): Promise<void> {
  const parsed = InternalTicketQueryRequestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid ticket query" }); return; }
  const records = await listTicketsForOrders(parsed.data.orderIds);
  const tickets = records.map((ticket) => ({ ...ticket, issuedAt: ticket.issuedAt.toISOString(), eventStartsAt: ticket.eventStartsAt.toISOString(), checkInAt: ticket.checkInAt?.toISOString() ?? null }));
  res.json(TicketListResponseSchema.parse({ tickets }));
}
export async function checkIn(req: Request, res: Response): Promise<void> {
  const parsed = TicketCheckInRequestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid ticket check-in request" }); return; }
  try {
    const ticket = await checkInTicket(parsed.data);
    res.json(TicketCheckInResponseSchema.parse({ ticket: { ...ticket, issuedAt: ticket.issuedAt.toISOString(), eventStartsAt: ticket.eventStartsAt.toISOString(), checkInAt: ticket.checkInAt?.toISOString() ?? null } }));
  } catch (error) {
    if (error instanceof TicketCheckInError) { res.status(error.status).json(HttpErrorSchema.parse({ error: error.message })); return; }
    throw error;
  }
}

/** RabbitMQ names are part of the versioned Order-to-Email transport contract. */
export const orderConfirmationQueueName = "booking-confirmation-email";
export const emailSendExchangeName = "ticket-live.email";
export const emailSendQueueName = "email.send.v1";
export const emailSendRoutingKey = "email.send.v1";
export const emailSendRetryExchangeName = "ticket-live.email.retry";
export const emailSendRetryQueueName = "email.send.v1.retry";
export const emailSendRetryRoutingKey = "email.send.v1.retry";
export const emailSendDeadLetterExchangeName = "ticket-live.email.dead";
export const emailSendDeadLetterQueueName = "email.send.v1.dlq";
export const emailSendDeadLetterRoutingKey = "email.send.v1.dead";

/** Order and Event publish domain facts for the Ticketing service. */
export const ticketingEventsExchangeName = "ticket-live.ticketing";
export const ticketingEventsQueueName = "ticketing.events.v1";
export const ticketingEventsRoutingKey = "ticketing.events.v1";
export const ticketingEventsRetryExchangeName = "ticket-live.ticketing.retry";
export const ticketingEventsRetryQueueName = "ticketing.events.v1.retry";
export const ticketingEventsRetryRoutingKey = "ticketing.events.v1.retry";
export const ticketingEventsDeadLetterExchangeName = "ticket-live.ticketing.dead";
export const ticketingEventsDeadLetterQueueName = "ticketing.events.v1.dlq";
export const ticketingEventsDeadLetterRoutingKey = "ticketing.events.v1.dead";

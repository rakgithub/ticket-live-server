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

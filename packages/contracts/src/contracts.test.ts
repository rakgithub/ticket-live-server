import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  CheckoutResponseSchema,
  EmailSendV1Schema,
  OrderConfirmedV1Schema,
  parseOrderConfirmedMessage,
  TicketingOrderConfirmedV1Schema,
} from "./index.ts";

type DocumentedObjectSchema = {
  required?: string[];
  properties?: Record<string, unknown>;
};

function assertDocumentMatchesZod(
  documented: unknown,
  schema: z.ZodType,
  context: string,
): void {
  expect(documented, `${context} should be an object`).toEqual(expect.any(Object));
  if (typeof documented !== "object" || documented === null) return;
  expect(schema, `${context} should use an object Zod schema`).toBeInstanceOf(z.ZodObject);
  if (!(schema instanceof z.ZodObject)) return;

  const documentedObject = documented as DocumentedObjectSchema;
  const documentedProperties = documentedObject.properties ?? {};
  const shape = schema.shape;
  expect(Object.keys(documentedProperties).sort()).toEqual(Object.keys(shape).sort());

  const documentedRequired = [...(documentedObject.required ?? [])].sort();
  const zodRequired = Object.entries(shape)
    .filter(([, field]) => !field.isOptional())
    .map(([name]) => name)
    .sort();
  expect(documentedRequired).toEqual(zodRequired);

  for (const [name, field] of Object.entries(shape)) {
    const child = documentedProperties[name];
    if (
      child && typeof child === "object" && "properties" in child &&
      field instanceof z.ZodObject
    ) {
      assertDocumentMatchesZod(child, field, `${context}.${name}`);
    }
  }
}

async function readExample(name: string): Promise<unknown> {
  const contents = await readFile(
    resolve(process.cwd(), "docs/contracts/examples", name),
    "utf8",
  );
  return JSON.parse(contents) as unknown;
}

describe("versioned message contract examples", () => {
  it("enforces the checkout amount invariant documented in OpenAPI", async () => {
    const openApi = await readFile(
      resolve(process.cwd(), "docs/contracts/openapi.yaml"),
      "utf8",
    );
    const validResponse = {
      event: {
        id: "1dc646c7-bd99-4bd5-9537-df2c61d23e96",
        name: "Example Concert",
      },
      order: {
        id: "e637ca0a-0b5f-42ce-a070-bfa9c05aaf1a",
        eventId: "1dc646c7-bd99-4bd5-9537-df2c61d23e96",
        quantity: 2,
        status: "confirmed",
        ticketPriceCents: 4_000,
        currencyCode: "EUR",
        totalAmountCents: 8_000,
        expiresAt: null,
        createdAt: "2026-10-13T10:00:00Z",
      },
      payment: {
        id: "97e911ad-0317-4619-a057-f52c99131281",
        status: "succeeded",
        gateway: "mock",
      },
    };

    expect(openApi).toContain("/orders/checkout:");
    expect(openApi).toContain("CheckoutResponse:");
    expect(CheckoutResponseSchema.parse(validResponse)).toEqual(validResponse);
    expect(CheckoutResponseSchema.safeParse({
      ...validResponse,
      order: { ...validResponse.order, totalAmountCents: 7_999 },
    }).success).toBe(false);
  });

  it("accepts the documented order confirmation and preserves its invariants", async () => {
    const example = await readExample("order-confirmed.v1.json");
    const parsed = OrderConfirmedV1Schema.parse(example);

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.aggregateId).toBe(parsed.data.orderId);
    expect(parsed.data.totalAmountCents).toBe(
      parsed.data.quantity * parsed.data.ticketPriceCents,
    );
  });

  it("accepts the documented email command and ignores additive fields", async () => {
    const example = await readExample("email-send.v1.json");
    const parsed = EmailSendV1Schema.parse({
      ...(example as Record<string, unknown>),
      futureOptionalField: "safe for older consumers",
    });

    expect(parsed.commandType).toBe("email.send");
    expect(parsed).not.toHaveProperty("futureOptionalField");
  });

  it("upgrades a persisted legacy order confirmation to the current v1 shape", async () => {
    const example = await readExample("order-confirmed.v1.json") as {
      eventId: string;
      eventType: string;
      occurredAt: string;
      data: unknown;
    };
    const legacy = {
      eventId: example.eventId,
      eventType: example.eventType,
      occurredAt: example.occurredAt,
      data: example.data,
    };

    const parsed = parseOrderConfirmedMessage(legacy);

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.aggregateId).toBe(parsed.data.orderId);
    expect(parsed.correlationId).toBe(parsed.eventId);
  });

  it("documents the same versioned messages in AsyncAPI", async () => {
    const asyncApiText = await readFile(
      resolve(process.cwd(), "docs/contracts/asyncapi.yaml"),
      "utf8",
    );
    const asyncApi = parse(asyncApiText) as {
      components?: { schemas?: Record<string, unknown> };
      channels?: Record<string, { publish?: { message?: { $ref?: string } } }>;
    };
    const messageSchemas = asyncApi.components?.schemas ?? {};

    expect(asyncApi.channels?.["booking-confirmation-email"]?.publish?.message?.$ref)
      .toBe("#/components/messages/OrderConfirmedV1");
    expect(asyncApi.channels?.["email.send.v1"]?.publish?.message?.$ref)
      .toBe("#/components/messages/EmailSendV1");
    assertDocumentMatchesZod(messageSchemas.OrderConfirmedV1, OrderConfirmedV1Schema, "OrderConfirmedV1");
    assertDocumentMatchesZod(messageSchemas.EmailSendV1, EmailSendV1Schema, "EmailSendV1");
    assertDocumentMatchesZod(messageSchemas.TicketingOrderConfirmedV1, TicketingOrderConfirmedV1Schema, "TicketingOrderConfirmedV1");

    const messageDocuments = asyncApi.components as {
      messages?: Record<string, { name?: string }>;
    } | undefined;
    expect(messageDocuments?.messages?.OrderConfirmedV1?.name).toBe("order.confirmed.v1");
    expect(messageDocuments?.messages?.EmailSendV1?.name).toBe("email.send.v1");
  });

  it("parses OpenAPI and matches the checkout response shape to Zod", async () => {
    const openApiText = await readFile(
      resolve(process.cwd(), "docs/contracts/openapi.yaml"),
      "utf8",
    );
    const openApi = parse(openApiText) as {
      paths?: Record<string, { post?: { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> } }>;
      components?: { schemas?: Record<string, unknown> };
    };
    const checkoutResponseRef = openApi.paths?.["/orders/checkout"]?.post?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref ??
      openApi.paths?.["/orders/checkout"]?.post?.responses?.["201"]?.content?.["application/json"]?.schema?.$ref;

    expect(checkoutResponseRef).toBe("#/components/schemas/CheckoutResponse");
    assertDocumentMatchesZod(
      openApi.components?.schemas?.CheckoutResponse,
      CheckoutResponseSchema,
      "CheckoutResponse",
    );
  });
});

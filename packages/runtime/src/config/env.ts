import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  TICKETLIVE_SERVICE: z.enum(["public-api", "order", "event", "email", "payment", "ticketing", "analytics"]).default("public-api"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4002),
  ORDER_SERVICE_PORT: z.coerce.number().int().min(1).max(65_535).default(4005),
  EVENT_SERVICE_PORT: z.coerce.number().int().min(1).max(65_535).default(4003),
  EMAIL_SERVICE_PORT: z.coerce.number().int().min(1).max(65_535).default(4004),
  PAYMENT_SERVICE_PORT: z.coerce.number().int().min(1).max(65_535).default(4006),
  TICKETING_SERVICE_PORT: z.coerce.number().int().min(1).max(65_535).default(4007),
  ANALYTICS_SERVICE_PORT: z.coerce.number().int().min(1).max(65_535).default(4008),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  DATABASE_URL: z.string().min(1).optional(),
  ORDER_SERVICE_DATABASE_URL: z.string().min(1).optional(),
  EVENT_SERVICE_DATABASE_URL: z.string().min(1).optional(),
  EMAIL_SERVICE_DATABASE_URL: z.string().min(1).optional(),
  PAYMENT_SERVICE_DATABASE_URL: z.string().min(1).optional(),
  TICKETING_SERVICE_DATABASE_URL: z.string().min(1).optional(),
  ELASTICSEARCH_URL: z.url("ELASTICSEARCH_URL must be a valid URL").default("http://localhost:9200"),
  GEMINI_API_KEY: z
    .string()
    .transform((value) => value.trim() || undefined)
    .optional(),
  EVENT_CHAT_MODEL: z.string().trim().min(1).default("gemini-3.8-flash"),
  EVENT_CHAT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(30_000),
  EVENT_CHAT_MAX_ACTIVE_PER_USER: z.coerce.number().int().min(1).max(10).default(2),
  // AMQP_URL remains a local compatibility fallback while deployments move to
  // one broker principal per service.
  AMQP_URL: z.string().default(""),
  ORDER_AMQP_URL: z.string().default(""),
  EVENT_AMQP_URL: z.string().default(""),
  EMAIL_AMQP_URL: z.string().default(""),
  TICKETING_AMQP_URL: z.string().default(""),
  RABBITMQ_AUTO_DECLARE_TOPOLOGY: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined)
    .pipe(z.url().optional()),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2_000),
  INVENTORY_HOLD_EXPIRY_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(2_000),
  INVENTORY_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  EMAIL_RETRY_DELAY_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
  EMAIL_MAX_RETRIES: z.coerce.number().int().min(0).max(20).default(5),
  TICKETING_RETRY_DELAY_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
  TICKETING_MAX_RETRIES: z.coerce.number().int().min(0).max(20).default(5),
  EMAIL_LEGACY_QUEUE_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  EMAIL_PROVIDER: z.enum(["fake"]).default("fake"),
  JWT_SECRET: z.string().default(""),
  INTERNAL_SERVICE_TOKEN: z
    .string()
    .regex(
      /^[\x21-\x7E]{32,}$/,
      "INTERNAL_SERVICE_TOKEN must be at least 32 printable ASCII bytes",
    )
    .optional(),
  PUBLIC_API_ORDER_TOKEN: z.string().regex(/^[\x21-\x7E]{32,}$/).optional(),
  PUBLIC_API_EVENT_TOKEN: z.string().regex(/^[\x21-\x7E]{32,}$/).optional(),
  ORDER_EVENT_TOKEN: z.string().regex(/^[\x21-\x7E]{32,}$/).optional(),
  EMAIL_INTERNAL_TOKEN: z.string().regex(/^[\x21-\x7E]{32,}$/).optional(),
  PUBLIC_API_TICKETING_TOKEN: z.string().regex(/^[\x21-\x7E]{32,}$/).optional(),
  TICKETING_CHECK_IN_TOKEN: z.string().regex(/^[\x21-\x7E]{32,}$/).optional(),
  ORDER_PAYMENT_TOKEN: z.string().regex(/^[\x21-\x7E]{32,}$/).optional(),
  ORDER_SERVICE_URL: z.url().default("http://localhost:4005"),
  ORDER_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(45_000),
  PAYMENT_SERVICE_URL: z.url().default("http://localhost:4006"),
  PAYMENT_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(45_000),
  INVENTORY_SERVICE_URL: z.url().default("http://localhost:4003"),
  EVENT_SERVICE_URL: z.url().default("http://localhost:4003"),
  TICKETING_SERVICE_URL: z.url().default("http://localhost:4007"),
  TICKETING_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(45_000),
  TICKETS_PORTAL_URL: z.url().default("http://localhost:3000/my-tickets"),
  ACCESS_TOKEN_TTL: z
    .string()
    .regex(/^\d+[smhd]$/, "ACCESS_TOKEN_TTL must look like 15m, 1h, or 1d")
    .default("15m"),
  MOCK_PAYMENT_DELAY_MS: z.coerce.number().int().min(0).max(30_000).default(1_500),
  MOCK_PAYMENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  PAYMENT_RESERVATION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3_600)
    .default(900),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000,http://localhost:5173"),
}).superRefine((values, context) => {
  if (values.TICKETLIVE_SERVICE === "event" && !values.EVENT_SERVICE_DATABASE_URL) {
    context.addIssue({
      code: "custom",
      path: ["EVENT_SERVICE_DATABASE_URL"],
      message: "EVENT_SERVICE_DATABASE_URL is required for the Event service",
    });
  }
  if (values.TICKETLIVE_SERVICE === "order" && !values.ORDER_SERVICE_DATABASE_URL) {
    context.addIssue({
      code: "custom",
      path: ["ORDER_SERVICE_DATABASE_URL"],
      message: "ORDER_SERVICE_DATABASE_URL is required for the Order service",
    });
  }
  if (values.TICKETLIVE_SERVICE === "email" && !values.EMAIL_SERVICE_DATABASE_URL) {
    context.addIssue({
      code: "custom",
      path: ["EMAIL_SERVICE_DATABASE_URL"],
      message: "EMAIL_SERVICE_DATABASE_URL is required for the Email service",
    });
  }
  if (values.TICKETLIVE_SERVICE === "payment" && !values.PAYMENT_SERVICE_DATABASE_URL) {
    context.addIssue({ code: "custom", path: ["PAYMENT_SERVICE_DATABASE_URL"], message: "PAYMENT_SERVICE_DATABASE_URL is required for the Payment service" });
  }
  if (values.TICKETLIVE_SERVICE === "ticketing" && !values.TICKETING_SERVICE_DATABASE_URL) {
    context.addIssue({ code: "custom", path: ["TICKETING_SERVICE_DATABASE_URL"], message: "TICKETING_SERVICE_DATABASE_URL is required for the Ticketing service" });
  }
  if (values.TICKETLIVE_SERVICE === "public-api" && !values.DATABASE_URL) {
    context.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "DATABASE_URL is required for the public API" });
  }
  if (values.TICKETLIVE_SERVICE === "public-api" && !values.JWT_SECRET) {
    context.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "JWT_SECRET is required for the public API" });
  }
  if (values.TICKETLIVE_SERVICE === "email" && !values.EMAIL_AMQP_URL && !values.AMQP_URL) {
    context.addIssue({ code: "custom", path: ["EMAIL_AMQP_URL"], message: "EMAIL_AMQP_URL is required for the Email service" });
  }
  if (values.TICKETLIVE_SERVICE === "order" && !values.ORDER_AMQP_URL && !values.AMQP_URL) {
    context.addIssue({ code: "custom", path: ["ORDER_AMQP_URL"], message: "ORDER_AMQP_URL is required for the Order service" });
  }
  if (values.TICKETLIVE_SERVICE === "event" && !values.EVENT_AMQP_URL && !values.AMQP_URL) {
    context.addIssue({ code: "custom", path: ["EVENT_AMQP_URL"], message: "EVENT_AMQP_URL is required for the Event service" });
  }
  if (values.TICKETLIVE_SERVICE === "ticketing" && !values.TICKETING_AMQP_URL && !values.AMQP_URL) {
    context.addIssue({ code: "custom", path: ["TICKETING_AMQP_URL"], message: "TICKETING_AMQP_URL is required for the Ticketing service" });
  }
  if (values.NODE_ENV === "production" && values.TICKETLIVE_SERVICE === "email") {
    context.addIssue({
      code: "custom",
      path: ["EMAIL_PROVIDER"],
      message: "The Email service has no production provider configured; refusing to use the fake provider",
    });
  }
  if (values.NODE_ENV === "production" && values.TICKETLIVE_SERVICE === "public-api" && !process.env.CORS_ORIGINS) {
    context.addIssue({
      code: "custom",
      path: ["CORS_ORIGINS"],
      message: "CORS_ORIGINS must be configured in production",
    });
  }
  if (values.NODE_ENV === "production") {
    const dedicatedTokens: Array<[string, string | undefined]> = values.TICKETLIVE_SERVICE === "public-api"
      ? [["PUBLIC_API_ORDER_TOKEN", values.PUBLIC_API_ORDER_TOKEN], ["PUBLIC_API_EVENT_TOKEN", values.PUBLIC_API_EVENT_TOKEN], ["PUBLIC_API_TICKETING_TOKEN", values.PUBLIC_API_TICKETING_TOKEN]]
      : values.TICKETLIVE_SERVICE === "order"
        ? [["PUBLIC_API_ORDER_TOKEN", values.PUBLIC_API_ORDER_TOKEN], ["ORDER_EVENT_TOKEN", values.ORDER_EVENT_TOKEN], ["ORDER_PAYMENT_TOKEN", values.ORDER_PAYMENT_TOKEN]]
      : values.TICKETLIVE_SERVICE === "event"
        ? [["PUBLIC_API_EVENT_TOKEN", values.PUBLIC_API_EVENT_TOKEN], ["ORDER_EVENT_TOKEN", values.ORDER_EVENT_TOKEN]]
        : values.TICKETLIVE_SERVICE === "payment"
          ? [["ORDER_PAYMENT_TOKEN", values.ORDER_PAYMENT_TOKEN]]
      : values.TICKETLIVE_SERVICE === "email"
        ? [["EMAIL_INTERNAL_TOKEN", values.EMAIL_INTERNAL_TOKEN]]
        : values.TICKETLIVE_SERVICE === "ticketing"
          ? [["PUBLIC_API_TICKETING_TOKEN", values.PUBLIC_API_TICKETING_TOKEN], ["TICKETING_CHECK_IN_TOKEN", values.TICKETING_CHECK_IN_TOKEN]]
          : [];
    for (const [name, token] of dedicatedTokens) {
      if (!token || /replace-with|change-me|^local-/i.test(token)) {
        context.addIssue({ code: "custom", path: [name], message: `${name} must be a unique production secret; INTERNAL_SERVICE_TOKEN is development-only` });
      }
    }
    if (new Set(dedicatedTokens.map(([, token]) => token)).size !== dedicatedTokens.length) {
      context.addIssue({ code: "custom", path: ["PUBLIC_API_EVENT_TOKEN"], message: "Each service relationship must use a different production credential" });
    }
    if ((values.TICKETLIVE_SERVICE === "order" || values.TICKETLIVE_SERVICE === "event" || values.TICKETLIVE_SERVICE === "email" || values.TICKETLIVE_SERVICE === "ticketing") && values.RABBITMQ_AUTO_DECLARE_TOPOLOGY) {
      context.addIssue({ code: "custom", path: ["RABBITMQ_AUTO_DECLARE_TOPOLOGY"], message: "Production services must use pre-provisioned RabbitMQ topology" });
    }
    if (values.TICKETLIVE_SERVICE === "order" && !values.ORDER_AMQP_URL) {
      context.addIssue({ code: "custom", path: ["ORDER_AMQP_URL"], message: "ORDER_AMQP_URL must be configured in production" });
    }
    if (values.TICKETLIVE_SERVICE === "event" && !values.EVENT_AMQP_URL) {
      context.addIssue({ code: "custom", path: ["EVENT_AMQP_URL"], message: "EVENT_AMQP_URL must be configured in production" });
    }
    if (values.TICKETLIVE_SERVICE === "ticketing" && !values.TICKETING_AMQP_URL) {
      context.addIssue({ code: "custom", path: ["TICKETING_AMQP_URL"], message: "TICKETING_AMQP_URL must be configured in production" });
    }
    if (values.TICKETLIVE_SERVICE === "email" && !values.EMAIL_AMQP_URL) {
      context.addIssue({ code: "custom", path: ["EMAIL_AMQP_URL"], message: "EMAIL_AMQP_URL must be configured in production" });
    }
    const requireTls = (value: string | undefined, name: string, protocol: string) => {
      let actualProtocol = "";
      try { actualProtocol = value ? new URL(value).protocol : ""; } catch { /* Report below. */ }
      if (actualProtocol !== protocol) {
        context.addIssue({ code: "custom", path: [name], message: `${name} must use ${protocol} in production` });
      }
    };
    if (values.TICKETLIVE_SERVICE !== "analytics") {
      const databaseSetting = values.TICKETLIVE_SERVICE === "public-api"
        ? "DATABASE_URL"
        : values.TICKETLIVE_SERVICE === "order"
          ? "ORDER_SERVICE_DATABASE_URL"
        : values.TICKETLIVE_SERVICE === "payment"
          ? "PAYMENT_SERVICE_DATABASE_URL"
          : values.TICKETLIVE_SERVICE === "ticketing"
            ? "TICKETING_SERVICE_DATABASE_URL"
          : values.TICKETLIVE_SERVICE === "event"
            ? "EVENT_SERVICE_DATABASE_URL"
            : "EMAIL_SERVICE_DATABASE_URL";
      const databaseUrl = values.TICKETLIVE_SERVICE === "public-api"
        ? values.DATABASE_URL
        : values.TICKETLIVE_SERVICE === "order"
          ? values.ORDER_SERVICE_DATABASE_URL
        : values.TICKETLIVE_SERVICE === "payment"
          ? values.PAYMENT_SERVICE_DATABASE_URL
        : values.TICKETLIVE_SERVICE === "ticketing"
          ? values.TICKETING_SERVICE_DATABASE_URL
        : values.TICKETLIVE_SERVICE === "event"
            ? values.EVENT_SERVICE_DATABASE_URL
            : values.EMAIL_SERVICE_DATABASE_URL;
      let databaseSslMode = "";
      try { databaseSslMode = databaseUrl ? new URL(databaseUrl).searchParams.get("sslmode") ?? "" : ""; } catch { /* Report below. */ }
      if (!new Set(["require", "verify-ca", "verify-full"]).has(databaseSslMode)) {
        context.addIssue({ code: "custom", path: [databaseSetting], message: "The service database URL must set sslmode=require or stricter in production" });
      }
    }
    if (values.TICKETLIVE_SERVICE === "public-api") {
      requireTls(values.EVENT_SERVICE_URL, "EVENT_SERVICE_URL", "https:");
      requireTls(values.ORDER_SERVICE_URL, "ORDER_SERVICE_URL", "https:");
      requireTls(values.TICKETING_SERVICE_URL, "TICKETING_SERVICE_URL", "https:");
      if (/replace-with|change-me|^local-/i.test(values.JWT_SECRET)) {
        context.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "Replace the example JWT secret in production" });
      }
    }
    if (values.TICKETLIVE_SERVICE === "order") {
      requireTls(values.INVENTORY_SERVICE_URL, "INVENTORY_SERVICE_URL", "https:");
      requireTls(values.PAYMENT_SERVICE_URL, "PAYMENT_SERVICE_URL", "https:");
      requireTls(values.ORDER_AMQP_URL, "ORDER_AMQP_URL", "amqps:");
      if (!process.env.TICKETS_PORTAL_URL) {
        context.addIssue({ code: "custom", path: ["TICKETS_PORTAL_URL"], message: "TICKETS_PORTAL_URL must be configured in production" });
      }
      requireTls(values.TICKETS_PORTAL_URL, "TICKETS_PORTAL_URL", "https:");
    }
    if (values.TICKETLIVE_SERVICE === "event") {
      requireTls(values.EVENT_AMQP_URL, "EVENT_AMQP_URL", "amqps:");
    }
    if (values.TICKETLIVE_SERVICE === "email") {
      requireTls(values.EMAIL_AMQP_URL, "EMAIL_AMQP_URL", "amqps:");
    }
    if (values.TICKETLIVE_SERVICE === "ticketing") {
      requireTls(values.TICKETING_AMQP_URL, "TICKETING_AMQP_URL", "amqps:");
    }
    if (values.TICKETLIVE_SERVICE === "event") {
      requireTls(values.ELASTICSEARCH_URL, "ELASTICSEARCH_URL", "https:");
    }
  }
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const details = parsedEnv.error.issues
    .map(({ path, message }) => `${path.join(".")}: ${message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${details}`);
}

if (
  parsedEnv.data.TICKETLIVE_SERVICE === "public-api" &&
  new TextEncoder().encode(parsedEnv.data.JWT_SECRET).length < 32
) {
  throw new Error(
    "Invalid environment configuration: JWT_SECRET must be at least 32 bytes",
  );
}

export const env = parsedEnv.data;

export type InternalCredential =
  | "public-api-order"
  | "public-api-event"
  | "order-event"
  | "order-payment"
  | "email-internal"
  | "public-api-ticketing"
  | "ticketing-check-in";

/** Local fallback is intentionally disabled in production. */
export function serviceCredential(name: InternalCredential): string | undefined {
  const dedicated = {
    "public-api-order": env.PUBLIC_API_ORDER_TOKEN,
    "public-api-event": env.PUBLIC_API_EVENT_TOKEN,
    "order-event": env.ORDER_EVENT_TOKEN,
    "order-payment": env.ORDER_PAYMENT_TOKEN,
    "email-internal": env.EMAIL_INTERNAL_TOKEN,
    "public-api-ticketing": env.PUBLIC_API_TICKETING_TOKEN,
    "ticketing-check-in": env.TICKETING_CHECK_IN_TOKEN,
  }[name];
  return dedicated ?? (env.NODE_ENV === "production" ? undefined : env.INTERNAL_SERVICE_TOKEN);
}

export const orderAmqpUrl = env.ORDER_AMQP_URL || env.AMQP_URL;
export const emailAmqpUrl = env.EMAIL_AMQP_URL || env.AMQP_URL;
export const eventAmqpUrl = env.EVENT_AMQP_URL || env.AMQP_URL;
export const ticketingAmqpUrl = env.TICKETING_AMQP_URL || env.AMQP_URL;

export const corsOrigins = new Set(
  env.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
);

if (corsOrigins.size === 0) {
  throw new Error(
    "Invalid environment configuration: CORS_ORIGINS must include at least one origin",
  );
}

for (const origin of corsOrigins) {
  if (new URL(origin).origin !== origin) {
    throw new Error(
      `Invalid environment configuration: ${origin} must be an origin without a path`,
    );
  }
}

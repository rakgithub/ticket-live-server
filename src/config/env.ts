import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  TICKETLIVE_SERVICE: z.enum(["public-api", "order", "event", "email"]).default("public-api"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4002),
  EVENT_SERVICE_PORT: z.coerce.number().int().min(1).max(65_535).default(4003),
  EMAIL_SERVICE_PORT: z.coerce.number().int().min(1).max(65_535).default(4004),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  DATABASE_URL: z.string().min(1).optional(),
  ORDER_SERVICE_DATABASE_URL: z.string().min(1).optional(),
  EVENT_SERVICE_DATABASE_URL: z.string().min(1).optional(),
  EMAIL_SERVICE_DATABASE_URL: z.string().min(1).optional(),
  ELASTICSEARCH_URL: z.url("ELASTICSEARCH_URL must be a valid URL").default("http://localhost:9200"),
  GEMINI_API_KEY: z
    .string()
    .transform((value) => value.trim() || undefined)
    .optional(),
  EVENT_CHAT_MODEL: z.string().trim().min(1).default("gemini-3.8-flash"),
  EVENT_CHAT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(30_000),
  EVENT_CHAT_MAX_ACTIVE_PER_USER: z.coerce.number().int().min(1).max(10).default(2),
  AMQP_URL: z.string().default(""),
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
  INVENTORY_SERVICE_URL: z.url().default("http://localhost:4003"),
  EVENT_SERVICE_URL: z.url().default("http://localhost:4003"),
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
  if (values.TICKETLIVE_SERVICE === "public-api" && !values.DATABASE_URL) {
    context.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "DATABASE_URL is required for the public API" });
  }
  if (values.TICKETLIVE_SERVICE === "public-api" && !values.JWT_SECRET) {
    context.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "JWT_SECRET is required for the public API" });
  }
  if (values.TICKETLIVE_SERVICE === "public-api" && !values.AMQP_URL) {
    context.addIssue({ code: "custom", path: ["AMQP_URL"], message: "AMQP_URL is required for the public API" });
  }
  if (values.TICKETLIVE_SERVICE === "email" && !values.AMQP_URL) {
    context.addIssue({ code: "custom", path: ["AMQP_URL"], message: "AMQP_URL is required for the Email service" });
  }
  if (values.TICKETLIVE_SERVICE === "order" && !values.AMQP_URL) {
    context.addIssue({ code: "custom", path: ["AMQP_URL"], message: "AMQP_URL is required for the Order service" });
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
  if (values.NODE_ENV === "production" && !values.INTERNAL_SERVICE_TOKEN) {
    context.addIssue({
      code: "custom",
      path: ["INTERNAL_SERVICE_TOKEN"],
      message: "INTERNAL_SERVICE_TOKEN must be configured in production",
    });
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

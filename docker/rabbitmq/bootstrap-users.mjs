import { Buffer } from "node:buffer";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const baseUrl = process.env.RABBITMQ_MANAGEMENT_URL;
const adminUser = process.env.RABBITMQ_ADMIN_USER;
const adminPassword = process.env.RABBITMQ_ADMIN_PASSWORD;

if (!baseUrl || !adminUser || !adminPassword) {
  throw new Error("RabbitMQ management URL and admin credentials are required");
}

const authorization = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString("base64")}`;

async function request(method, path, body) {
  const response = await globalThis.fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(`RabbitMQ management API returned ${response.status} for ${method} ${path}`);
  }
}

async function waitForManagement() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await request("GET", "/api/overview");
      return;
    } catch {
      await sleep(1_000);
    }
  }
  throw new Error("RabbitMQ management API did not become available within 60 seconds");
}

async function provisionUser(username, password, permissions) {
  if (!username || !password) throw new Error(`Credentials for ${username || "service"} are required`);
  await request("PUT", `/api/users/${encodeURIComponent(username)}`, { password, tags: "" });
  await request("PUT", `/api/permissions/%2F/${encodeURIComponent(username)}`, permissions);
}

await waitForManagement();
await provisionUser(
  process.env.TICKETLIVE_ORDER_AMQP_USER,
  process.env.TICKETLIVE_ORDER_AMQP_PASSWORD,
  {
    configure: "^(ticket-live\\.email|email\\.send\\.v1)$",
    write: "^ticket-live\\.email$",
    read: "",
  },
);
await provisionUser(
  process.env.TICKETLIVE_EMAIL_AMQP_USER,
  process.env.TICKETLIVE_EMAIL_AMQP_PASSWORD,
  {
    configure: "^(ticket-live\\.email.*|email\\.send\\.v1.*|booking-confirmation-email)$",
    write: "^ticket-live\\.email.*$",
    read: "^(email\\.send\\.v1|booking-confirmation-email)$",
  },
);
process.stdout.write("Created local Order and Email RabbitMQ users and permissions.\n");

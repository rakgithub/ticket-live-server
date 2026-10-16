import type { EmailSendV1 } from "@ticket-live/contracts";
import { env } from "@ticket-live/runtime";

export type ProviderAcceptance = {
  providerName: string;
  providerMessageId: string;
  acceptedAt: Date;
};

export interface EmailProvider {
  readonly name: string;
  readonly supportsIdempotencyKeys: boolean;
  send(input: { message: EmailSendV1; idempotencyKey: string }): Promise<ProviderAcceptance>;
  findByIdempotencyKey(idempotencyKey: string): Promise<ProviderAcceptance | undefined>;
}

export class EmailProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly outcome: "transient" | "permanent" | "unknown",
  ) {
    super(message);
    this.name = "EmailProviderError";
  }
}

/** Local adapter: records acceptance without sending a real email. */
class FakeEmailProvider implements EmailProvider {
  readonly name = "fake";
  readonly supportsIdempotencyKeys = true;
  private readonly accepted = new Map<string, ProviderAcceptance>();

  async send({ idempotencyKey }: { message: EmailSendV1; idempotencyKey: string }): Promise<ProviderAcceptance> {
    const prior = this.accepted.get(idempotencyKey);
    if (prior) return prior;

    const acceptance = {
      providerName: this.name,
      providerMessageId: `fake:${idempotencyKey}`,
      acceptedAt: new Date(),
    };
    this.accepted.set(idempotencyKey, acceptance);
    return acceptance;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<ProviderAcceptance | undefined> {
    return this.accepted.get(idempotencyKey);
  }
}

let provider: EmailProvider | undefined;

export function getEmailProvider(): EmailProvider {
  if (!provider) {
    if (env.EMAIL_PROVIDER !== "fake") {
      throw new Error("Configured Email provider is not implemented");
    }
    provider = new FakeEmailProvider();
  }
  return provider;
}

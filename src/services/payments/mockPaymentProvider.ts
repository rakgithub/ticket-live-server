import { env } from "../../config/env.ts";

export type MockPaymentRequest = {
  paymentId: string;
  amountCents: number;
  currencyCode: string;
};

export type MockPaymentResult = {
  status: "succeeded" | "failed";
};

/**
 * Keeps the payment-provider boundary in place until a real gateway is added.
 * Its delay and failure rate are configurable through the environment.
 */
export class MockPaymentProvider {
  async charge(_request: MockPaymentRequest): Promise<MockPaymentResult> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, env.MOCK_PAYMENT_DELAY_MS);
    });

    return {
      status:
        Math.random() < env.MOCK_PAYMENT_FAILURE_RATE ? "failed" : "succeeded",
    };
  }
}

export const mockPaymentProvider = new MockPaymentProvider();

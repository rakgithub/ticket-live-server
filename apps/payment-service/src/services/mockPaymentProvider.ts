import { env } from "@ticket-live/runtime";

export type PaymentChargeResult = { status: "succeeded" | "failed" };

export class MockPaymentProvider {
  async charge(): Promise<PaymentChargeResult> {
    await new Promise<void>((resolve) => setTimeout(resolve, env.MOCK_PAYMENT_DELAY_MS));
    return { status: Math.random() < env.MOCK_PAYMENT_FAILURE_RATE ? "failed" : "succeeded" };
  }
}

export const mockPaymentProvider = new MockPaymentProvider();

import { describe, expect, it } from "vitest";
import { renderEmailMetrics } from "./metrics.ts";

describe("Email Prometheus metrics", () => {
  it("exposes durable delivery outcomes and attempts without recipient data", () => {
    const output = renderEmailMetrics([{
      status: "accepted_by_provider",
      providerName: "fake",
      deliveryCount: 3,
      attemptsTotal: 4,
      activeRetries: 0,
      unknownProviderOutcomes: 0,
    }]);

    expect(output).toContain('ticketlive_email_delivery_records{provider="fake",status="accepted_by_provider"} 3');
    expect(output).toContain('ticketlive_email_delivery_attempts_total{provider="fake"} 4');
    expect(output).toContain('ticketlive_email_provider_outcomes{provider="fake",outcome="accepted_by_provider"} 3');
    expect(output).not.toContain("recipient");
  });

  it("normalizes provider labels and reports unknown outcomes", () => {
    const output = renderEmailMetrics([{
      status: "sending",
      providerName: "provider with customer data@example.com",
      deliveryCount: 1,
      attemptsTotal: 2,
      activeRetries: 1,
      unknownProviderOutcomes: 1,
    }]);

    expect(output).toContain('ticketlive_email_delivery_attempts_total{provider="other"} 2');
    expect(output).toContain('ticketlive_email_unknown_provider_outcomes{provider="other"} 1');
    expect(output).toContain('ticketlive_email_active_retries{provider="other"} 1');
    expect(output).not.toContain("customer data");
  });

  it("aggregates attempts across statuses into one provider series", () => {
    const output = renderEmailMetrics([
      {
        status: "failed",
        providerName: "fake",
        deliveryCount: 2,
        attemptsTotal: 3,
        activeRetries: 1,
        unknownProviderOutcomes: 0,
      },
      {
        status: "accepted_by_provider",
        providerName: "fake",
        deliveryCount: 4,
        attemptsTotal: 5,
        activeRetries: 2,
        unknownProviderOutcomes: 0,
      },
    ]);

    expect(output.match(/ticketlive_email_delivery_attempts_total\{provider="fake"\}/g)).toHaveLength(1);
    expect(output).toContain('ticketlive_email_delivery_attempts_total{provider="fake"} 8');
    expect(output).toContain('ticketlive_email_active_retries{provider="fake"} 3');
  });
});

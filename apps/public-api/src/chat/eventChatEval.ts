import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { env } from "@ticket-live/runtime";
import { eventDiscoveryGraph } from "./eventDiscoveryGraph.ts";
import { EventGenreSchema } from "@ticket-live/contracts";

const intentExpectationSchema = z.strictObject({
  isEventSearch: z.boolean().optional(),
  text: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  genre: EventGenreSchema.nullable().optional(),
  needsClarification: z.boolean().optional(),
});

const criteriaExpectationSchema = z.strictObject({
  text: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  genre: EventGenreSchema.nullable().optional(),
});

const evalCaseSchema = z.strictObject({
  id: z.string().min(1),
  message: z.string().min(1),
  expectedModelIntent: intentExpectationSchema,
  expectedCriteria: criteriaExpectationSchema,
  expectedFinishReasons: z.array(z.enum(["completed", "empty", "unsupported", "clarification"])).min(1),
  expectedCardConstraints: z.strictObject({
    genre: EventGenreSchema.optional(),
    location: z.string().min(1).optional(),
  }).optional(),
  expectedEventIds: z.array(z.uuid()).optional(),
  minPrecision: z.number().min(0).max(1).optional(),
  minRecall: z.number().min(0).max(1).optional(),
});

const datasetSchema = z.array(evalCaseSchema).min(1);
type EvalCase = z.infer<typeof evalCaseSchema>;
type FieldCheck = { field: string; expected: unknown; actual: unknown; passed: boolean };

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function matches(expected: unknown, actual: unknown): boolean {
  if (expected === null) return actual === undefined || actual === null;
  if (typeof expected === "string" && typeof actual === "string") {
    return normalize(expected) === normalize(actual);
  }
  return expected === actual;
}

function checkExpectedFields(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  prefix: string,
): FieldCheck[] {
  return Object.entries(expected).map(([field, value]) => ({
    field: `${prefix}.${field}`,
    expected: value,
    actual: actual[field],
    passed: matches(value, actual[field]),
  }));
}

function checkCardConstraints(testCase: EvalCase, cards: Array<Record<string, unknown>>): FieldCheck[] {
  const constraints = testCase.expectedCardConstraints;
  if (!constraints) return [];

  const checks: FieldCheck[] = [];
  for (const [index, card] of cards.entries()) {
    if (constraints.genre) {
      checks.push({
        field: `cards[${index}].genre`,
        expected: constraints.genre,
        actual: card.genre,
        passed: card.genre === constraints.genre,
      });
    }
    if (constraints.location) {
      const location = typeof card.location === "string" ? card.location : "";
      checks.push({
        field: `cards[${index}].location contains ${constraints.location}`,
        expected: constraints.location,
        actual: location,
        passed: normalize(location).includes(normalize(constraints.location)),
      });
    }
  }

  return checks;
}

function scoreLabeledResults(testCase: EvalCase, cards: Array<Record<string, unknown>>) {
  if (!testCase.expectedEventIds) return undefined;

  const expected = new Set(testCase.expectedEventIds);
  const actual = new Set(cards.map((card) => String(card.id)));
  const relevantReturned = [...actual].filter((id) => expected.has(id)).length;
  const precision = actual.size === 0 ? (expected.size === 0 ? 1 : 0) : relevantReturned / actual.size;
  const recall = expected.size === 0 ? 1 : relevantReturned / expected.size;
  const minPrecision = testCase.minPrecision ?? 0.8;
  const minRecall = testCase.minRecall ?? 0.8;

  return {
    expectedRelevantEventIds: expected.size,
    returnedEventCount: actual.size,
    relevantReturned,
    precision,
    recall,
    minPrecision,
    minRecall,
    passed: precision >= minPrecision && recall >= minRecall,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let caseFilter: string | undefined;
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== "--case") {
      throw new Error("Usage: pnpm eval:event-chat [--case <case-id>]");
    }
    caseFilter = args[1];
  }

  const datasetPath = fileURLToPath(new URL("./evals/event-chat.json", import.meta.url));
  const dataset = datasetSchema.parse(JSON.parse(await readFile(datasetPath, "utf8")));
  const selectedCases = caseFilter ? dataset.filter(({ id }) => id === caseFilter) : dataset;
  if (selectedCases.length === 0) throw new Error(`No evaluation case found for: ${caseFilter}`);
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required to run event chat evaluation");

  const caseResults = [];
  for (const testCase of selectedCases) {
    // Expected values are only used by this runner after the production graph
    // has returned; they are never included in the model request.
    const result = await eventDiscoveryGraph.invoke({
      message: testCase.message,
      limit: 5,
      generateSummary: false,
      isEventSearch: false,
      modelIntent: null,
      modelCriteria: {},
      criteria: {},
      candidates: [],
      cards: [],
      summary: "",
      finishReason: "completed",
    });

    const modelIntent = result.modelIntent ?? {};
    const cards = result.cards as Array<Record<string, unknown>>;
    const fieldChecks = [
      ...checkExpectedFields(testCase.expectedModelIntent, modelIntent, "modelIntent"),
      ...checkExpectedFields(testCase.expectedCriteria, result.criteria, "criteria"),
      {
        field: "finishReason",
        expected: testCase.expectedFinishReasons,
        actual: result.finishReason,
        passed: testCase.expectedFinishReasons.includes(result.finishReason),
      },
      ...checkCardConstraints(testCase, cards),
    ];
    const relevance = scoreLabeledResults(testCase, cards);
    if (relevance) {
      fieldChecks.push({
        field: "labeledResultRelevance",
        expected: `precision >= ${relevance.minPrecision}, recall >= ${relevance.minRecall}`,
        actual: { precision: relevance.precision, recall: relevance.recall },
        passed: relevance.passed,
      });
    }

    caseResults.push({
      id: testCase.id,
      passed: fieldChecks.every(({ passed }) => passed),
      checks: fieldChecks,
      modelIntent,
      modelCriteria: result.modelCriteria,
      finalCriteria: result.criteria,
      finishReason: result.finishReason,
      returnedEventIds: cards.map(({ id }) => id),
      relevance: relevance ?? "not labeled",
    });
  }

  const checks = caseResults.flatMap(({ checks: resultChecks }) => resultChecks);
  const labeledResults = caseResults.flatMap(({ relevance }) =>
    typeof relevance === "object" && relevance !== null ? [relevance] : [],
  );
  const passedChecks = checks.filter(({ passed }) => passed).length;
  const summarizeChecks = (prefix: string) => {
    const group = checks.filter(({ field }) => field.startsWith(prefix));
    const passed = group.filter(({ passed }) => passed).length;
    return {
      passed,
      total: group.length,
      accuracy: group.length === 0 ? null : passed / group.length,
    };
  };
  const cardChecks = checks.filter(({ field }) => field.startsWith("cards["));
  const report = {
    model: env.EVENT_CHAT_MODEL,
    evaluatedAt: new Date().toISOString(),
    caseCount: caseResults.length,
    passedCases: caseResults.filter(({ passed }) => passed).length,
    failedCases: caseResults.filter(({ passed }) => !passed).map(({ id }) => id),
    fieldChecks: { passed: passedChecks, total: checks.length },
    modelIntentAccuracy: summarizeChecks("modelIntent."),
    finalCriteriaAccuracy: summarizeChecks("criteria."),
    finishReasonAccuracy: summarizeChecks("finishReason"),
    cardFilterViolations: cardChecks.filter(({ passed }) => !passed).length,
    cardFilterChecks: cardChecks.length,
    labeledResultCases: labeledResults.length,
    labeledResultMacroPrecision: labeledResults.length
      ? labeledResults.reduce((sum, item) => sum + item.precision, 0) / labeledResults.length
      : null,
    labeledResultMacroRecall: labeledResults.length
      ? labeledResults.reduce((sum, item) => sum + item.recall, 0) / labeledResults.length
      : null,
    cases: caseResults,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.failedCases.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

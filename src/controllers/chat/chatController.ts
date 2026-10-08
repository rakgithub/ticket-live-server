import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { acquireUserStream } from "../../chat/activeStreams.ts";
import {
  eventChatInputSchema,
  eventDiscoveryGraph,
} from "../../chat/eventDiscoveryGraph.ts";
import { env } from "../../config/env.ts";
import { EventSearchUnavailableError } from "../../services/events/eventsSearchService.ts";

type PublicStreamError =
  | "request_timeout"
  | "search_unavailable"
  | "provider_quota_exhausted"
  | "chat_failed";

function getErrorStatus(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }

  return undefined;
}

function causedBy(error: unknown, errorName: string): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current.name === errorName) return true;
    current = current.cause;
  }
  return false;
}

function writeSse(res: Response, event: string, data: unknown): boolean {
  if (res.destroyed || res.writableEnded) return false;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return res.write(frame);
}

async function waitForDrainOrClose(res: Response): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;

  return new Promise((resolve) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(!res.destroyed && !res.writableEnded);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };

    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

function getText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("");
}

export async function streamEventSearch(req: Request, res: Response): Promise<void> {
  const parsed = eventChatInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid chat request" });
    return;
  }

  if (!req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (!env.GEMINI_API_KEY) {
    res.status(503).json({ error: "Event chat is not configured" });
    return;
  }

  const releaseStream = acquireUserStream(req.auth.userId);
  if (!releaseStream) {
    res.status(429).json({ error: "Too many active chat requests" });
    return;
  }

  const requestId = randomUUID();
  const abortController = new AbortController();
  let disconnected = false;
  let timedOut = false;
  let resultsSent = false;
  let summaryTextSent = false;
  let finishReason: "completed" | "empty" | "unsupported" = "completed";

  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort(new Error("Event chat request timed out"));
  }, env.EVENT_CHAT_TIMEOUT_MS);

  const onClose = () => {
    if (!res.writableEnded) {
      disconnected = true;
      abortController.abort(new Error("Client disconnected"));
    }
  };

  try {
    res.on("close", onClose);
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    writeSse(res, "status", { requestId, phase: "interpreting" });

    const stream = await eventDiscoveryGraph.stream(
      {
        message: parsed.data.message,
        limit: parsed.data.limit,
        isEventSearch: false,
        criteria: {},
        candidates: [],
        cards: [],
        summary: "",
        finishReason: "completed",
      },
      { streamMode: ["updates", "messages"], signal: abortController.signal },
    );

    for await (const [mode, chunk] of stream) {
      if (disconnected || abortController.signal.aborted) break;

      if (mode === "updates") {
        const updates = chunk as Record<string, Record<string, unknown>>;
        for (const [nodeName, update] of Object.entries(updates)) {
          if (nodeName === "interpretSearch" && update.isEventSearch === true) {
            writeSse(res, "status", { requestId, phase: "searching" });
          } else if (nodeName === "hydrateCards") {
            const cards = update.cards;
            const count = Array.isArray(cards) ? cards.length : 0;
            if (update.finishReason === "empty") finishReason = "empty";
            if (!writeSse(res, "results", { requestId, events: cards, count })) {
              if (!(await waitForDrainOrClose(res))) {
                disconnected = true;
                abortController.abort(new Error("Client disconnected"));
                break;
              }
            }
            resultsSent = true;
          } else if (nodeName === "interpretSearch" && update.finishReason === "unsupported") {
            finishReason = "unsupported";
            if (!resultsSent) {
              writeSse(res, "results", { requestId, events: [], count: 0 });
              resultsSent = true;
            }
            if (typeof update.summary === "string") {
              summaryTextSent = true;
              if (!writeSse(res, "delta", { requestId, text: update.summary })) {
                if (!(await waitForDrainOrClose(res))) disconnected = true;
              }
            }
          } else if (
            (nodeName === "composeSummary" || nodeName === "hydrateCards") &&
            typeof update.summary === "string" &&
            update.summary.length > 0 &&
            !summaryTextSent
          ) {
            summaryTextSent = true;
            if (!writeSse(res, "delta", { requestId, text: update.summary })) {
              if (!(await waitForDrainOrClose(res))) disconnected = true;
            }
          }
        }
      } else if (mode === "messages") {
        const [message, metadata] = chunk as [
          { content?: unknown },
          { langgraph_node?: string },
        ];
        if (metadata.langgraph_node !== "composeSummary") continue;
        const text = getText(message.content);
        if (!text) continue;

        summaryTextSent = true;
        if (!writeSse(res, "delta", { requestId, text })) {
          if (!(await waitForDrainOrClose(res))) {
            disconnected = true;
            abortController.abort(new Error("Client disconnected"));
          }
        }
      }
    }

    if (disconnected) return;
    if (timedOut) {
      writeSse(res, "error", { requestId, code: "request_timeout" satisfies PublicStreamError });
      return;
    }

    if (!resultsSent && finishReason !== "unsupported") {
      writeSse(res, "results", { requestId, events: [], count: 0 });
      finishReason = "empty";
    }

    writeSse(res, "done", { requestId, finishReason });
  } catch (error) {
    if (disconnected) return;

    if (!res.headersSent) {
      res.status(500).json({ error: "Unable to start event chat" });
      return;
    }

    const code: PublicStreamError = timedOut
      ? "request_timeout"
      : causedBy(error, EventSearchUnavailableError.name)
        ? "search_unavailable"
        : getErrorStatus(error) === 429
          ? "provider_quota_exhausted"
        : "chat_failed";
    console.error("Event chat stream failed", {
      requestId,
      code,
      errorType: error instanceof Error ? error.name : "UnknownError",
      providerStatus: getErrorStatus(error),
      errorMessage: error instanceof Error ? error.message : undefined,
    });
    writeSse(res, "error", { requestId, code });
  } finally {
    clearTimeout(timeout);
    res.off("close", onClose);
    releaseStream();
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

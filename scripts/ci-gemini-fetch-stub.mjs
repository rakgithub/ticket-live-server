import { URL } from "node:url";

const originalFetch = globalThis.fetch.bind(globalThis);

const intentResponse = {
  candidates: [{
    content: {
      role: "model",
      parts: [{
        text: JSON.stringify({
          isEventSearch: true,
          text: null,
          location: "Berlin",
          genre: "jazz",
          needsClarification: false,
        }),
      }],
    },
    finishReason: "STOP",
  }],
};

const summaryResponse = {
  candidates: [{
    content: {
      role: "model",
      parts: [{ text: "Here is the matching jazz event in Berlin." }],
    },
    finishReason: "STOP",
  }],
};

globalThis.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" || input instanceof URL
    ? String(input)
    : input.url;
  const url = new URL(requestUrl);

  if (url.hostname !== "generativelanguage.googleapis.com") {
    return originalFetch(input, init);
  }

  if (url.pathname.includes(":generateContent")) {
    return globalThis.Response.json(intentResponse);
  }

  if (url.pathname.includes(":streamGenerateContent")) {
    return new globalThis.Response(`data: ${JSON.stringify(summaryResponse)}\n\n`, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  }

  return globalThis.Response.json({ error: "Unsupported deterministic Gemini request" }, { status: 404 });
};

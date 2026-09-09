import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "../../../lib/agent";

export const runtime = "nodejs";
export const maxDuration = 60;

type ClientMessage = {
  role: "user" | "assistant";
  text: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      message?: unknown;
      history?: unknown;
    };

    if (typeof body.message !== "string" || !body.message.trim()) {
      return Response.json({ error: "Please enter a question." }, { status: 400 });
    }

    if (body.message.length > 2_000) {
      return Response.json(
        { error: "Please keep the question under 2,000 characters." },
        { status: 400 }
      );
    }

    const clientHistory: ClientMessage[] = Array.isArray(body.history)
      ? body.history
          .filter(
            (item): item is ClientMessage =>
              typeof item === "object" &&
              item !== null &&
              (item.role === "user" || item.role === "assistant") &&
              typeof item.text === "string" &&
              item.text.trim().length > 0
          )
          .slice(-12)
      : [];

    const history: Anthropic.MessageParam[] = clientHistory.map((item) => ({
      role: item.role,
      content: item.text.slice(0, 8_000),
    }));

    const answer = await runAgent(body.message, history);
    return Response.json({ answer });
  } catch (error) {
    console.error("Chat request failed", error);
    return Response.json(
      { error: "The agent could not answer that question. Please try again." },
      { status: 500 }
    );
  }
}

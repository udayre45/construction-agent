"use client";

import { FormEvent, useRef, useState } from "react";

type Message = {
  role: "user" | "assistant";
  text: string;
};

const examples = [
  "How many permits are in Seattle?",
  "What is the total budget for projects in San Francisco?",
  "What are the payment terms in the Rainier Elevator Subcontract?",
];

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function send(question: string) {
    const trimmed = question.trim();
    if (!trimmed || busy) return;

    const history = messages;
    setInput("");
    setError("");
    setMessages((current) => [...current, { role: "user", text: trimmed }]);
    setBusy(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, history }),
      });
      const data = (await response.json()) as { answer?: string; error?: string };

      if (!response.ok || !data.answer) {
        throw new Error(data.error || "The agent returned an empty response.");
      }

      setMessages((current) => [
        ...current,
        { role: "assistant", text: data.answer as string },
      ]);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The agent could not answer that question."
      );
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(input);
  }

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">CONSTRUCTION DATA ASSISTANT</p>
        <h1>Construction Q&amp;A</h1>
        <p className="intro">
          Ask about permits, project budgets, and contract terms. Answers are grounded
          in the connected construction records and include record citations.
        </p>
      </header>

      <section className="chat" aria-label="Construction Q and A chat">
        <div className="messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="welcome">
              <h2>Start with a question</h2>
              <p>Choose an example or enter your own question below.</p>
              <div className="examples">
                {examples.map((example) => (
                  <button
                    className="example"
                    disabled={busy}
                    key={example}
                    onClick={() => void send(example)}
                    type="button"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message, index) => (
              <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
                <span>{message.role === "user" ? "You" : "Agent"}</span>
                <p>{message.text}</p>
              </article>
            ))
          )}
          {busy && (
            <div className="message assistant thinking">
              <span>Agent</span>
              <p>Checking the construction records...</p>
            </div>
          )}
        </div>

        <form className="composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="question">
            Ask a construction data question
          </label>
          <textarea
            id="question"
            maxLength={2000}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Ask about permits, projects, or contracts..."
            ref={inputRef}
            rows={2}
            value={input}
          />
          <button disabled={busy || !input.trim()} type="submit">
            {busy ? "Working..." : "Send"}
          </button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        <p className="hint">Press Enter to send · Shift + Enter for a new line</p>
      </section>
    </main>
  );
}

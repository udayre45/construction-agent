"use client";

import { FormEvent, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type EvidenceField = { label: string; value: string };
type EvidenceRecord = { title: string; fields: EvidenceField[] };
type EvidenceGroup = {
  title: string;
  source: string;
  filters: EvidenceField[];
  metrics: EvidenceField[];
  records: EvidenceRecord[];
};

type Message = {
  role: "user" | "assistant";
  text: string;
  evidence?: EvidenceGroup[];
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
      const data = (await response.json()) as {
        answer?: string;
        evidence?: EvidenceGroup[];
        error?: string;
      };

      if (!response.ok || !data.answer) {
        throw new Error(data.error || "The agent returned an empty response.");
      }

      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          text: data.answer as string,
          evidence: data.evidence ?? [],
        },
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
                {message.role === "assistant" ? (
                  <div className="message-body markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="message-body">{message.text}</p>
                )}
                {message.evidence?.map((group, groupIndex) => (
                  <details className="evidence" key={`${group.title}-${groupIndex}`}>
                    <summary>
                      <strong>Sources &amp; evidence</strong>
                      <small>{group.source}</small>
                    </summary>
                    <div className="evidence-content">
                      {group.filters.length > 0 && (
                        <div>
                          <h3>Query filters</h3>
                          <dl className="evidence-grid">
                            {group.filters.map((field) => (
                              <div key={`${field.label}-${field.value}`}>
                                <dt>{field.label}</dt>
                                <dd>{field.value}</dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      )}
                      <div>
                        <h3>Verified results</h3>
                        <dl className="evidence-grid">
                          {group.metrics.map((field) => (
                            <div key={`${field.label}-${field.value}`}>
                              <dt>{field.label}</dt>
                              <dd>{field.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                      {group.records.length > 0 && (
                        <div>
                          <h3>Supporting records</h3>
                          <div className="evidence-records">
                            {group.records.map((record, recordIndex) => (
                              <article key={`${record.title}-${recordIndex}`}>
                                <h4>{record.title}</h4>
                                <dl>
                                  {record.fields.map((field) => (
                                    <div key={`${field.label}-${field.value}`}>
                                      <dt>{field.label}</dt>
                                      <dd>{field.value}</dd>
                                    </div>
                                  ))}
                                </dl>
                              </article>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </details>
                ))}
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

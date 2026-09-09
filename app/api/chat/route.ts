import type Anthropic from "@anthropic-ai/sdk";
import {
  runAgentWithEvidence,
  type ToolEvidence,
} from "../../../lib/agent";

export const runtime = "nodejs";
export const maxDuration = 60;

type ClientMessage = {
  role: "user" | "assistant";
  text: string;
};

type EvidenceField = { label: string; value: string };
type EvidenceRecord = { title: string; fields: EvidenceField[] };
type EvidenceGroup = {
  title: string;
  source: string;
  filters: EvidenceField[];
  metrics: EvidenceField[];
  records: EvidenceRecord[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function text(value: unknown, fallback = "Not provided"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function queryFilters(input: Record<string, unknown>): EvidenceField[] {
  const labels: Record<string, string> = {
    city: "City",
    state: "State",
    permit_type: "Permit type",
    status: "Status",
    query: "Search",
  };

  return Object.entries(input)
    .filter(([key, value]) => key !== "limit" && key !== "match_count" && value !== undefined)
    .map(([key, value]) => ({ label: labels[key] ?? key, value: text(value) }));
}

function summarizeEvidence(items: ToolEvidence[], answer: string): EvidenceGroup[] {
  return items.flatMap((item): EvidenceGroup[] => {
    const result = asRecord(item.result);

    if (item.tool === "query_permits") {
      const statusCounts = asRecord(result.status_counts);
      const statusSummary = Object.entries(statusCounts)
        .map(([status, count]) => `${status}: ${text(count)}`)
        .join(", ");
      const records = asRecords(result.sample).slice(0, 5).map((permit) => ({
        title: `Permit #${text(permit.permit_number)}`,
        fields: [
          { label: "Type", value: text(permit.permit_type) },
          { label: "Status", value: text(permit.status) },
          { label: "Location", value: `${text(permit.city)}, ${text(permit.state)}` },
          { label: "Issued", value: text(permit.issued_date) },
        ],
      }));

      return [{
        title: "Permit query evidence",
        source: "Supabase permits mirror",
        filters: queryFilters(item.input),
        metrics: [
          { label: "Exact matches", value: text(result.total_matching, "0") },
          {
            label: "Permit types",
            value: Array.isArray(result.permit_types)
              ? result.permit_types.map((value) => text(value)).join(", ")
              : "None",
          },
          { label: "Status breakdown", value: statusSummary || "None" },
          { label: "Status not provided", value: text(result.missing_status, "0") },
          { label: "Permit type not provided", value: text(result.missing_permit_type, "0") },
        ],
        records,
      }];
    }

    if (item.tool === "query_projects") {
      const records = asRecords(result.projects).slice(0, 10).map((project) => ({
        title: text(project.name, "Unnamed project"),
        fields: [
          { label: "Status", value: text(project.status) },
          { label: "Budget", value: text(project.budget) },
          { label: "Location", value: `${text(project.city)}, ${text(project.state)}` },
        ],
      }));

      return [{
        title: "Project query evidence",
        source: "Supabase projects mirror",
        filters: queryFilters(item.input),
        metrics: [
          { label: "Exact matches", value: text(result.total_matching, "0") },
          { label: "Total known budget", value: text(result.total_known_budget, "0") },
        ],
        records,
      }];
    }

    if (item.tool === "search_contracts") {
      const matches = asRecords(result.matches);
      const citedMatches = matches.filter((contract) => {
        const name = text(contract.name, "");
        return name.length > 0 && answer.toLowerCase().includes(name.toLowerCase());
      });
      const records = citedMatches.slice(0, 5).map((contract) => ({
        title: text(contract.name, "Unnamed contract"),
        fields: [
          { label: "Party", value: text(contract.party) },
          { label: "Type", value: text(contract.contract_type) },
          { label: "Governing law", value: text(contract.governing_law) },
          { label: "Similarity", value: Number.isFinite(Number(contract.similarity)) ? `${(Number(contract.similarity) * 100).toFixed(1)}%` : "Not provided" },
          { label: "Excerpt", value: text(contract.extracted_text).slice(0, 280) },
        ],
      }));

      return [{
        title: "Contract search evidence",
        source: "Supabase contracts mirror · local MiniLM embeddings",
        filters: queryFilters(item.input),
        metrics: [
          { label: "Candidates checked", value: String(matches.length) },
          { label: "Contracts cited in answer", value: String(citedMatches.length) },
        ],
        records,
      }];
    }

    return [];
  });
}

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

    const result = await runAgentWithEvidence(body.message, history);
    return Response.json({
      answer: result.answer,
      evidence: summarizeEvidence(result.evidence, result.answer),
    });
  } catch (error) {
    console.error("Chat request failed", error);
    return Response.json(
      { error: "The agent could not answer that question. Please try again." },
      { status: 500 }
    );
  }
}

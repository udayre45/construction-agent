import type Anthropic from "@anthropic-ai/sdk";
import { supabase } from "./db";
import { embed } from "./embed";

export const toolDefs: Anthropic.Tool[] = [
  {
    name: "query_permits",
    description:
      "Look up building permits by city, state, permit type, or status. Returns an exact match count, complete permit-type and status facets for the MVP dataset, and a sample of matching records.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string" },
        state: { type: "string" },
        permit_type: { type: "string" },
        status: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "query_projects",
    description:
      "Look up construction projects by city, state, or status. Returns matching projects, their exact count, and the total known budget.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string" },
        state: { type: "string" },
        status: { type: "string" },
      },
    },
  },
  {
    name: "search_contracts",
    description:
      "Semantically search contract text for terms and clauses such as payment, termination, governing law, and indemnity. Similarity returns candidates only; a result is relevant only when its text satisfies every explicit constraint in the user's question.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        match_count: { type: "number" },
      },
      required: ["query"],
    },
  },
];

type ToolInput = Record<string, unknown>;

function asInput(value: unknown): ToolInput {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ToolInput)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), maximum);
}

export async function dispatch(name: string, rawInput: unknown) {
  const input = asInput(rawInput);

  if (name === "query_permits") {
    let query = supabase
      .from("permits")
      .select(
        "permit_number,permit_type,requirements,status,fee,issued_date,city,state",
        { count: "exact" }
      );
    let facetQuery = supabase.from("permits").select("permit_type,status");

    const city = optionalString(input.city);
    const state = optionalString(input.state);
    const permitType = optionalString(input.permit_type);
    const status = optionalString(input.status);

    if (city) {
      query = query.ilike("city", city);
      facetQuery = facetQuery.ilike("city", city);
    }
    if (state) {
      query = query.ilike("state", state);
      facetQuery = facetQuery.ilike("state", state);
    }
    if (permitType) {
      query = query.ilike("permit_type", `%${permitType}%`);
      facetQuery = facetQuery.ilike("permit_type", `%${permitType}%`);
    }
    if (status) {
      query = query.ilike("status", `%${status}%`);
      facetQuery = facetQuery.ilike("status", `%${status}%`);
    }

    const [sampleResult, facetResult] = await Promise.all([
      query.limit(boundedInteger(input.limit, 25, 100)),
      facetQuery.limit(1000),
    ]);
    if (sampleResult.error) {
      throw new Error(`Permit query failed: ${sampleResult.error.message}`);
    }
    if (facetResult.error) {
      throw new Error(`Permit facet query failed: ${facetResult.error.message}`);
    }

    const facetRows = facetResult.data ?? [];
    const permitTypes = [
      ...new Set(facetRows.map((row) => row.permit_type).filter(Boolean)),
    ].sort();
    const statusCounts = Object.fromEntries(
      [...new Set(facetRows.map((row) => row.status).filter(Boolean))]
        .sort()
        .map((facetStatus) => [
          facetStatus,
          facetRows.filter((row) => row.status === facetStatus).length,
        ])
    );

    return {
      total_matching: sampleResult.count ?? 0,
      permit_types: permitTypes,
      status_counts: statusCounts,
      facets_complete: (sampleResult.count ?? 0) <= 1000,
      sample: sampleResult.data ?? [],
    };
  }

  if (name === "query_projects") {
    let query = supabase
      .from("projects")
      .select("name,status,budget,city,state,start_date,end_date");

    const city = optionalString(input.city);
    const state = optionalString(input.state);
    const status = optionalString(input.status);

    if (city) query = query.ilike("city", city);
    if (state) query = query.ilike("state", state);
    if (status) query = query.ilike("status", `%${status}%`);

    const { data, error } = await query.limit(1000);
    if (error) throw new Error(`Project query failed: ${error.message}`);

    const projects = data ?? [];
    const budgets = projects
      .map((project) => Number(project.budget))
      .filter(Number.isFinite);

    return {
      total_matching: projects.length,
      total_known_budget: budgets.reduce((sum, budget) => sum + budget, 0),
      projects,
    };
  }

  if (name === "search_contracts") {
    const searchText = optionalString(input.query);
    if (!searchText) throw new Error("Contract search requires a non-empty query");

    const [queryEmbedding] = await embed([searchText]);
    const { data, error } = await supabase.rpc("match_contracts", {
      query_embedding: queryEmbedding,
      match_count: boundedInteger(input.match_count, 5, 20),
    });
    if (error) throw new Error(`Contract search failed: ${error.message}`);

    return { matches: data ?? [] };
  }

  throw new Error(`Unknown tool: ${name}`);
}

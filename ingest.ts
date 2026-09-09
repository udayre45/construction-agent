/**
 * Mirror Salesforce projects, permits, and contracts into Supabase.
 * Contract embeddings are generated locally with all-MiniLM-L6-v2.
 *
 * Run: npx tsx ingest.ts
 */
import "dotenv/config";
import jsforce, { type Connection } from "jsforce";
import { createClient } from "@supabase/supabase-js";
import { embed } from "./lib/embed";

const REQUIRED_ENV = [
  "SF_LOGIN_URL",
  "SF_USERNAME",
  "SF_PASSWORD",
  "SF_SECURITY_TOKEN",
  "SUPABASE_URL",
] as const;

function requireEnv(name: (typeof REQUIRED_ENV)[number]): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

for (const name of REQUIRED_ENV) requireEnv(name);

function requireSupabaseServerKey(): string {
  const key =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!key) {
    throw new Error(
      "Missing SUPABASE_SECRET_KEY (preferred) or SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  if (key.startsWith("sb_publishable_")) {
    throw new Error("A Supabase publishable key cannot be used for ingestion");
  }

  const jwtParts = key.split(".");
  if (jwtParts.length === 3) {
    try {
      const payload = JSON.parse(
        Buffer.from(jwtParts[1], "base64url").toString("utf8")
      );
      if (payload.role !== "service_role") {
        throw new Error(
          `Supabase JWT role must be service_role, received ${payload.role || "unknown"}`
        );
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY contains an invalid JWT");
      }
      throw error;
    }
  }

  return key;
}

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireSupabaseServerKey(),
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

const num = (value: unknown) =>
  value === null || value === undefined || value === "" ? null : Number(value);

const date = (value: unknown) => (value ? String(value).slice(0, 10) : null);

function createSalesforceConnection() {
  const loginUrl = requireEnv("SF_LOGIN_URL");
  const clientId = process.env.SF_CLIENT_ID?.trim();
  const clientSecret = process.env.SF_CLIENT_SECRET?.trim();

  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      "SF_CLIENT_ID and SF_CLIENT_SECRET must either both be set or both be omitted"
    );
  }

  if (clientId && clientSecret) {
    console.log("Salesforce authentication: OAuth username-password flow");
    return new jsforce.Connection({
      oauth2: { loginUrl, clientId, clientSecret },
    });
  }

  console.log("Salesforce authentication: SOAP login (OAuth credentials not configured)");
  return new jsforce.Connection({ loginUrl });
}

async function queryAll(conn: Connection, soql: string): Promise<any[]> {
  let result = await conn.query(soql);
  let records: any[] = [...result.records];

  while (!result.done) {
    if (!result.nextRecordsUrl) {
      throw new Error("Salesforce query was incomplete and returned no continuation URL");
    }
    result = await conn.queryMore(result.nextRecordsUrl);
    records = records.concat(result.records);
  }

  return records;
}

async function upsertRows(table: string, rows: Record<string, unknown>[], batchSize: number) {
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    const { error } = await supabase.from(table).upsert(batch, { onConflict: "id" });

    if (error) {
      throw new Error(`Supabase ${table} upsert failed: ${error.message}`);
    }
  }
}

async function main() {
  const conn = createSalesforceConnection();
  await conn.login(
    requireEnv("SF_USERNAME"),
    requireEnv("SF_PASSWORD") + requireEnv("SF_SECURITY_TOKEN")
  );
  console.log("Logged in to Salesforce as", (await conn.identity()).username);

  const projects = await queryAll(
    conn,
    "SELECT Id, Name, Status__c, Budget__c, City__c, State__c, Start_Date__c, End_Date__c FROM Project__c"
  );
  const projectRows = projects.map((record: any) => ({
    id: record.Id,
    name: record.Name,
    status: record.Status__c,
    budget: num(record.Budget__c),
    city: record.City__c,
    state: record.State__c,
    start_date: date(record.Start_Date__c),
    end_date: date(record.End_Date__c),
  }));
  await upsertRows("projects", projectRows, 500);
  console.log(`Projects: ${projectRows.length}`);

  const permits = await queryAll(
    conn,
    "SELECT Id, Permit_Number__c, Permit_Type__c, Requirements__c, Status__c, Fee__c, Issued_Date__c, City__c, State__c FROM Permit__c"
  );
  const permitRows = permits.map((record: any) => ({
    id: record.Id,
    permit_number: record.Permit_Number__c,
    permit_type: record.Permit_Type__c,
    requirements: record.Requirements__c,
    status: record.Status__c,
    fee: num(record.Fee__c),
    issued_date: date(record.Issued_Date__c),
    city: record.City__c,
    state: record.State__c,
  }));
  await upsertRows("permits", permitRows, 500);
  console.log(`Permits: ${permitRows.length}`);

  const contracts = await queryAll(
    conn,
    "SELECT Id, Contract_Name__c, Party__c, Contract_Type__c, Governing_Law__c, Effective_Date__c, Extracted_Text__c FROM Contract__c"
  );
  const texts = contracts.map(
    (record: any) => `${record.Contract_Name__c}. ${record.Extracted_Text__c || ""}`
  );
  console.log(`Embedding ${texts.length} contracts locally...`);
  const vectors = await embed(texts);

  const contractRows = contracts.map((record: any, index: number) => ({
    id: record.Id,
    name: record.Contract_Name__c,
    party: record.Party__c,
    contract_type: record.Contract_Type__c,
    governing_law: record.Governing_Law__c,
    effective_date: date(record.Effective_Date__c),
    extracted_text: record.Extracted_Text__c,
    embedding: vectors[index],
  }));
  await upsertRows("contracts", contractRows, 100);
  console.log(`Contracts: ${contractRows.length}`);

  console.log("Done. Salesforce data is mirrored in Supabase.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("FAILED:", message);
  process.exitCode = 1;
});

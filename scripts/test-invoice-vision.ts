import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type GroundTruthItem = {
  description?: string;
  quantity?: string;
  total_price?: string;
};

type Sample = {
  sample_id: string;
  image: string;
  ground_truth: {
    invoice?: {
      seller_name?: string;
      invoice_number?: string;
      invoice_date?: string;
    };
    items?: GroundTruthItem[];
    subtotal?: { tax?: string; total?: string };
  };
};

type ExtractedItem = {
  description: string | null;
  quantity: number | null;
  net_unit_price: number | null;
  net_line_total: number | null;
  gross_line_total: number | null;
};

type ExtractedInvoice = {
  invoice_number: string | null;
  vendor: string | null;
  invoice_date: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  line_items: ExtractedItem[];
};

type Check = {
  field: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
};

type EvaluationResult = {
  sample_id: string;
  extracted?: ExtractedInvoice;
  checks: Check[];
  passed_checks: number;
  total_checks: number;
  accuracy: number;
  error?: string;
};

const sampleDir = resolve(process.cwd(), "data", "invoice-sample");
const prompt = `Extract the invoice into exactly one JSON object with this shape:
{
  "invoice_number": string | null,
  "vendor": string | null,
  "invoice_date": string | null,
  "subtotal": number | null,
  "tax": number | null,
  "total": number | null,
  "line_items": [{
    "description": string | null,
    "quantity": number | null,
    "net_unit_price": number | null,
    "net_line_total": number | null,
    "gross_line_total": number | null
  }]
}
Use the values printed in the image. Keep net and gross amounts separate. Do not derive a missing value. Use decimal points even if the invoice uses decimal commas. Return JSON only, without markdown fences.`;

function normalizeText(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function parseLocalizedNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let text = String(value ?? "")
    .trim()
    .replace(/[\s\u00a0$€£]/g, "")
    .replace(/[^0-9,.-]/g, "");
  if (!text) return null;

  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    text = text.split(thousands).join("").replace(decimal, ".");
  } else if (comma >= 0) {
    const decimals = text.length - comma - 1;
    text = decimals > 0 && decimals <= 2
      ? text.replace(/\./g, "").replace(",", ".")
      : text.replace(/,/g, "");
  } else if ((text.match(/\./g) ?? []).length > 1) {
    const last = text.lastIndexOf(".");
    text = `${text.slice(0, last).replace(/\./g, "")}${text.slice(last)}`;
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameNumber(left: unknown, right: unknown): boolean {
  const a = parseLocalizedNumber(left);
  const b = parseLocalizedNumber(right);
  return a !== null && b !== null && Math.abs(a - b) < 0.005;
}

function parseJson(text: string): ExtractedInvoice {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as ExtractedInvoice;
  if (!parsed || !Array.isArray(parsed.line_items)) {
    throw new Error("Vision response did not contain a line_items array");
  }
  return parsed;
}

function addCheck(
  checks: Check[],
  field: string,
  expected: unknown,
  actual: unknown,
  compare: (actualValue: unknown, expectedValue: unknown) => boolean
) {
  checks.push({ field, expected, actual, passed: compare(actual, expected) });
}

function evaluate(sample: Sample, extracted: ExtractedInvoice): Check[] {
  const checks: Check[] = [];
  const truth = sample.ground_truth;
  const expectedItems = truth.items ?? [];

  addCheck(checks, "invoice_number", truth.invoice?.invoice_number, extracted.invoice_number,
    (actual, expected) => normalizeText(actual) === normalizeText(expected));
  addCheck(checks, "vendor", truth.invoice?.seller_name, extracted.vendor,
    (actual, expected) => normalizeText(actual) === normalizeText(expected));
  addCheck(checks, "invoice_date", truth.invoice?.invoice_date, extracted.invoice_date,
    (actual, expected) => normalizeText(actual) === normalizeText(expected));
  addCheck(checks, "tax", truth.subtotal?.tax, extracted.tax, sameNumber);
  addCheck(checks, "total", truth.subtotal?.total, extracted.total, sameNumber);
  addCheck(checks, "item_count", expectedItems.length, extracted.line_items.length,
    (actual, expected) => actual === expected);

  for (let index = 0; index < expectedItems.length; index += 1) {
    const expected = expectedItems[index];
    const actual = extracted.line_items[index];
    addCheck(checks, `line_items[${index}].description`, expected.description, actual?.description,
      (actualValue, expectedValue) => normalizeText(actualValue) === normalizeText(expectedValue));
    addCheck(checks, `line_items[${index}].quantity`, expected.quantity, actual?.quantity, sameNumber);
    addCheck(
      checks,
      `line_items[${index}].gross_line_total`,
      expected.total_price,
      actual?.gross_line_total,
      sameNumber
    );
  }

  return checks;
}

async function extractInvoice(
  client: Anthropic,
  sample: Sample
): Promise<ExtractedInvoice> {
  const image = await readFile(resolve(sampleDir, sample.image));
  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5",
    max_tokens: 1800,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: image.toString("base64"),
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  const responseText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return parseJson(responseText);
}

async function evaluateSample(client: Anthropic, sample: Sample): Promise<EvaluationResult> {
  try {
    const extracted = await extractInvoice(client, sample);
    const checks = evaluate(sample, extracted);
    const passed = checks.filter((check) => check.passed).length;
    return {
      sample_id: sample.sample_id,
      extracted,
      checks,
      passed_checks: passed,
      total_checks: checks.length,
      accuracy: checks.length ? passed / checks.length : 0,
    };
  } catch (error) {
    return {
      sample_id: sample.sample_id,
      checks: [],
      passed_checks: 0,
      total_checks: 0,
      accuracy: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
  const manifest = JSON.parse(
    await readFile(resolve(sampleDir, "ground-truth.json"), "utf8")
  ) as Sample[];
  const all = process.argv.includes("--all");
  const limitIndex = process.argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : undefined;
  const positional = process.argv.slice(2).filter((arg, index, args) => {
    if (arg.startsWith("--")) return false;
    return index === 0 || args[index - 1] !== "--limit";
  });
  const requested = positional[0];
  let selected: Sample[];
  if (all) {
    selected = manifest;
  } else {
    const sample = requested
      ? manifest.find((entry) => entry.sample_id === requested)
      : manifest[0];
    if (!sample) throw new Error(`Invoice sample not found: ${requested ?? "first sample"}`);
    selected = [sample];
  }
  if (limit !== undefined) selected = selected.slice(0, Math.max(1, Math.trunc(limit)));

  const client = new Anthropic({ apiKey });
  const results: EvaluationResult[] = [];
  for (const [index, sample] of selected.entries()) {
    console.log(`[${index + 1}/${selected.length}] ${sample.sample_id}`);
    const result = await evaluateSample(client, sample);
    results.push(result);
    console.log(
      result.error
        ? `  ERROR: ${result.error}`
        : `  ${result.passed_checks}/${result.total_checks} checks (${(result.accuracy * 100).toFixed(1)}%)`
    );
  }

  const successful = results.filter((result) => !result.error);
  const totalChecks = successful.reduce((sum, result) => sum + result.total_checks, 0);
  const passedChecks = successful.reduce((sum, result) => sum + result.passed_checks, 0);
  const mismatches = successful.flatMap((result) =>
    result.checks
      .filter((check) => !check.passed)
      .map((check) => ({ sample_id: result.sample_id, ...check }))
  );
  const report = {
    generated_at: new Date().toISOString(),
    samples_requested: selected.length,
    samples_completed: successful.length,
    samples_failed: results.length - successful.length,
    passed_checks: passedChecks,
    total_checks: totalChecks,
    field_accuracy: totalChecks ? passedChecks / totalChecks : 0,
    mismatches,
    results,
    note: "Net unit price and net line total are not scored because structured ground truth does not contain them.",
  };
  await writeFile(
    resolve(sampleDir, "vision-evaluation.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );
  console.log(
    JSON.stringify(
      {
        samples_completed: report.samples_completed,
        samples_failed: report.samples_failed,
        passed_checks: report.passed_checks,
        total_checks: report.total_checks,
        field_accuracy: `${(report.field_accuracy * 100).toFixed(2)}%`,
        mismatches: report.mismatches,
        report: resolve(sampleDir, "vision-evaluation.json"),
      },
      null,
      2
    )
  );
  if (report.samples_failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

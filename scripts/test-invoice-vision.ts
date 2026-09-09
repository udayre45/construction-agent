import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
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

type ExtractedInvoice = {
  invoice_number: string | null;
  vendor: string | null;
  invoice_date: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  line_items: Array<{
    description: string | null;
    quantity: number | null;
    net_unit_price: number | null;
    net_line_total: number | null;
    gross_line_total: number | null;
  }>;
};

const sampleDir = resolve(process.cwd(), "data", "invoice-sample");

function normalizeText(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function sameNumber(left: unknown, right: unknown): boolean {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005;
}

function parseJson(text: string): ExtractedInvoice {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned) as ExtractedInvoice;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const manifest = JSON.parse(
    await readFile(resolve(sampleDir, "ground-truth.json"), "utf8")
  ) as Sample[];
  const requested = process.argv[2];
  const sample = requested
    ? manifest.find((entry) => entry.sample_id === requested)
    : manifest[0];
  if (!sample) throw new Error(`Invoice sample not found: ${requested}`);

  const image = await readFile(resolve(sampleDir, sample.image));
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5",
    max_tokens: 1400,
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
          {
            type: "text",
            text: `Extract the invoice into exactly one JSON object with this shape:
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
Use the values printed in the image. Keep net and gross amounts separate. Do not derive a missing value. Use decimal points even if the invoice uses decimal commas. Return JSON only, without markdown fences.`,
          },
        ],
      },
    ],
  });

  const responseText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const extracted = parseJson(responseText);
  const truth = sample.ground_truth;
  const expectedItems = truth.items ?? [];

  const checks = {
    invoice_number: normalizeText(extracted.invoice_number) === normalizeText(truth.invoice?.invoice_number),
    vendor: normalizeText(extracted.vendor) === normalizeText(truth.invoice?.seller_name),
    invoice_date: normalizeText(extracted.invoice_date) === normalizeText(truth.invoice?.invoice_date),
    tax: sameNumber(extracted.tax, truth.subtotal?.tax),
    total: sameNumber(extracted.total, truth.subtotal?.total),
    item_count: extracted.line_items.length === expectedItems.length,
    first_item_description:
      expectedItems.length === 0 ||
      normalizeText(extracted.line_items[0]?.description) === normalizeText(expectedItems[0]?.description),
    first_item_quantity:
      expectedItems.length === 0 || sameNumber(extracted.line_items[0]?.quantity, expectedItems[0]?.quantity),
    first_item_gross_total:
      expectedItems.length === 0 ||
      sameNumber(extracted.line_items[0]?.gross_line_total, expectedItems[0]?.total_price),
  };

  console.log(
    JSON.stringify(
      {
        sample_id: sample.sample_id,
        extracted,
        validated_against_ground_truth: checks,
        passed: Object.values(checks).filter(Boolean).length,
        total_checks: Object.keys(checks).length,
        note: "Net unit price and net line total are visible in the image but absent from structured ground truth.",
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

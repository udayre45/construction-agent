import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runAgent } from "../lib/agent";

interface EvalCase {
  id: string;
  category: string;
  question: string;
  must_contain?: string[];
  must_contain_any?: string[][];
  must_not_contain?: string[];
}

interface EvalFile {
  version: number;
  description: string;
  cases: EvalCase[];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[$,]/g, "").replace(/\s+/g, " ").trim();
}

function evaluate(answer: string, testCase: EvalCase): string[] {
  const normalizedAnswer = normalize(answer);
  const failures: string[] = [];

  for (const expected of testCase.must_contain ?? []) {
    if (!normalizedAnswer.includes(normalize(expected))) {
      failures.push(`missing: ${expected}`);
    }
  }

  for (const alternatives of testCase.must_contain_any ?? []) {
    if (!alternatives.some((expected) => normalizedAnswer.includes(normalize(expected)))) {
      failures.push(`missing one of: ${alternatives.join(" | ")}`);
    }
  }

  for (const forbidden of testCase.must_not_contain ?? []) {
    if (normalizedAnswer.includes(normalize(forbidden))) {
      failures.push(`contained forbidden text: ${forbidden}`);
    }
  }

  return failures;
}

async function main() {
  const evalPath = resolve(process.cwd(), "eval", "questions.json");
  const evalFile = JSON.parse(readFileSync(evalPath, "utf8")) as EvalFile;
  const caseFlag = process.argv.indexOf("--case");
  const requestedCase = caseFlag >= 0 ? process.argv[caseFlag + 1] : undefined;
  const dryRun = process.argv.includes("--dry-run");
  const selected = requestedCase
    ? evalFile.cases.filter((testCase) => testCase.id === requestedCase)
    : evalFile.cases;

  if (requestedCase && selected.length === 0) {
    throw new Error(`Unknown evaluation case: ${requestedCase}`);
  }

  if (dryRun) {
    console.log(`Evaluation set v${evalFile.version}: ${selected.length} case(s)`);
    for (const testCase of selected) {
      console.log(`${testCase.id} [${testCase.category}] ${testCase.question}`);
    }
    return;
  }

  let passed = 0;
  for (const testCase of selected) {
    console.log(`\n[RUN] ${testCase.id}: ${testCase.question}`);
    try {
      const answer = await runAgent(testCase.question);
      const failures = evaluate(answer, testCase);
      console.log(answer);

      if (failures.length === 0) {
        passed += 1;
        console.log(`[PASS] ${testCase.id}`);
      } else {
        console.log(`[FAIL] ${testCase.id}: ${failures.join("; ")}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[ERROR] ${testCase.id}: ${message}`);
    }
  }

  console.log(`\nResult: ${passed}/${selected.length} passed`);
  if (passed !== selected.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("EVALUATION FAILED:", message);
  process.exitCode = 1;
});

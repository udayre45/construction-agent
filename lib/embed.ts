import { env, pipeline } from "@huggingface/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIMENSION = 384;

env.allowRemoteModels = true;
env.cacheDir = "./.cache/transformers";

let extractorPromise: Promise<any> | null = null;

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL_ID);
  }

  return extractorPromise;
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const extractor = await getExtractor();
  const vectors: number[][] = [];

  for (const text of texts) {
    const result = await extractor((text || "").slice(0, 2000), {
      pooling: "mean",
      normalize: true,
    });
    const vector = Array.from(result.data as Float32Array);

    if (vector.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `Expected ${EMBEDDING_DIMENSION} embedding dimensions, received ${vector.length}`
      );
    }

    vectors.push(vector);
  }

  return vectors;
}

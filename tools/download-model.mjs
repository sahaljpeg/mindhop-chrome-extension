import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const TARGET_ROOT = join("models", MODEL_ID);

const FILES = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "onnx/model_quantized.onnx"
];

async function downloadFile(path) {
    const url = `${BASE_URL}/${path}`;
    const target = join(TARGET_ROOT, path);

    await mkdir(dirname(target), { recursive: true });

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }

    const fileStream = createWriteStream(target);
    await finished(Readable.fromWeb(response.body).pipe(fileStream));
    console.log(`Downloaded ${target}`);
}

await mkdir(TARGET_ROOT, { recursive: true });

for (const file of FILES) {
    await downloadFile(file);
}

console.log("\nMindHop model installed locally.");

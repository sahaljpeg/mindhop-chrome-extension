import { env, pipeline } from "./vendor/transformers.min.js";

const DB_NAME = "mindhop-history-index";
const DB_VERSION = 1;
const ENTRY_STORE = "historyEntries";
const META_STORE = "metadata";
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const HISTORY_MAX_RESULTS = 2000;
const HISTORY_LOOKBACK_DAYS = 90;
const INDEX_BATCH_SIZE = 12;
const MAX_EMBEDDING_TEXT_LENGTH = 512;

let dbPromise;
let extractorPromise;
let isIndexing = false;


env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL("models/");
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/");
env.backends.onnx.wasm.numThreads = 1;

chrome.runtime.onInstalled.addListener(() => {
    setMetadata({ installedAt: Date.now() }).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: toUserError(error) }));
    return true;
});

async function handleMessage(message) {
    if (message.type === "GET_STATUS") {
        return { ok: true, ...(await getStatus()) };
    }

    if (message.type === "INDEX_HISTORY") {
        const status = await indexHistory();
        return { ok: true, ...status };
    }

    if (message.type === "SEARCH") {
        const results = await semanticSearch(message.query, message.limit ?? 10);
        return { ok: true, ...(await getStatus()), results };
    }

    return { ok: false, error: "Unknown MindHop command." };
}

// IndexedDB stores history records and Float32Array embeddings locally. This is
// better suited than chrome.storage for large vector indexes.
function openDatabase() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;

            if (!db.objectStoreNames.contains(ENTRY_STORE)) {
                const entries = db.createObjectStore(ENTRY_STORE, { keyPath: "id" });
                entries.createIndex("lastVisitTime", "lastVisitTime");
                entries.createIndex("url", "url", { unique: true });
            }

            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE, { keyPath: "key" });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    return dbPromise;
}

async function setMetadata(values) {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(META_STORE, "readwrite");
        const store = transaction.objectStore(META_STORE);

        Object.entries(values).forEach(([key, value]) => store.put({ key, value }));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
    });
}

async function getMetadata(key) {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
        const request = db.transaction(META_STORE).objectStore(META_STORE).get(key);
        request.onsuccess = () => resolve(request.result?.value);
        request.onerror = () => reject(request.error);
    });
}

async function countEntries() {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
        const request = db.transaction(ENTRY_STORE).objectStore(ENTRY_STORE).count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function putEntries(entries) {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(ENTRY_STORE, "readwrite");
        const store = transaction.objectStore(ENTRY_STORE);

        entries.forEach((entry) => store.put(entry));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
    });
}

async function getAllEntries() {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
        const request = db.transaction(ENTRY_STORE).objectStore(ENTRY_STORE).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function getExistingEntryMap() {
    const entries = await getAllEntries();
    return new Map(entries.map((entry) => [entry.id, entry]));
}

async function getStatus() {
    const [indexedCount, historyCount, indexedAt, lookbackDays, maxResults, changedCount, processedChangedCount] = await Promise.all([
        countEntries(),
        getMetadata("historyCount"),
        getMetadata("indexedAt"),
        getMetadata("lookbackDays"),
        getMetadata("maxResults"),
        getMetadata("changedCount"),
        getMetadata("processedChangedCount")
    ]);

    return {
        indexedCount,
        historyCount: historyCount ?? indexedCount,
        indexedAt,
        lookbackDays: lookbackDays ?? HISTORY_LOOKBACK_DAYS,
        maxResults: maxResults ?? HISTORY_MAX_RESULTS,
        changedCount: changedCount ?? 0,
        processedChangedCount: processedChangedCount ?? 0,
        isIndexing,
        modelReady: await isModelInstalled()
    };
}

async function isModelInstalled() {
    try {
        const manifestUrl = chrome.runtime.getURL(`models/${MODEL_ID}/config.json`);
        const response = await fetch(manifestUrl);
        return response.ok;
    } catch {
        return false;
    }
}

function loadExtractor() {
    if (extractorPromise) return extractorPromise;

    extractorPromise = pipeline("feature-extraction", MODEL_ID, {
        quantized: true,
        progress_callback: (progress) => {
            if (progress.status === "ready") console.info("MindHop model ready");
        }
    });

    return extractorPromise;
}

// Embeddings are normalized MiniLM vectors. Once normalized, cosine similarity
// is just a dot product, which keeps search fast over thousands of rows.
async function embedText(text) {
    const extractor = await loadExtractor();
    const output = await extractor(text || "untitled page", {
        pooling: "mean",
        normalize: true
    });

    return Array.from(output.data);
}

function searchableText(item) {
    const url = item.url || "";
    const host = safeHost(url);
    const title = item.title || "Untitled page";
    return `${title}\n${host}\n${url}`.slice(0, MAX_EMBEDDING_TEXT_LENGTH);
}

function safeHost(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}

function historySearch(options) {
    return new Promise((resolve, reject) => {
        chrome.history.search(options, (items) => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve(items);
        });
    });
}

async function readHistoryScope() {
    const startTime = Date.now() - HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const items = await historySearch({
        text: "",
        startTime,
        maxResults: HISTORY_MAX_RESULTS
    });

    return items.filter((item) => item.url && !item.url.startsWith("chrome://"));
}

async function indexHistory() {
    if (isIndexing) throw new Error("MindHop is already indexing history.");
    if (!(await isModelInstalled())) throw new Error(modelSetupMessage());

    isIndexing = true;

    try {
        const [historyItems, existingEntries] = await Promise.all([
            readHistoryScope(),
            getExistingEntryMap()
        ]);
        const changedItems = historyItems.filter((item) => {
            const existing = existingEntries.get(item.id);
            return !existing || hasHistoryEntryChanged(item, existing);
        });

        if (!changedItems.length) {
            await setMetadata({
                historyCount: historyItems.length,
                changedCount: 0,
                lookbackDays: HISTORY_LOOKBACK_DAYS,
                maxResults: HISTORY_MAX_RESULTS,
                indexedAt: Date.now()
            });
            return getStatus();
        }

        for (let index = 0; index < changedItems.length; index += INDEX_BATCH_SIZE) {
            const batch = changedItems.slice(index, index + INDEX_BATCH_SIZE);
            const embedded = [];

            for (const item of batch) {
                const text = searchableText(item);
                embedded.push({
                    id: item.id,
                    url: item.url,
                    title: item.title || safeHost(item.url) || "Untitled page",
                    lastVisitTime: item.lastVisitTime,
                    typedCount: item.typedCount ?? 0,
                    visitCount: item.visitCount ?? 0,
                    text,
                    embedding: await embedText(text)
                });
            }

            await putEntries(embedded);
            await setMetadata({
                historyCount: historyItems.length,
                changedCount: changedItems.length,
                processedChangedCount: Math.min(index + batch.length, changedItems.length),
                lookbackDays: HISTORY_LOOKBACK_DAYS,
                maxResults: HISTORY_MAX_RESULTS,
                indexedAt: Date.now()
            });
        }

        return getStatus();
    } finally {
        isIndexing = false;
    }
}

function hasHistoryEntryChanged(item, existing) {
    return (
        item.url !== existing.url ||
        searchableText(item) !== existing.text ||
        item.lastVisitTime !== existing.lastVisitTime ||
        (item.visitCount ?? 0) !== (existing.visitCount ?? 0)
    );
}

async function semanticSearch(query, limit) {
    if (!(await isModelInstalled())) throw new Error(modelSetupMessage());

    const entries = await getAllEntries();
    if (!entries.length) throw new Error("No index exists yet. Click Index history first.");

    const queryEmbedding = await embedText(query);
    const ranked = entries
        .map((entry) => ({
            title: entry.title,
            url: entry.url,
            lastVisitTime: entry.lastVisitTime,
            score: cosineSimilarity(queryEmbedding, entry.embedding)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    return ranked;
}

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let index = 0; index < a.length; index += 1) {
        dot += a[index] * b[index];
        normA += a[index] * a[index];
        normB += b[index] * b[index];
    }

    if (!normA || !normB) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function modelSetupMessage() {
    return "Local MiniLM model files are missing. Run `npm run download-model`, then reload the extension.";
}

function toUserError(error) {
    const message = error?.message || "MindHop hit an unexpected error.";

    if (message.includes("local model file")) return modelSetupMessage();
    if (message.includes("Failed to fetch")) return modelSetupMessage();
    return message;
}

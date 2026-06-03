const searchInput = document.getElementById("searchInput");
const searchBtn = document.getElementById("searchBtn");
const indexBtn = document.getElementById("indexBtn");
const refreshBtn = document.getElementById("refreshBtn");
const statusPill = document.getElementById("statusPill");
const message = document.getElementById("message");
const stats = document.getElementById("stats");
const results = document.getElementById("results");
const guide = document.getElementById("guide");
const exampleChips = document.querySelectorAll(".example-chip");

// Chrome runtime messaging keeps the popup light. The background service worker
// owns history access, IndexedDB, embedding generation, and vector ranking.
function send(type, payload = {}) {
    if (!globalThis.chrome?.runtime?.sendMessage) {
        throw new Error("Load MindHop as a Chrome extension to connect your browser history.");
    }

    return chrome.runtime.sendMessage({ type, ...payload });
}

function setBusy(isBusy) {
    searchBtn.disabled = isBusy;
    indexBtn.disabled = isBusy;
    refreshBtn.disabled = isBusy;
    statusPill.textContent = isBusy ? "Working" : "Ready";
}

function showMessage(text, tone = "") {
    message.textContent = text;
    message.className = tone ? `message ${tone}` : "message";
}

function formatDate(timestamp) {
    if (!timestamp) return "Unknown visit time";
    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
    }).format(new Date(timestamp));
}

function renderStats(data) {
    if (!data) {
        stats.textContent = "";
        return;
    }

    const indexed = data.indexedCount ?? 0;
    const total = data.historyCount ?? indexed;
    const model = data.modelReady ? "local model ready" : "model needed";
    stats.textContent = `${indexed.toLocaleString()} memories ready - ${total.toLocaleString()} recent pages checked - ${model}`;
}

function renderResults(items) {
    results.innerHTML = "";
    guide.hidden = items.length > 0;

    if (!items.length) {
        results.innerHTML = "";
        return;
    }

    const fragment = document.createDocumentFragment();

    items.forEach((item, index) => {
        const card = document.createElement("a");
        card.className = "result";
        card.href = item.url;
        card.target = "_blank";
        card.rel = "noreferrer";

        const score = Math.round(item.score * 100);
        card.innerHTML = `
            <div class="result-topline">
                <span class="rank">#${index + 1}</span>
                <span class="score">${score}% match</span>
            </div>
            <h2></h2>
            <p class="url"></p>
            <p class="meta"></p>
        `;

        card.querySelector("h2").textContent = item.title || "Untitled page";
        card.querySelector(".url").textContent = item.url;
        card.querySelector(".meta").textContent = formatDate(item.lastVisitTime);
        fragment.appendChild(card);
    });

    results.appendChild(fragment);
}

async function refreshStatus() {
    const response = await send("GET_STATUS");
    if (!response.ok) throw new Error(response.error);

    renderStats(response);
    statusPill.textContent = response.isIndexing ? "Indexing" : "Ready";

    if (!response.modelReady) {
        showMessage("Install the local MiniLM model, then prepare your memory.", "warn");
    } else if (response.indexedCount === 0) {
        showMessage("Start by preparing your memory. Later syncs skip pages already remembered.");
    } else {
        showMessage("Ready. Describe a page the way you remember it.");
    }
}

async function indexHistory() {
    setBusy(true);
    showMessage("Preparing recent history locally and skipping anything already remembered...");

    try {
        const response = await send("INDEX_HISTORY");
        if (!response.ok) throw new Error(response.error);
        renderStats(response);
        const changed = response.changedCount ?? 0;
        showMessage(`Updated ${changed.toLocaleString()} changed entries. ${response.indexedCount.toLocaleString()} entries are saved locally.`);
    } catch (error) {
        showMessage(error.message, "error");
    } finally {
        setBusy(false);
    }
}

async function search() {
    const query = searchInput.value.trim();
    if (!query) {
        searchInput.focus();
        showMessage("Describe the page you remember first.", "warn");
        return;
    }

    setBusy(true);
    showMessage("Searching by meaning across your local browser memory...");

    try {
        const response = await send("SEARCH", { query, limit: 10 });
        if (!response.ok) throw new Error(response.error);
        renderStats(response);
        renderResults(response.results);
        showMessage(`Found ${response.results.length} semantic matches.`);
    } catch (error) {
        showMessage(error.message, "error");
    } finally {
        setBusy(false);
    }
}

searchBtn.addEventListener("click", search);
indexBtn.addEventListener("click", indexHistory);
refreshBtn.addEventListener("click", refreshStatus);
exampleChips.forEach((chip) => {
    chip.addEventListener("click", () => {
        searchInput.value = chip.textContent;
        searchInput.focus();
    });
});
searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") search();
});

refreshStatus().catch((error) => showMessage(error.message, "error"));

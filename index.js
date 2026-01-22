// Celestial Forge Tracker – Hardened Version (v2.1)

import {
    extension_settings,
    addExtensionSettings,
    saveSettingsDebounced
} from "../../../extensions.js";

import {
    eventSource,
    event_types
} from "../../../../script.js";

const extensionName = "celestial-forge-tracker";

/* ============================
   DEFAULT STRUCTURE
   ============================ */

const defaultChatState = {
    totalCP: 0,
    spentCP: 0,
    perks: [],
    checkpoints: [],
    autoDetect: false
};

function ensureRoot() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = { chats: {} };
    }
}

/* ============================
   CHAT STATE
   ============================ */

function getChatId() {
    return window?.currentChatId ?? window?.chat_metadata?.chat_id ?? null;
}

function getChatState() {
    ensureRoot();
    const chatId = getChatId();
    if (!chatId) return null;

    if (!extension_settings[extensionName].chats[chatId]) {
        extension_settings[extensionName].chats[chatId] =
            structuredClone(defaultChatState);
    }
    return extension_settings[extensionName].chats[chatId];
}

/* ============================
   UI CREATION
   ============================ */

function createUI() {
    if ($("#celestial-forge-settings").length) return;

    const html = `
    <div id="celestial-forge-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle">
          <b>Celestial Forge Tracker</b>
        </div>

        <div class="inline-drawer-content">

          <div class="forge-tabs">
            <div class="forge-tab active" data-tab="stats">Stats</div>
            <div class="forge-tab" data-tab="perks">Perks</div>
            <div class="forge-tab" data-tab="checkpoints">Checkpoints</div>
          </div>

          <div class="forge-tab-content active" data-tab-content="stats">
            <div class="forge-panel">
              <h4>Core Stats</h4>
              <div class="forge-stat-row">
                <label>Total CP</label>
                <input id="forge-total-cp" type="number" class="forge-input-small">
              </div>
              <div class="forge-stat-row">
                <label>Spent CP</label>
                <input id="forge-spent-cp" type="number" class="forge-input-small">
              </div>
              <div class="forge-stat-row">
                <label>Remaining</label>
                <span id="forge-remaining-cp" class="forge-highlight">0</span>
              </div>
            </div>
          </div>

          <div class="forge-tab-content" data-tab-content="perks">
            <div class="forge-panel">
              <h4>Perks</h4>
              <div id="forge-perk-list" class="forge-scrollable"></div>
              <div class="forge-actions">
                <input id="forge-new-perk-name" class="forge-input-wide" placeholder="Perk name">
                <input id="forge-new-perk-cost" class="forge-input-small" type="number" placeholder="Cost">
                <button id="forge-add-perk" class="forge-btn-primary">Add</button>
              </div>
            </div>
          </div>

          <div class="forge-tab-content" data-tab-content="checkpoints">
            <div class="forge-panel">
              <h4>Checkpoints</h4>
              <button id="forge-save-checkpoint" class="forge-btn-primary">
                Save Checkpoint
              </button>
              <div id="forge-checkpoint-list"></div>
            </div>
          </div>

        </div>
      </div>
    </div>
    `;

    addExtensionSettings({
        id: extensionName,
        name: "Celestial Forge Tracker",
        html
    });

    bindUI();
    refreshUI();
}

/* ============================
   UI BINDINGS
   ============================ */

function bindUI() {
    $(document).on("click", ".forge-tab", function () {
        const tab = $(this).data("tab");
        $(".forge-tab").removeClass("active");
        $(this).addClass("active");
        $(".forge-tab-content").removeClass("active");
        $(`[data-tab-content="${tab}"]`).addClass("active");
    });

    $("#forge-total-cp").on("input", function () {
        const state = getChatState();
        if (!state) return;
        state.totalCP = Number(this.value) || 0;
        saveSettingsDebounced();
        refreshUI();
    });

    $("#forge-spent-cp").on("input", function () {
        const state = getChatState();
        if (!state) return;
        state.spentCP = Number(this.value) || 0;
        saveSettingsDebounced();
        refreshUI();
    });

    $("#forge-add-perk").on("click", () => {
        const state = getChatState();
        if (!state) return;

        const name = $("#forge-new-perk-name").val().trim();
        const cost = Number($("#forge-new-perk-cost").val()) || 0;
        if (!name) return;

        state.perks.push({ name, cost, active: true });
        state.spentCP += cost;

        $("#forge-new-perk-name").val("");
        $("#forge-new-perk-cost").val("");

        saveSettingsDebounced();
        refreshUI();
    });

    $("#forge-save-checkpoint").on("click", () => {
        const state = getChatState();
        if (!state) return;

        state.checkpoints.push({
            date: new Date().toISOString(),
            snapshot: structuredClone(state)
        });

        saveSettingsDebounced();
        refreshUI();
    });
}

/* ============================
   RENDERING
   ============================ */

function refreshUI() {
    const state = getChatState();
    if (!state) return;

    $("#forge-total-cp").val(state.totalCP);
    $("#forge-spent-cp").val(state.spentCP);
    $("#forge-remaining-cp").text(state.totalCP - state.spentCP);

    const perkList = $("#forge-perk-list").empty();
    state.perks.forEach((perk, idx) => {
        const el = $(`
            <div class="forge-perk-item toggleable ${perk.active ? "active" : ""}">
              <div class="forge-perk-header">
                <strong>${perk.name}</strong>
                <span class="forge-perk-cost">${perk.cost} CP</span>
                <button class="forge-remove-btn">✖</button>
              </div>
            </div>
        `);

        el.on("click", () => {
            perk.active = !perk.active;
            saveSettingsDebounced();
            refreshUI();
        });

        el.find(".forge-remove-btn").on("click", (e) => {
            e.stopPropagation();
            state.spentCP -= perk.cost;
            state.perks.splice(idx, 1);
            saveSettingsDebounced();
            refreshUI();
        });

        perkList.append(el);
    });

    const cpList = $("#forge-checkpoint-list").empty();
    state.checkpoints.forEach((cp, idx) => {
        const el = $(`
          <div class="forge-checkpoint-item">
            <div class="forge-checkpoint-info">
              <strong>Checkpoint ${idx + 1}</strong>
              <div class="forge-checkpoint-date">${cp.date}</div>
            </div>
            <button class="forge-restore-btn">Restore</button>
          </div>
        `);

        el.find(".forge-restore-btn").on("click", () => {
            const chatId = getChatId();
            extension_settings[extensionName].chats[chatId] =
                structuredClone(cp.snapshot);
            saveSettingsDebounced();
            refreshUI();
        });

        cpList.append(el);
    });
}

/* ============================
   INIT
   ============================ */

function onChatChanged() {
    createUI();
    refreshUI();
}

(function init() {
    ensureRoot();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    setTimeout(onChatChanged, 500);
})();

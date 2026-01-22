// Celestial Forge Tracker v9.1
// Full-featured, dual-compatible (Legacy ST + Staging 1.15+)

import { eventSource, event_types } from "../../../../script.js";

const extensionName = "celestial-forge-tracker";
const extensionVersion = "9.1.0";

// ==================== DEFAULT SETTINGS ====================

const defaultSettings = {
    enabled: true,
    cp_per_response: 10,
    threshold_base: 100,
    auto_parse_forge_blocks: true,
    sync_to_simtracker: true,
    debug_mode: false
};

// ==================== SAFE EXTENSION API DETECTION ====================

let extension_settings = null;
let getContext = null;
let registerExtension = null;
let addExtensionSettings = null;

async function detectExtensionAPI() {
    try {
        const ext = await import("../../../extensions.js");
        extension_settings = ext.extension_settings ?? null;
        getContext = ext.getContext ?? null;
        registerExtension = ext.registerExtension ?? null;
        addExtensionSettings = ext.addExtensionSettings ?? null;
    } catch {
        // Legacy SillyTavern — ignore
    }
}

// ==================== CELESTIAL FORGE TRACKER ====================

class CelestialForgeTracker {
    constructor() {
        this.extensionVersion = extensionVersion;
        this.state = this.getDefaultState();
    }

    getDefaultState() {
        return {
            response_count: 0,
            base_cp: 0,
            bonus_cp: 0,
            available_cp: 0,
            total_cp: 0,
            spent_cp: 0,
            corruption: 0,
            sanity: 0,
            threshold: 100,
            threshold_progress: 0,
            acquired_perks: [],
            pending_perk: null,
            active_toggles: [],
            perk_history: [],
            has_uncapped: false
        };
    }

    getSettings() {
        if (!extension_settings) return defaultSettings;
        return extension_settings[extensionName] || defaultSettings;
    }

    // ==================== STATE ====================

    calculateTotals() {
        this.state.total_cp = this.state.base_cp + this.state.bonus_cp;
        this.state.spent_cp = this.state.acquired_perks.reduce((s, p) => s + (p.cost || 0), 0);
        this.state.available_cp = this.state.total_cp - this.state.spent_cp;
        this.state.threshold_progress = this.state.total_cp % this.state.threshold;
    }

    incrementResponse() {
        this.state.response_count++;
        this.state.base_cp =
            this.state.response_count * (this.getSettings().cp_per_response || 10);
        this.calculateTotals();
        this.saveState();
    }

    // ==================== PERKS ====================

    addPerk(perkData) {
        const perk = {
            name: perkData.name || "Unknown",
            cost: parseInt(perkData.cost) || 0,
            flags: perkData.flags || [],
            description: perkData.description || "",
            toggleable: perkData.flags?.includes("TOGGLEABLE"),
            active: perkData.active !== false,
            scaling: perkData.scaling || null
        };

        if (perk.flags.includes("UNCAPPED")) {
            this.state.has_uncapped = true;
        }

        if (perk.cost > this.state.available_cp) {
            this.state.pending_perk = {
                name: perk.name,
                cost: perk.cost,
                cp_needed: perk.cost - this.state.available_cp
            };
            return false;
        }

        this.state.acquired_perks.push(perk);
        this.state.perk_history.push({
            action: "acquired",
            perk: perk.name,
            cost: perk.cost,
            time: Date.now()
        });

        this.calculateTotals();
        this.saveState();
        this.syncToSimTracker();
        return true;
    }

    togglePerk(name) {
        const perk = this.state.acquired_perks.find(
            p => p.name.toLowerCase() === name.toLowerCase()
        );
        if (!perk || !perk.toggleable) return false;
        perk.active = !perk.active;
        this.saveState();
        this.syncToSimTracker();
        return true;
    }

    // ==================== FORGE BLOCK ====================

    parseForgeBlock(text) {
        const match = text.match(/```forge\s*([\s\S]*?)```/);
        if (!match) return null;
        try {
            return JSON.parse(match[1]);
        } catch {
            return null;
        }
    }

    syncFromForgeBlock(data) {
        const stats = data?.characters?.[0]?.stats;
        if (!stats) return;

        this.state.corruption = stats.corruption ?? this.state.corruption;
        this.state.sanity = stats.sanity ?? this.state.sanity;

        for (const perk of stats.perks || []) {
            if (!this.state.acquired_perks.find(p => p.name === perk.name)) {
                this.addPerk(perk);
            }
        }

        this.saveState();
        this.syncToSimTracker();
    }

    // ==================== SIMTRACKER ====================

    generateSimTrackerJSON() {
        return {
            characters: [{
                characterName: "Smith",
                stats: {
                    total_cp: this.state.total_cp,
                    available_cp: this.state.available_cp,
                    corruption: this.state.corruption,
                    sanity: this.state.sanity,
                    perks: this.state.acquired_perks
                }
            }]
        };
    }

    syncToSimTracker() {
        if (!this.getSettings().sync_to_simtracker) return;
        try {
            const data = this.generateSimTrackerJSON();
            if (window.SimTracker) window.SimTracker.updateData(data);
            window.dispatchEvent(new CustomEvent("celestial-forge-update", { detail: data }));
        } catch {}
    }

    // ==================== CONTEXT ====================

    generateContextBlock() {
        return this.state.acquired_perks
            .map(p => `- ${p.name} (${p.cost} CP)`)
            .join("\n");
    }

    // ==================== AI RESPONSE ====================

    processAIResponse(text) {
        if (!this.getSettings().enabled) return;

        const forge = this.parseForgeBlock(text);
        if (forge && this.getSettings().auto_parse_forge_blocks) {
            this.syncFromForgeBlock(forge);
        }

        const corruption = text.match(/corruption[:\s]+([+-]?\d+)/i);
        if (corruption) {
            this.state.corruption = Math.max(
                0,
                Math.min(100, this.state.corruption + parseInt(corruption[1]))
            );
        }

        const sanity = text.match(/sanity[:\s]+([+-]?\d+)/i);
        if (sanity) {
            this.state.sanity = Math.max(
                0,
                Math.min(100, this.state.sanity + parseInt(sanity[1]))
            );
        }

        this.incrementResponse();
    }

    // ==================== STORAGE ====================

    saveState() {
        try {
            const key = getContext?.()?.chatId
                ? `celestialForge_${getContext().chatId}`
                : "celestialForge_global";
            localStorage.setItem(key, JSON.stringify(this.state));
        } catch {}
    }

    loadState() {
        try {
            const key = getContext?.()?.chatId
                ? `celestialForge_${getContext().chatId}`
                : "celestialForge_global";
            const saved = localStorage.getItem(key);
            if (saved) this.state = { ...this.getDefaultState(), ...JSON.parse(saved) };
        } catch {}
    }

    getStatus() {
        return {
            version: this.extensionVersion,
            cp: this.state.total_cp,
            perks: this.state.acquired_perks.length
        };
    }
}

// ==================== INIT ====================

let tracker = null;
let bound = false;

function bindEvents() {
    if (bound) return;
    bound = true;

    eventSource.on(event_types.MESSAGE_RECEIVED, d => {
        const text = d?.mes || d?.message || "";
        if (text) tracker?.processAIResponse(text);
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        tracker?.loadState();
    });
}

jQuery(async () => {
    await detectExtensionAPI();

    if (typeof registerExtension === "function") {
        registerExtension({
            name: extensionName,
            display_name: "Celestial Forge Tracker",
            version: extensionVersion,
            author: "Claude & LO",
            description: "Tracks Celestial Forge CP, perks, thresholds, and injections."
        });
    }

    if (extension_settings) {
        extension_settings[extensionName] ??= { ...defaultSettings };

        if (typeof addExtensionSettings === "function") {
            addExtensionSettings(extensionName, {
                enabled: { type: "checkbox", label: "Enable Tracker", default: true },
                debug_mode: { type: "checkbox", label: "Debug Logging", default: false }
            });
        }
    }

    tracker = new CelestialForgeTracker();
    tracker.loadState();

    window.celestialForge = tracker;
    window.getCelestialForgeInjection = () => tracker.generateContextBlock();

    bindEvents();

    console.log(`[Celestial Forge Tracker v${extensionVersion}] Ready`, tracker.getStatus());
});

export { CelestialForgeTracker };

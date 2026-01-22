// Celestial Forge Tracker v10.0
// SillyTavern Stable + Staging compatible

import { eventSource, event_types } from "../../../../script.js";
import {
    buildUIPanel,
    updateUIPanel,
    bindUIActions
} from "./ui.js";

const extensionName = "celestial-forge-tracker";

const defaultSettings = {
    enabled: true,
    cp_per_response: 10,
    threshold_base: 100,
    auto_parse_forge_blocks: true,
    sync_to_simtracker: true,
    debug_mode: false
};

class CelestialForgeTracker {
    constructor() {
        this.version = "10.0.0";
        this.state = this.defaultState();
    }

    defaultState() {
        return {
            response_count: 0,
            base_cp: 0,
            bonus_cp: 0,
            total_cp: 0,
            spent_cp: 0,
            available_cp: 0,
            threshold: 100,
            threshold_progress: 0,
            corruption: 0,
            sanity: 100,
            has_uncapped: false,
            acquired_perks: [],
            pending_perk: null
        };
    }

    settings() {
        window.extension_settings ??= {};
        window.extension_settings[extensionName] ??=
            structuredClone(defaultSettings);
        return window.extension_settings[extensionName];
    }

    incrementResponse() {
        if (!this.settings().enabled) return;

        this.state.response_count++;
        this.state.base_cp =
            this.state.response_count * this.settings().cp_per_response;

        this.recalculate();
    }

    recalculate() {
        this.state.total_cp =
            this.state.base_cp + this.state.bonus_cp;

        this.state.spent_cp =
            this.state.acquired_perks.reduce((s, p) => s + p.cost, 0);

        this.state.available_cp =
            this.state.total_cp - this.state.spent_cp;

        this.state.threshold_progress =
            this.state.total_cp % this.state.threshold;

        this.resolvePending();
        this.save();
    }

    resolvePending() {
        if (
            this.state.pending_perk &&
            this.state.available_cp >= this.state.pending_perk.cost
        ) {
            this.state.acquired_perks.push(this.state.pending_perk);
            this.state.pending_perk = null;
        }
    }

    addPerk(perk) {
        if (perk.flags?.includes("UNCAPPED")) {
            this.state.has_uncapped = true;
        }

        perk.scaling ??= null;
        perk.active ??= true;

        if (perk.cost <= this.state.available_cp) {
            this.state.acquired_perks.push(perk);
        } else {
            this.state.pending_perk = perk;
        }
        this.recalculate();
    }

    togglePerk(name) {
        const perk = this.state.acquired_perks.find(p => p.name === name);
        if (!perk || !perk.toggleable) return;
        perk.active = !perk.active;
        this.save();
    }

    gainScalingXP(name, xp = 10) {
        const perk = this.state.acquired_perks.find(p => p.name === name);
        if (!perk?.scaling) return;

        perk.scaling.xp += xp;
        const needed = perk.scaling.level * 10;

        while (perk.scaling.xp >= needed) {
            if (
                perk.scaling.level >= perk.scaling.max &&
                !perk.scaling.uncapped
            ) break;

            perk.scaling.xp -= needed;
            perk.scaling.level++;
        }
        this.save();
    }

    processResponse(text) {
        this.incrementResponse();

        // Narrative perk parsing
        for (const m of text.matchAll(/\*\*(.+?)\*\*\s*\((\d+)\s*CP\)(?:.*?\[([^\]]*)\])?/gi)) {
            const name = m[1].trim();
            const cost = parseInt(m[2]);
            const flags = m[3]?.split(/[,\s]+/) ?? [];

            if (!this.state.acquired_perks.some(p => p.name === name)) {
                this.addPerk({
                    name,
                    cost,
                    flags,
                    toggleable: flags.includes("TOGGLEABLE"),
                    scaling: flags.includes("SCALING")
                        ? { level: 1, xp: 0, max: this.state.has_uncapped ? 999 : 5, uncapped: this.state.has_uncapped }
                        : null
                });
            }
        }

        const cor = text.match(/corruption[:\s]+([+-]?\d+)/i);
        if (cor) this.state.corruption = Math.max(0, Math.min(100, this.state.corruption + +cor[1]));

        const san = text.match(/sanity[:\s]+([+-]?\d+)/i);
        if (san) this.state.sanity = Math.max(0, Math.min(100, this.state.sanity + +san[1]));

        this.save();
    }

    save() {
        const ctx = window.getContext?.();
        const key = ctx?.chatId ? `cf_${ctx.chatId}` : "cf_global";
        localStorage.setItem(key, JSON.stringify(this.state));
    }

    load() {
        const ctx = window.getContext?.();
        const key = ctx?.chatId ? `cf_${ctx.chatId}` : "cf_global";
        const raw = localStorage.getItem(key);
        if (raw) this.state = { ...this.defaultState(), ...JSON.parse(raw) };
    }
}

let tracker;

jQuery(async () => {
    tracker = new CelestialForgeTracker();
    tracker.load();

    const panel = buildUIPanel(tracker);
    $("#extensions_settings").append(panel);
    bindUIActions(tracker);
    updateUIPanel(tracker);

    eventSource.on(event_types.MESSAGE_RECEIVED, d => {
        const text = d?.message || d?.mes || d;
        if (text) tracker.processResponse(text);
        updateUIPanel(tracker);
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        tracker.load();
        updateUIPanel(tracker);
    });

    console.log("[Celestial Forge Tracker] Fully loaded", tracker);
});

// Celestial Forge Tracker v9.1 - SillyTavern Extension
// Compatible with ST's extension system

import { eventSource, event_types } from "../../../../script.js";
import {
    extension_settings,
    getContext,
    registerExtension
} from "../../../extensions.js";


const extensionName = "celestial-forge-tracker";
const extensionFolderPath = `scripts/extensions/third_party/${extensionName}`;

const defaultSettings = {
    enabled: true,
    cp_per_response: 10,
    threshold_base: 100,
    auto_parse_forge_blocks: true,
    sync_to_simtracker: true,
    debug_mode: false
};

// ==================== CELESTIAL FORGE TRACKER CLASS ====================

class CelestialForgeTracker {
    constructor() {
        this.extensionVersion = "9.1.0";
        this.state = this.getDefaultState();
        this.validFlags = [
            'PASSIVE', 'TOGGLEABLE', 'ALWAYS-ON', 
            'PERMISSION-GATED', 'SELECTIVE',
            'CORRUPTING', 'SANITY-TAXING',
            'SCALING', 'UNCAPPED',
            'COMBAT', 'UTILITY', 'CRAFTING', 
            'MENTAL', 'PHYSICAL'
        ];
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
            has_uncapped: false,
            last_forge_block: null
        };
    }

    getSettings() {
        return extension_settings[extensionName] || defaultSettings;
    }

    // ==================== STATE MANAGEMENT ====================
    
    calculateTotals() {
        this.state.total_cp = this.state.base_cp + this.state.bonus_cp;
        this.state.spent_cp = this.state.acquired_perks.reduce((sum, p) => sum + (p.cost || 0), 0);
        this.state.available_cp = this.state.total_cp - this.state.spent_cp;
        this.state.threshold_progress = this.state.total_cp % this.state.threshold;
    }

    incrementResponse() {
        this.state.response_count++;
        this.state.base_cp = this.state.response_count * (this.getSettings().cp_per_response || 10);
        this.calculateTotals();
        this.saveState();
        return this.state;
    }

    // ==================== PERK MANAGEMENT ====================

    addPerk(perkData) {
        if (perkData.name?.toUpperCase().includes('UNCAPPED') || 
            perkData.flags?.includes('UNCAPPED')) {
            this.state.has_uncapped = true;
            this.applyUncappedToAllPerks();
        }
        
        const perk = {
            name: perkData.name || "Unknown Perk",
            cost: parseInt(perkData.cost) || 100,
            flags: Array.isArray(perkData.flags) ? perkData.flags : [],
            description: perkData.description || "",
            constellation: perkData.constellation || "Unknown",
            toggleable: perkData.flags?.includes('TOGGLEABLE') || false,
            active: perkData.active !== false,
            acquired_at: Date.now(),
            acquired_response: this.state.response_count,
            scaling: this.createScalingObject(perkData)
        };

        this.calculateTotals();
        
        if (perk.cost <= this.state.available_cp) {
            this.state.acquired_perks.push(perk);
            this.state.perk_history.push({
                action: 'acquired',
                perk: perk.name,
                cost: perk.cost,
                timestamp: Date.now()
            });
            
            if (this.state.pending_perk?.name === perk.name) {
                this.state.pending_perk = null;
            }
            
            this.calculateTotals();
            this.saveState();
            this.syncToSimTracker();
            return { success: true, perk };
        } else {
            this.state.pending_perk = {
                name: perk.name,
                cost: perk.cost,
                flags: perk.flags,
                cp_needed: perk.cost - this.state.available_cp
            };
            this.saveState();
            return { success: false, reason: 'insufficient_cp', pending: this.state.pending_perk };
        }
    }

    createScalingObject(perkData) {
        const hasScaling = perkData.flags?.includes('SCALING');
        if (!hasScaling && !perkData.scaling) return null;
        
        if (perkData.scaling && typeof perkData.scaling === 'object') {
            return {
                level: perkData.scaling.level || 1,
                maxLevel: this.state.has_uncapped ? 999 : (perkData.scaling.maxLevel || 5),
                xp: perkData.scaling.xp || 0,
                xp_percent: perkData.scaling.xp_percent || 0,
                uncapped: this.state.has_uncapped || perkData.scaling.uncapped || false
            };
        }
        
        return {
            level: 1,
            maxLevel: this.state.has_uncapped ? 999 : 5,
            xp: 0,
            xp_percent: 0,
            uncapped: this.state.has_uncapped
        };
    }

    applyUncappedToAllPerks() {
        this.state.has_uncapped = true;
        for (const perk of this.state.acquired_perks) {
            if (perk.scaling) {
                perk.scaling.maxLevel = 999;
                perk.scaling.uncapped = true;
            }
        }
        this.saveState();
        console.log('[Celestial Forge] UNCAPPED acquired!');
    }
    
    updateScaling(perkName, newLevel, newXp = null) {
        const perk = this.state.acquired_perks.find(p => 
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (!perk || !perk.scaling) return null;
        
        perk.scaling.level = newLevel;
        if (newXp !== null) {
            perk.scaling.xp = newXp;
            perk.scaling.xp_percent = Math.round((newXp / (newLevel * 10)) * 100);
        }
        
        this.saveState();
        this.syncToSimTracker();
        return perk.scaling;
    }
    
    addScalingXP(perkName, xpAmount = 10) {
        const perk = this.state.acquired_perks.find(p => 
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (!perk || !perk.scaling) return null;
        
        perk.scaling.xp += xpAmount;
        
        const xpPerLevel = perk.scaling.level * 10;
        while (perk.scaling.xp >= xpPerLevel) {
            if (perk.scaling.level >= perk.scaling.maxLevel && !perk.scaling.uncapped) {
                perk.scaling.xp = xpPerLevel;
                break;
            }
            perk.scaling.level++;
            perk.scaling.xp -= xpPerLevel;
        }
        
        perk.scaling.xp_percent = Math.min(100, Math.round((perk.scaling.xp / (perk.scaling.level * 10)) * 100));
        
        this.saveState();
        this.syncToSimTracker();
        return perk.scaling;
    }

    togglePerk(perkName) {
        const perk = this.state.acquired_perks.find(p => 
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (!perk) return { success: false, reason: 'not_found' };
        if (!perk.toggleable) return { success: false, reason: 'not_toggleable' };
        
        perk.active = !perk.active;
        
        if (perk.active) {
            if (!this.state.active_toggles.includes(perk.name)) {
                this.state.active_toggles.push(perk.name);
            }
        } else {
            this.state.active_toggles = this.state.active_toggles.filter(n => 
                n.toLowerCase() !== perk.name.toLowerCase()
            );
        }
        
        this.saveState();
        this.syncToSimTracker();
        return { success: true, active: perk.active };
    }

    // ==================== FORGE BLOCK PARSING ====================
    
    parseForgeBlock(text) {
        const forgeMatch = text.match(/```forge\s*([\s\S]*?)```/);
        if (!forgeMatch) return null;
        
        try {
            const data = JSON.parse(forgeMatch[1].trim());
            if (!data.characters?.[0]) return null;
            
            const char = data.characters[0];
            const stats = char.stats || char;
            
            return {
                raw: data,
                characterName: char.characterName || char.name || "Smith",
                total_cp: stats.total_cp || 0,
                available_cp: stats.available_cp || 0,
                corruption: stats.corruption || 0,
                sanity: stats.sanity || 0,
                perks: this.normalizePerks(stats.perks || stats.perks_list),
                pending_perk: stats.pending_perk || ""
            };
        } catch (e) {
            console.error('[Celestial Forge] Parse error:', e);
            return null;
        }
    }
    
    normalizePerks(perksInput) {
        if (!perksInput) return [];
        if (Array.isArray(perksInput)) return perksInput.map(p => this.normalizePerk(p));
        if (typeof perksInput === 'string') {
            return perksInput.split('|').map(part => {
                const match = part.match(/(.+?)\s*\((\d+)\s*CP\)/);
                return match ? { name: match[1].trim(), cost: parseInt(match[2]), flags: [], scaling: null } : null;
            }).filter(Boolean);
        }
        return [];
    }
    
    normalizePerk(perk) {
        const hasScaling = perk.flags?.includes('SCALING') || perk.scaling;
        return {
            name: perk.name || "Unknown",
            cost: parseInt(perk.cost) || 0,
            flags: perk.flags || [],
            description: perk.description || "",
            toggleable: perk.toggleable || perk.flags?.includes('TOGGLEABLE'),
            active: perk.active !== false,
            scaling: hasScaling ? {
                level: perk.scaling?.level || 1,
                maxLevel: this.state.has_uncapped ? 999 : (perk.scaling?.maxLevel || 5),
                xp: perk.scaling?.xp || 0,
                xp_percent: perk.scaling?.xp_percent || 0,
                uncapped: this.state.has_uncapped || perk.scaling?.uncapped
            } : null
        };
    }

    syncFromForgeBlock(parsed) {
        if (!parsed) return false;
        
        const hasUncapped = parsed.perks.some(p => 
            p.name?.toUpperCase().includes('UNCAPPED') || p.flags?.includes('UNCAPPED')
        );
        if (hasUncapped && !this.state.has_uncapped) this.applyUncappedToAllPerks();
        
        this.state.corruption = parsed.corruption;
        this.state.sanity = parsed.sanity;
        
        for (const newPerk of parsed.perks) {
            const existing = this.state.acquired_perks.find(p => 
                p.name.toUpperCase() === newPerk.name?.toUpperCase()
            );
            
            if (existing) {
                if (newPerk.active !== undefined) existing.active = newPerk.active;
                if (newPerk.scaling && existing.scaling) {
                    Object.assign(existing.scaling, newPerk.scaling);
                }
            } else if (newPerk.name) {
                this.addPerk(newPerk);
            }
        }
        
        this.saveState();
        this.syncToSimTracker();
        return true;
    }

    // ==================== SIMTRACKER ====================
    
    generateSimTrackerJSON() {
        return {
            characters: [{
                characterName: "Smith",
                currentDateTime: new Date().toLocaleString(),
                bgColor: "#e94560",
                stats: {
                    total_cp: this.state.total_cp,
                    available_cp: this.state.available_cp,
                    spent_cp: this.state.spent_cp,
                    threshold_progress: this.state.threshold_progress,
                    threshold_max: this.state.threshold,
                    threshold_percent: Math.round((this.state.threshold_progress / this.state.threshold) * 100),
                    corruption: this.state.corruption,
                    sanity: this.state.sanity,
                    perk_count: this.state.acquired_perks.length,
                    perks: this.state.acquired_perks.map(p => ({
                        name: p.name,
                        cost: p.cost,
                        flags: p.flags,
                        flags_str: p.flags?.join(', ') || '',
                        description: p.description,
                        toggleable: p.toggleable,
                        active: p.active,
                        has_scaling: !!p.scaling,
                        is_uncapped: p.scaling?.uncapped || false,
                        scaling: p.scaling ? {
                            level: p.scaling.level,
                            maxLevel: p.scaling.maxLevel,
                            xp: p.scaling.xp,
                            xp_percent: p.scaling.xp_percent,
                            uncapped: p.scaling.uncapped,
                            level_display: p.scaling.uncapped ? `Lv.${p.scaling.level}/∞` : `Lv.${p.scaling.level}/${p.scaling.maxLevel}`,
                            xp_display: `${p.scaling.xp}/${p.scaling.level * 10} XP`
                        } : null
                    })),
                    pending_perk: this.state.pending_perk?.name || "",
                    pending_cp: this.state.pending_perk?.cost || 0,
                    pending_remaining: this.state.pending_perk?.cp_needed || 0
                }
            }]
        };
    }

    syncToSimTracker() {
        try {
            const data = this.generateSimTrackerJSON();
            if (window.SimTracker) window.SimTracker.updateData(data);
            window.celestialForgeState = data;
            window.dispatchEvent(new CustomEvent('celestial-forge-update', { detail: data }));
        } catch (e) {
            console.warn('[Celestial Forge] Sync failed:', e);
        }
    }

    // ==================== CONTEXT INJECTION ====================
    
    generateContextBlock() {
        const perksStr = this.state.acquired_perks.map(p => {
            let str = `- ${p.name} (${p.cost} CP) [${p.flags.join(', ')}]`;
            if (p.scaling) str += ` [Lv.${p.scaling.level}/${p.scaling.uncapped ? '∞' : p.scaling.maxLevel}]`;
            if (p.toggleable) str += p.active ? ' [ON]' : ' [OFF]';
            return str;
        }).join('\n');
        
        return `[FORGE STATE]
CP: ${this.state.total_cp} total, ${this.state.available_cp} available
Corruption: ${this.state.corruption}/100 | Sanity: ${this.state.sanity}/100
${this.state.has_uncapped ? 'UNCAPPED ACTIVE' : ''}
PERKS (${this.state.acquired_perks.length}):
${perksStr || '(none)'}`;
    }
    
    generateForgeBlockInjection() {
        return `\`\`\`forge\n${JSON.stringify(this.generateSimTrackerJSON(), null, 2)}\n\`\`\``;
    }

    // ==================== AI RESPONSE PROCESSING ====================

    processAIResponse(text) {
        if (!this.getSettings().enabled) return null;
        
        const actions = [];
        
        // Parse forge block
        const forgeBlock = this.parseForgeBlock(text);
        if (forgeBlock && this.getSettings().auto_parse_forge_blocks) {
            this.syncFromForgeBlock(forgeBlock);
            actions.push({ type: 'forge_sync' });
        }
        
        // Parse narrative perks
        const perkMatches = text.matchAll(/\*\*([A-Z][A-Z\s]+?)\*\*\s*\((\d+)\s*CP\).*?\[([^\]]*)\]/gi);
        for (const match of perkMatches) {
            const exists = this.state.acquired_perks.some(p => 
                p.name.toLowerCase() === match[1].trim().toLowerCase()
            );
            if (!exists) {
                this.addPerk({
                    name: match[1].trim(),
                    cost: parseInt(match[2]),
                    flags: match[3].split(/[,\s]+/).filter(f => f.trim())
                });
                actions.push({ type: 'perk_added', name: match[1].trim() });
            }
        }
        
        // Parse corruption/sanity
        const corruptionMatch = text.match(/corruption[:\s]+([+-]?\d+)/i);
        if (corruptionMatch) {
            this.state.corruption = Math.min(100, Math.max(0, this.state.corruption + parseInt(corruptionMatch[1])));
        }
        
        const sanityMatch = text.match(/sanity[:\s]+([+-]?\d+)/i);
        if (sanityMatch) {
            this.state.sanity = Math.min(100, Math.max(0, this.state.sanity + parseInt(sanityMatch[1])));
        }
        
        this.incrementResponse();
        
        if (this.getSettings().debug_mode) {
            console.log('[Celestial Forge] Processed:', actions);
        }
        
        return actions;
    }

    // ==================== PERSISTENCE ====================

    saveState() {
        try {
            const context = getContext();
            const key = context?.chatId ? `celestialForge_${context.chatId}` : 'celestialForge_global';
            localStorage.setItem(key, JSON.stringify(this.state));
        } catch (e) {
            console.warn('[Celestial Forge] Save failed:', e);
        }
    }

    loadState() {
        try {
            const context = getContext();
            let saved = context?.chatId ? localStorage.getItem(`celestialForge_${context.chatId}`) : null;
            if (!saved) saved = localStorage.getItem('celestialForge_global');
            if (saved) {
                this.state = { ...this.getDefaultState(), ...JSON.parse(saved) };
                this.syncToSimTracker();
            }
        } catch (e) {
            console.warn('[Celestial Forge] Load failed:', e);
        }
        return this.state;
    }

    resetState() {
        this.state = this.getDefaultState();
        this.saveState();
        this.syncToSimTracker();
        return this.state;
    }

    getStatus() {
        return {
            version: this.extensionVersion,
            enabled: this.getSettings().enabled,
            perks: this.state.acquired_perks.length,
            cp: this.state.total_cp,
            uncapped: this.state.has_uncapped
        };
    }
}

// ==================== SILLYTAVERN INIT ====================

let tracker = null;

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }
}

function onMessageReceived(data) {
    if (!tracker) return;
    const text = typeof data === 'string' ? data : (data?.message || data?.mes || '');
    if (text) tracker.processAIResponse(text);
}

function onChatChanged() {
    if (tracker) tracker.loadState();
}

// Initialize on jQuery ready
jQuery(async () => {

    registerExtension({
        name: extensionName,
        display_name: "Celestial Forge Tracker",
        version: "9.1.0",
        author: "Claude & LO",
        description: "Tracks Celestial Forge CP, perks, thresholds, and injections."
    });

    loadSettings();

    tracker = new CelestialForgeTracker();
    tracker.loadState();

    window.celestialForge = tracker;
    window.CelestialForgeTracker = CelestialForgeTracker;
    window.getCelestialForgeInjection = () => tracker?.generateContextBlock() || '';
    window.getCelestialForgeJSON = () => tracker?.generateForgeBlockInjection() || '';

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    console.log('[Celestial Forge Tracker v9.1] Ready!', tracker.getStatus());
});


export { CelestialForgeTracker };

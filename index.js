// Celestial Forge Tracker v9.5
// Changelog:
//   - FIX: removed ES6 `export` statement (caused SyntaxError in non-module ST context)
//   - FIX: corruption/sanity regex now scoped to forge blocks only (was matching perk descriptions)
//   - FIX: message dedup now uses ST chat array index instead of 100-char string fingerprint
//   - FIX: manifest version synced to match code version
//   - IMPROVE: syncToSimTracker fires celestial-forge-update for HUD live sync

const MODULE_NAME = "celestial-forge-tracker";

const defaultSettings = {
    enabled: true,
    cp_per_response: 10,
    threshold_base: 100,
    auto_parse_forge_blocks: true,
    sync_to_simtracker: true,
    debug_mode: true
};

let extensionSettings, saveSettingsDebounced, eventSource, event_types;
let settings = null;
let tracker = null;
let lastProcessedMessageIndex = -1; // FIX: index-based dedup instead of string fingerprint
let messageObserver = null;

// ==================== CELESTIAL FORGE TRACKER CLASS ====================

class CelestialForgeTracker {
    constructor() {
        this.extensionVersion = "9.5.0";
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
        return settings || defaultSettings;
    }

    calculateTotals() {
        this.state.total_cp        = this.state.base_cp + this.state.bonus_cp;
        this.state.spent_cp        = this.state.acquired_perks.reduce((sum, p) => sum + (p.cost || 0), 0);
        this.state.available_cp    = this.state.total_cp - this.state.spent_cp;
        this.state.threshold_progress = this.state.total_cp % this.state.threshold;
    }

    incrementResponse() {
        this.state.response_count++;
        this.state.base_cp = this.state.response_count * (this.getSettings().cp_per_response || 10);
        this.calculateTotals();
        this.saveState();
        return this.state;
    }

    addPerk(perkData) {
        if (perkData.name?.toUpperCase().includes('UNCAPPED') ||
            perkData.flags?.includes('UNCAPPED')) {
            this.state.has_uncapped = true;
            this.applyUncappedToAllPerks();
        }

        const perk = {
            name:             perkData.name || "Unknown Perk",
            cost:             parseInt(perkData.cost) || 100,
            flags:            Array.isArray(perkData.flags) ? perkData.flags : [],
            description:      perkData.description || "",
            constellation:    perkData.constellation || "Unknown",
            toggleable:       perkData.flags?.includes('TOGGLEABLE') || false,
            active:           perkData.active !== false,
            acquired_at:      Date.now(),
            acquired_response: this.state.response_count,
            scaling:          this.createScalingObject(perkData)
        };

        this.calculateTotals();

        if (perk.cost <= this.state.available_cp) {
            this.state.acquired_perks.push(perk);
            this.state.perk_history.push({
                action: 'acquired',
                perk:   perk.name,
                cost:   perk.cost,
                timestamp: Date.now()
            });

            if (this.state.pending_perk?.name === perk.name) {
                this.state.pending_perk = null;
            }

            this.calculateTotals();
            this.saveState();
            this.syncToSimTracker();
            updateUI();

            if (this.getSettings().debug_mode) {
                console.log(`[CF] ✅ Perk acquired: ${perk.name} (${perk.cost} CP)`);
            }

            return { success: true, perk };
        } else {
            this.state.pending_perk = {
                name:     perk.name,
                cost:     perk.cost,
                flags:    perk.flags,
                cp_needed: perk.cost - this.state.available_cp
            };
            this.saveState();
            updateUI();

            if (this.getSettings().debug_mode) {
                console.log(`[CF] ⏳ Perk pending: ${perk.name} (need ${this.state.pending_perk.cp_needed} more CP)`);
            }

            return { success: false, reason: 'insufficient_cp', pending: this.state.pending_perk };
        }
    }

    createScalingObject(perkData) {
        const hasScaling = perkData.flags?.includes('SCALING');
        if (!hasScaling && !perkData.scaling) return null;

        if (perkData.scaling && typeof perkData.scaling === 'object') {
            return {
                level:    perkData.scaling.level    || 1,
                maxLevel: this.state.has_uncapped ? 999 : (perkData.scaling.maxLevel || 5),
                xp:       perkData.scaling.xp       || 0,
                xp_percent: perkData.scaling.xp_percent || 0,
                uncapped: this.state.has_uncapped || perkData.scaling.uncapped || false
            };
        }

        return {
            level:    1,
            maxLevel: this.state.has_uncapped ? 999 : 5,
            xp:       0,
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
        console.log('[Celestial Forge] ⚡ UNCAPPED acquired! All scaling perks unlimited!');
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
        updateUI();
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
        updateUI();
        return perk.scaling;
    }

    togglePerk(perkName) {
        const perk = this.state.acquired_perks.find(p =>
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (!perk)            return { success: false, reason: 'not_found' };
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
        updateUI();
        return { success: true, active: perk.active };
    }

    parseForgeBlock(text) {
        const forgeMatch = text.match(/```forge\s*([\s\S]*?)```/);
        if (!forgeMatch) return null;

        try {
            const data = JSON.parse(forgeMatch[1].trim());
            if (!data.characters?.[0]) return null;

            const char  = data.characters[0];
            const stats = char.stats || char;

            return {
                raw:           data,
                characterName: char.characterName || char.name || "Smith",
                total_cp:      stats.total_cp     || 0,
                available_cp:  stats.available_cp || 0,
                corruption:    stats.corruption   || 0,
                sanity:        stats.sanity       || 0,
                perks:         this.normalizePerks(stats.perks || stats.perks_list),
                pending_perk:  stats.pending_perk || ""
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
                return match
                    ? { name: match[1].trim(), cost: parseInt(match[2]), flags: [], scaling: null }
                    : null;
            }).filter(Boolean);
        }
        return [];
    }

    normalizePerk(perk) {
        const hasScaling = perk.flags?.includes('SCALING') || perk.scaling;
        return {
            name:       perk.name   || "Unknown",
            cost:       parseInt(perk.cost) || 0,
            flags:      perk.flags  || [],
            description: perk.description || "",
            toggleable: perk.toggleable || perk.flags?.includes('TOGGLEABLE'),
            active:     perk.active !== false,
            scaling:    hasScaling ? {
                level:    perk.scaling?.level    || 1,
                maxLevel: this.state.has_uncapped ? 999 : (perk.scaling?.maxLevel || 5),
                xp:       perk.scaling?.xp       || 0,
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

        // FIX: only update corruption/sanity from the parsed forge block,
        // never from free-text regex (was matching perk description prose)
        this.state.corruption = parsed.corruption;
        this.state.sanity     = parsed.sanity;

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
        updateUI();
        return true;
    }

    generateSimTrackerJSON() {
        return {
            characters: [{
                characterName:   "Smith",
                currentDateTime: new Date().toLocaleString(),
                bgColor:         "#e94560",
                stats: {
                    total_cp:           this.state.total_cp,
                    available_cp:       this.state.available_cp,
                    spent_cp:           this.state.spent_cp,
                    threshold_progress: this.state.threshold_progress,
                    threshold_max:      this.state.threshold,
                    threshold_percent:  Math.round((this.state.threshold_progress / this.state.threshold) * 100),
                    corruption:         this.state.corruption,
                    sanity:             this.state.sanity,
                    perk_count:         this.state.acquired_perks.length,
                    perks: this.state.acquired_perks.map(p => ({
                        name:        p.name,
                        cost:        p.cost,
                        flags:       p.flags,
                        flags_str:   p.flags?.join(', ') || '',
                        description: p.description,
                        toggleable:  p.toggleable,
                        active:      p.active,
                        has_scaling: !!p.scaling,
                        is_uncapped: p.scaling?.uncapped || false,
                        scaling:     p.scaling ? {
                            level:       p.scaling.level,
                            maxLevel:    p.scaling.maxLevel,
                            xp:          p.scaling.xp,
                            xp_percent:  p.scaling.xp_percent,
                            uncapped:    p.scaling.uncapped,
                            level_display: p.scaling.uncapped
                                ? `Lv.${p.scaling.level}/∞`
                                : `Lv.${p.scaling.level}/${p.scaling.maxLevel}`,
                            xp_display: `${p.scaling.xp}/${p.scaling.level * 10} XP`
                        } : null
                    })),
                    pending_perk:      this.state.pending_perk?.name     || "",
                    pending_cp:        this.state.pending_perk?.cost     || 0,
                    pending_remaining: this.state.pending_perk?.cp_needed || 0
                }
            }]
        };
    }

    syncToSimTracker() {
        try {
            const data = this.generateSimTrackerJSON();
            if (window.SimTracker) window.SimTracker.updateData(data);
            // Keep global reference for HUD to read on init
            window.celestialForgeState = data;
            // Fire event so HUD can update without polling
            window.dispatchEvent(new CustomEvent('celestial-forge-update', { detail: data }));
        } catch (e) {
            console.warn('[Celestial Forge] Sync failed:', e);
        }
    }

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

    processAIResponse(text) {
        if (!this.getSettings().enabled) return null;

        const actions = [];

        // Parse forge blocks — corruption/sanity are read ONLY from here now,
        // not from free-text regex, preventing false triggers from perk descriptions.
        const forgeBlock = this.parseForgeBlock(text);
        if (forgeBlock && this.getSettings().auto_parse_forge_blocks) {
            this.syncFromForgeBlock(forgeBlock);
            actions.push({ type: 'forge_sync' });
            if (this.getSettings().debug_mode) {
                console.log('[CF] 📦 Forge block parsed and synced');
            }
        }

        // Parse inline perks: **PERK NAME** (100 CP) [FLAGS]
        const perkMatches = text.matchAll(/\*\*([A-Z][A-Z\s]+?)\*\*\s*\((\d+)\s*CP\).*?\[([^\]]*)\]/gi);
        for (const match of perkMatches) {
            const exists = this.state.acquired_perks.some(p =>
                p.name.toLowerCase() === match[1].trim().toLowerCase()
            );
            if (!exists) {
                this.addPerk({
                    name:  match[1].trim(),
                    cost:  parseInt(match[2]),
                    flags: match[3].split(/[,\s]+/).filter(f => f.trim())
                });
                actions.push({ type: 'perk_added', name: match[1].trim() });
            }
        }

        // Increment response count and CP
        this.incrementResponse();

        if (this.getSettings().debug_mode && actions.length > 0) {
            console.log('[CF] 🎯 Processed AI response:', actions);
        }

        return actions;
    }

    saveState() {
        try {
            const context = SillyTavern.getContext();
            const key = context?.chatId
                ? `celestialForge_${context.chatId}`
                : 'celestialForge_global';
            localStorage.setItem(key, JSON.stringify(this.state));
        } catch (e) {
            console.warn('[Celestial Forge] Save failed:', e);
        }
    }

    loadState() {
        try {
            const context = SillyTavern.getContext();
            let saved = context?.chatId
                ? localStorage.getItem(`celestialForge_${context.chatId}`)
                : null;
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
        updateUI();
        return this.state;
    }

    getStatus() {
        return {
            version: this.extensionVersion,
            enabled: this.getSettings().enabled,
            perks:   this.state.acquired_perks.length,
            cp:      this.state.total_cp,
            uncapped: this.state.has_uncapped
        };
    }
}

// ==================== UI ====================

function getSettingsHtml() {
    return `
    <div id="celestial-forge-settings" class="celestial-forge-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>⚒️ Celestial Forge Tracker v9.5</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="cf-status-section">
                    <div class="cf-stat-row">
                        <span>Total CP:</span>
                        <span id="cf-total-cp" class="cf-value">0</span>
                    </div>
                    <div class="cf-stat-row">
                        <span>Available CP:</span>
                        <span id="cf-available-cp" class="cf-value">0</span>
                    </div>
                    <div class="cf-stat-row">
                        <span>Spent CP:</span>
                        <span id="cf-spent-cp" class="cf-value">0</span>
                    </div>
                    <div class="cf-stat-row">
                        <span>Perks Acquired:</span>
                        <span id="cf-perk-count" class="cf-value">0</span>
                    </div>

                    <div style="margin-top: 10px;">
                        <div style="display:flex; justify-content:space-between; font-size:11px; color:#aaa; margin-bottom:4px;">
                            <span>Next Threshold:</span>
                            <span id="cf-threshold-text">0/100</span>
                        </div>
                        <div class="cf-progress-bar">
                            <div id="cf-threshold-bar" class="cf-progress-fill cp" style="width:0%"></div>
                        </div>
                    </div>

                    <div style="margin-top: 8px;">
                        <div style="display:flex; justify-content:space-between; font-size:11px; color:#aaa; margin-bottom:4px;">
                            <span>Corruption:</span>
                            <span id="cf-corruption-text">0/100</span>
                        </div>
                        <div class="cf-progress-bar">
                            <div id="cf-corruption-bar" class="cf-progress-fill corruption" style="width:0%"></div>
                        </div>
                    </div>

                    <div style="margin-top: 8px;">
                        <div style="display:flex; justify-content:space-between; font-size:11px; color:#aaa; margin-bottom:4px;">
                            <span>Sanity:</span>
                            <span id="cf-sanity-text">0/100</span>
                        </div>
                        <div class="cf-progress-bar">
                            <div id="cf-sanity-bar" class="cf-progress-fill sanity" style="width:0%"></div>
                        </div>
                    </div>
                </div>

                <div id="cf-pending-container" style="display:none;"></div>

                <div class="cf-settings-section">
                    <label class="checkbox_label" for="cf-enabled">
                        <input type="checkbox" id="cf-enabled" />
                        <span>Enable Tracking</span>
                    </label>
                    <label class="checkbox_label" for="cf-auto-parse">
                        <input type="checkbox" id="cf-auto-parse" />
                        <span>Auto-parse forge blocks</span>
                    </label>
                    <label class="checkbox_label" for="cf-simtracker-sync">
                        <input type="checkbox" id="cf-simtracker-sync" />
                        <span>Sync to SimTracker</span>
                    </label>
                    <label class="checkbox_label" for="cf-debug">
                        <input type="checkbox" id="cf-debug" />
                        <span>Debug Mode (Console Logging)</span>
                    </label>

                    <div class="cf-input-row">
                        <label>CP per Response:</label>
                        <input type="number" id="cf-cp-per-response" min="1" max="1000" value="10" />
                    </div>
                </div>

                <div class="cf-actions">
                    <input type="number" id="cf-bonus-cp-input" placeholder="Bonus CP amount" style="margin-bottom:8px;" />
                    <div class="cf-button-row">
                        <input type="button" class="menu_button" id="cf-add-bonus-cp" value="➕ Add Bonus CP" />
                        <input type="button" class="menu_button" id="cf-reset-state"  value="🔄 Reset State" />
                    </div>
                </div>

                <div style="margin-top: 10px;">
                    <div style="font-weight:bold; color:#e94560; margin-bottom:6px;">📜 Acquired Perks:</div>
                    <div id="cf-perk-list" class="cf-perk-list">
                        <small>No perks acquired yet</small>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
}

function updateUI() {
    if (!tracker) return;

    const state = tracker.state;

    $('#cf-total-cp').text(state.total_cp);
    $('#cf-available-cp').text(state.available_cp);
    $('#cf-spent-cp').text(state.spent_cp);
    $('#cf-perk-count').text(state.acquired_perks.length);

    const thresholdPercent = Math.round((state.threshold_progress / state.threshold) * 100);
    $('#cf-threshold-text').text(`${state.threshold_progress}/${state.threshold}`);
    $('#cf-threshold-bar').css('width', `${thresholdPercent}%`);

    $('#cf-corruption-text').text(`${state.corruption}/100`);
    $('#cf-corruption-bar').css('width', `${state.corruption}%`);

    $('#cf-sanity-text').text(`${state.sanity}/100`);
    $('#cf-sanity-bar').css('width', `${state.sanity}%`);

    const pendingContainer = $('#cf-pending-container');
    if (state.pending_perk) {
        pendingContainer.html(`
            <div class="cf-pending">
                <div class="cf-pending-title">⏳ Pending Perk</div>
                <div class="cf-pending-name">${state.pending_perk.name}</div>
                <div style="font-size:11px; color:#f1c40f; margin-top:4px;">
                    Cost: ${state.pending_perk.cost} CP | Need ${state.pending_perk.cp_needed} more CP
                </div>
            </div>`).show();
    } else {
        pendingContainer.hide();
    }

    const perkList = $('#cf-perk-list');
    if (state.acquired_perks.length === 0) {
        perkList.html('<small>No perks acquired yet</small>');
        return;
    }

    const perksHtml = state.acquired_perks.map((p, idx) => {
        const flagsHtml = p.flags.map(flag => {
            const flagClass = flag.toLowerCase().replace(/-/g, '');
            return `<span class="cf-perk-flag ${flagClass}">${flag}</span>`;
        }).join('');

        let scalingHtml = '';
        if (p.scaling) {
            const maxStr      = p.scaling.uncapped ? '∞' : p.scaling.maxLevel;
            const uncappedCls = p.scaling.uncapped ? 'uncapped' : '';
            const xpPercent   = p.scaling.xp_percent || 0;
            scalingHtml = `
                <div class="cf-scaling-bar">
                    <div class="cf-scaling-label ${uncappedCls}">Lv.${p.scaling.level}/${maxStr}</div>
                    <div class="cf-scaling-progress">
                        <div class="cf-scaling-fill ${uncappedCls}" style="width:${xpPercent}%"></div>
                    </div>
                    <div style="font-size:10px; color:#2ecc71; min-width:60px; text-align:right;">
                        ${p.scaling.xp}/${p.scaling.level * 10} XP
                    </div>
                </div>`;
        }

        let toggleHtml = '';
        if (p.toggleable) {
            const toggleCls   = p.active ? 'fa-toggle-on' : 'fa-toggle-off';
            const toggleColor = p.active ? '#2ecc71' : '#666';
            toggleHtml = `
                <div class="cf-perk-toggle" data-perk="${p.name}"
                     style="cursor:pointer; color:${toggleColor}; font-size:16px;">
                    <i class="fa-solid ${toggleCls}"></i>
                </div>`;
        }

        const activeClass = p.toggleable && !p.active ? 'cf-inactive' : '';
        const descHtml    = p.description
            ? `<div style="font-size:10px; color:#999; margin-top:4px; font-style:italic;">${p.description}</div>`
            : '';

        return `
            <div class="cf-perk-item ${activeClass}" data-perk-idx="${idx}">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div class="cf-perk-name">${p.name}</div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <div class="cf-perk-cost">${p.cost} CP</div>
                        ${toggleHtml}
                    </div>
                </div>
                ${descHtml}
                <div class="cf-perk-flags">${flagsHtml}</div>
                ${scalingHtml}
            </div>`;
    }).join('');

    perkList.html(perksHtml);

    $('.cf-perk-toggle').off('click').on('click', function (e) {
        e.stopPropagation();
        tracker.togglePerk($(this).data('perk'));
    });
}

function bindUIEvents() {
    $('#cf-enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#cf-auto-parse').on('change', function () {
        settings.auto_parse_forge_blocks = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#cf-simtracker-sync').on('change', function () {
        settings.sync_to_simtracker = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#cf-debug').on('change', function () {
        settings.debug_mode = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#cf-cp-per-response').on('change', function () {
        settings.cp_per_response = parseInt($(this).val()) || 10;
        saveSettingsDebounced();
    });

    $('#cf-add-bonus-cp').on('click', function () {
        const bonus = parseInt($('#cf-bonus-cp-input').val()) || 0;
        if (bonus > 0 && tracker) {
            tracker.state.bonus_cp += bonus;
            tracker.calculateTotals();
            tracker.saveState();
            tracker.syncToSimTracker();
            updateUI();
            $('#cf-bonus-cp-input').val('');
        }
    });

    $('#cf-reset-state').on('click', function () {
        if (confirm('Reset all Celestial Forge progress? This cannot be undone!')) {
            tracker?.resetState();
        }
    });
}

function loadSettingsUI() {
    $('#cf-enabled').prop('checked', settings.enabled);
    $('#cf-auto-parse').prop('checked', settings.auto_parse_forge_blocks);
    $('#cf-simtracker-sync').prop('checked', settings.sync_to_simtracker);
    $('#cf-debug').prop('checked', settings.debug_mode);
    $('#cf-cp-per-response').val(settings.cp_per_response);
}

// ==================== MESSAGE DETECTION ====================

function onMessageReceived(data) {
    if (!tracker || !settings?.enabled) return;

    // FIX: use ST's chat array index as the dedup key instead of a
    // 100-char string fingerprint, which could accidentally drop legitimate
    // messages that share an opening sentence.
    const context = SillyTavern.getContext();
    const chat    = context?.chat;
    const currentIndex = chat ? chat.length - 1 : -1;

    if (currentIndex <= lastProcessedMessageIndex) {
        if (settings.debug_mode) console.log('[CF] 🔄 Already processed message index', currentIndex);
        return;
    }

    lastProcessedMessageIndex = currentIndex;

    const text = typeof data === 'string' ? data
               : (data?.message || data?.mes || data?.content || '');

    if (!text) return;

    if (settings.debug_mode) {
        console.log('[CF] 📨 Processing message index', currentIndex, '—', text.substring(0, 50) + '…');
    }

    tracker.processAIResponse(text);
    updateUI();
}

function onChatChanged() {
    if (tracker) {
        tracker.loadState();
        updateUI();
        lastProcessedMessageIndex = -1;
        if (settings?.debug_mode) console.log('[CF] 💬 Chat changed, state reloaded');
    }
}

// ==================== MUTATION OBSERVER (BACKUP) ====================

function setupMutationObserver() {
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) {
        console.warn('[CF] Chat container not found, mutation observer disabled');
        return;
    }

    if (messageObserver) messageObserver.disconnect();

    messageObserver = new MutationObserver((mutations) => {
        if (!tracker || !settings?.enabled) return;

        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1 && node.classList?.contains('mes')) {
                    const isAI = !node.classList.contains('is_user');
                    if (isAI) {
                        const messageText = node.querySelector('.mes_text')?.textContent || '';
                        if (messageText) {
                            if (settings.debug_mode) console.log('[CF] 🔍 MutationObserver: AI message detected');
                            onMessageReceived(messageText);
                        }
                    }
                }
            }
        }
    });

    messageObserver.observe(chatContainer, { childList: true, subtree: true });
    console.log('[CF] 👁️ MutationObserver active');
}

// ==================== INIT ====================

function loadSettings() {
    const context    = SillyTavern.getContext();
    extensionSettings    = context.extensionSettings;
    saveSettingsDebounced = context.saveSettingsDebounced;
    eventSource          = context.eventSource;
    event_types          = context.event_types;

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = Object.assign({}, defaultSettings);
        saveSettingsDebounced();
    }

    settings = extensionSettings[MODULE_NAME];
    return settings;
}

function setupEventListeners() {
    if (!eventSource || !event_types) {
        console.error('[CF] Event system not available!');
        return;
    }

    const eventsToTry = [
        'MESSAGE_RECEIVED',
        'CHARACTER_MESSAGE_RENDERED',
        'MESSAGE_RENDERED',
        'CHAT_MESSAGE_RECEIVED',
        'CHAT_CHANGED'
    ];

    let boundEvents = 0;

    for (const eventName of eventsToTry) {
        if (event_types[eventName]) {
            eventSource.on(
                event_types[eventName],
                eventName === 'CHAT_CHANGED' ? onChatChanged : onMessageReceived
            );
            boundEvents++;
            console.log(`[CF] ✅ Bound to event: ${eventName}`);
        }
    }

    if (boundEvents === 0) {
        console.warn('[CF] ⚠️ No events bound! Available:', Object.keys(event_types));
    } else {
        console.log(`[CF] 🎯 Bound to ${boundEvents} event types`);
    }
}

jQuery(async () => {
    console.log('[CF] 🚀 Initializing Celestial Forge Tracker v9.5…');

    loadSettings();

    $('#extensions_settings').append(getSettingsHtml());

    tracker = new CelestialForgeTracker();
    tracker.loadState();

    bindUIEvents();
    loadSettingsUI();
    updateUI();

    window.celestialForge         = tracker;
    window.CelestialForgeTracker  = CelestialForgeTracker;
    window.getCelestialForgeInjection = () => tracker?.generateContextBlock()       || '';
    window.getCelestialForgeJSON      = () => tracker?.generateForgeBlockInjection() || '';

    setupEventListeners();
    setTimeout(() => setupMutationObserver(), 1000);

    console.log('[CF] ✨ Ready! Status:', tracker.getStatus());
    console.log('[CF] 📋 Debug mode:', settings.debug_mode ? 'ENABLED' : 'DISABLED');
});

// FIX: removed `export { CelestialForgeTracker }` — caused SyntaxError in
// SillyTavern's non-module script loading context. Class remains accessible
// via window.CelestialForgeTracker instead.

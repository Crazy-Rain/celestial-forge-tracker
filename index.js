// Celestial Forge Tracker v9.2 - SillyTavern Extension
// Now with proper UI panel!

const MODULE_NAME = "celestial-forge-tracker";

const defaultSettings = {
    enabled: true,
    cp_per_response: 10,
    threshold_base: 100,
    auto_parse_forge_blocks: true,
    sync_to_simtracker: true,
    debug_mode: false
};

// Will be set after ST loads
let extensionSettings, saveSettingsDebounced, eventSource, event_types;
let settings = null;
let tracker = null;

// ==================== CELESTIAL FORGE TRACKER CLASS ====================

class CelestialForgeTracker {
    constructor() {
        this.extensionVersion = "9.2.0";
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
            updateUI();
            return { success: true, perk };
        } else {
            this.state.pending_perk = {
                name: perk.name,
                cost: perk.cost,
                flags: perk.flags,
                cp_needed: perk.cost - this.state.available_cp
            };
            this.saveState();
            updateUI();
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
        updateUI();
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
        updateUI();
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
            const context = SillyTavern.getContext();
            const key = context?.chatId ? `celestialForge_${context.chatId}` : 'celestialForge_global';
            localStorage.setItem(key, JSON.stringify(this.state));
        } catch (e) {
            console.warn('[Celestial Forge] Save failed:', e);
        }
    }

    loadState() {
        try {
            const context = SillyTavern.getContext();
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
        updateUI();
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

// ==================== UI PANEL ====================

function getSettingsHtml() {
    return `
    <div id="celestial-forge-settings" class="celestial-forge-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>⚒️ Celestial Forge Tracker</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <!-- Status Display -->
                <div class="cf-status-section">
                    <div class="cf-stat-row">
                        <span>Total CP:</span>
                        <span id="cf-total-cp" class="cf-value">0</span>
                    </div>
                    <div class="cf-stat-row">
                        <span>Available:</span>
                        <span id="cf-available-cp" class="cf-value">0</span>
                    </div>
                    <div class="cf-stat-row">
                        <span>Perks:</span>
                        <span id="cf-perk-count" class="cf-value">0</span>
                    </div>
                    <div class="cf-stat-row">
                        <span>Corruption:</span>
                        <span id="cf-corruption" class="cf-value">0/100</span>
                    </div>
                    <div class="cf-stat-row">
                        <span>Sanity:</span>
                        <span id="cf-sanity" class="cf-value">0/100</span>
                    </div>
                </div>
                
                <hr class="sysHR">
                
                <!-- Settings -->
                <div class="cf-settings-section">
                    <label class="checkbox_label">
                        <input type="checkbox" id="cf-enabled" />
                        <span>Enable Tracking</span>
                    </label>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="cf-auto-parse" />
                        <span>Auto-parse Forge Blocks</span>
                    </label>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="cf-simtracker-sync" />
                        <span>Sync to SimTracker</span>
                    </label>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="cf-debug" />
                        <span>Debug Mode</span>
                    </label>
                    
                    <div class="cf-input-row">
                        <label for="cf-cp-per-response">CP per Response:</label>
                        <input type="number" id="cf-cp-per-response" min="1" max="100" value="10" />
                    </div>
                </div>
                
                <hr class="sysHR">
                
                <!-- Actions -->
                <div class="cf-actions">
                    <input id="cf-bonus-cp-input" type="number" class="text_pole" placeholder="Bonus CP" />
                    <div class="cf-button-row">
                        <div id="cf-add-bonus-cp" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-plus"></i>
                            <span>Add Bonus CP</span>
                        </div>
                        <div id="cf-reset-state" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-trash"></i>
                            <span>Reset</span>
                        </div>
                    </div>
                </div>
                
                <!-- Perk List -->
                <div id="cf-perk-list" class="cf-perk-list">
                    <small>No perks acquired yet</small>
                </div>
            </div>
        </div>
    </div>`;
}

function updateUI() {
    if (!tracker) return;
    
    const state = tracker.state;
    
    // Update stats
    $('#cf-total-cp').text(state.total_cp);
    $('#cf-available-cp').text(state.available_cp);
    $('#cf-perk-count').text(state.acquired_perks.length);
    $('#cf-corruption').text(`${state.corruption}/100`);
    $('#cf-sanity').text(`${state.sanity}/100`);
    
    // Update perk list
    const perkList = $('#cf-perk-list');
    if (state.acquired_perks.length === 0) {
        perkList.html('<small>No perks acquired yet</small>');
    } else {
        const perksHtml = state.acquired_perks.map(p => {
            let scalingHtml = '';
            if (p.scaling) {
                const maxStr = p.scaling.uncapped ? '∞' : p.scaling.maxLevel;
                scalingHtml = `<div class="cf-perk-scaling">Lv.${p.scaling.level}/${maxStr}</div>`;
            }
            const activeClass = p.toggleable && !p.active ? 'cf-inactive' : '';
            return `
                <div class="cf-perk-item ${activeClass}">
                    <div class="cf-perk-name">${p.name}</div>
                    <div class="cf-perk-cost">${p.cost} CP</div>
                    ${scalingHtml}
                </div>`;
        }).join('');
        perkList.html(perksHtml);
    }
}

function bindUIEvents() {
    // Settings checkboxes
    $('#cf-enabled').on('change', function() {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#cf-auto-parse').on('change', function() {
        settings.auto_parse_forge_blocks = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#cf-simtracker-sync').on('change', function() {
        settings.sync_to_simtracker = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#cf-debug').on('change', function() {
        settings.debug_mode = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#cf-cp-per-response').on('change', function() {
        settings.cp_per_response = parseInt($(this).val()) || 10;
        saveSettingsDebounced();
    });
    
    // Actions
    $('#cf-add-bonus-cp').on('click', function() {
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
    
    $('#cf-reset-state').on('click', function() {
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

// ==================== SILLYTAVERN INIT ====================

function loadSettings() {
    const context = SillyTavern.getContext();
    extensionSettings = context.extensionSettings;
    saveSettingsDebounced = context.saveSettingsDebounced;
    eventSource = context.eventSource;
    event_types = context.event_types;
    
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = Object.assign({}, defaultSettings);
        saveSettingsDebounced();
    }
    
    settings = extensionSettings[MODULE_NAME];
    return settings;
}

function onMessageReceived(data) {
    if (!tracker) return;
    const text = typeof data === 'string' ? data : (data?.message || data?.mes || '');
    if (text) {
        tracker.processAIResponse(text);
        updateUI();
    }
}

function onChatChanged() {
    if (tracker) {
        tracker.loadState();
        updateUI();
    }
}

// Initialize on jQuery ready
jQuery(async () => {
    loadSettings();
    
    // Add UI to extensions panel
    const settingsHtml = getSettingsHtml();
    $('#extensions_settings').append(settingsHtml);
    
    // Create tracker instance
    tracker = new CelestialForgeTracker();
    tracker.loadState();
    
    // Bind events and load UI state
    bindUIEvents();
    loadSettingsUI();
    updateUI();
    
    // Expose globally
    window.celestialForge = tracker;
    window.CelestialForgeTracker = CelestialForgeTracker;
    window.getCelestialForgeInjection = () => tracker?.generateContextBlock() || '';
    window.getCelestialForgeJSON = () => tracker?.generateForgeBlockInjection() || '';
    
    // Register ST events
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    
    console.log('[Celestial Forge Tracker v9.2] Ready!', tracker.getStatus());
});

export { CelestialForgeTracker };

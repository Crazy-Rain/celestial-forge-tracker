// Celestial Forge Tracker v8.0 - MERGED WORKING VERSION
// v7 event system + v9 scaling features

const MODULE_NAME = 'celestial-forge-tracker';
const DEBUG = true; // Keep debug on for LO!

function log(...args) {
    if (DEBUG) console.log(`[CF]`, ...args);
}

function logError(...args) {
    console.error(`[CF]`, ...args);
}

// ============================================
// DEFAULT SETTINGS & STATE
// ============================================

const defaultSettings = {
    enabled: true,
    autoDetectPerks: true,
    autoDetectCP: true,
    cpPerResponse: 10,
    thresholdCP: 100,
    showNotifications: true,
    perkArchive: [],
    chatStates: {},
    currentChatId: null,
    injectSimTracker: true,
    aggressiveInjection: false,
    promptPosition: 0
};

const defaultChatState = {
    responseCount: 0,
    bonusCP: 0,
    spentCP: 0,
    corruption: 0,
    sanityErosion: 0,
    pendingPerk: null,
    pendingPerkCost: 0,
    acquiredPerks: [],
    activeToggles: [],
    lastThresholdTriggered: 0,
    checkpoints: [],
    createdAt: null,
    lastUpdated: null,
    // NEW from v9: scaling support
    has_uncapped: false,
    perk_history: []
};

// ============================================
// REGEX PATTERNS - EXPANDED FROM v7 + v9
// ============================================

const PERK_PATTERNS = [
    /\*\*([A-Z][A-Z\s\-\']+)\*\*\s*\((\d+)\s*CP\)\s*[-–—:]\s*([^\[]+?)(?:\[([^\]]+)\])?/gi,
    /\[ACQUIRED:\s*([A-Z][A-Z\s\-\']+)\s*[-–—]\s*(\d+)\s*CP\]/gi,
    /(?:you\s+)?gain(?:ed|s)?\s+\*\*([A-Z][A-Z\s\-\']+)\*\*\s*\((\d+)\s*CP\)/gi,
    /^([A-Z][A-Z\s\-\']{3,})\s*\((\d+)\s*CP\)\s*(?:\[([^\]]+)\])?\s*[-–—:]/gim,
    /(?:forge\s+grants|acquired|unlocked|gained):\s*\*?\*?([A-Z][A-Z\s\-\']+)\*?\*?\s*\((\d+)\s*CP\)/gi,
    /<perk[^>]*>([^<]+)<\/perk>\s*\((\d+)\s*CP\)/gi,
    /<acquired[^>]*>([^<]+)<\/acquired>\s*[-–—:]\s*(\d+)\s*CP/gi,
    /<span[^>]*class=["']?perk["']?[^>]*>([^<]+)<\/span>\s*\((\d+)\s*CP\)/gi,
    /perk[_\-]?name['":\s]+([A-Za-z][A-Za-z\s\-\']+)['"]*[,\s]+cost['":\s]+(\d+)/gi
];

// NEW: XP and Level patterns - AI writes these when perks are used!
const XP_PATTERNS = [
    /\*\*([A-Z][A-Z\s\-\']+)\*\*\s+gains?\s+(\d+)\s+XP/gi,
    /\+(\d+)\s+XP\s+to\s+\*?\*?([A-Z][A-Z\s\-\']+)\*?\*?/gi,
    /([A-Z][A-Z\s\-\']+):\s+\+(\d+)\s+XP/gi,
    /<xp[^>]*perk=["']([^"']+)["'][^>]*>(\d+)<\/xp>/gi
];

const LEVEL_UP_PATTERNS = [
    /\*\*([A-Z][A-Z\s\-\']+)\*\*\s+(?:leveled up|levels up|reached level)\s+(?:to\s+)?(?:Level\s+)?(\d+)/gi,
    /([A-Z][A-Z\s\-\']+)\s+is now\s+(?:Level\s+)?(\d+)/gi,
    /<levelup[^>]*perk=["']([^"']+)["'][^>]*>(\d+)<\/levelup>/gi
];

const CP_GAIN_PATTERNS = [
    /\+(\d+)\s*(?:Bonus\s*)?CP/gi,
    /Award:\s*\+?(\d+)\s*(?:Bonus\s*)?CP/gi,
    /\[FORGE\s+RESONANCE[^\]]*\].*?\+(\d+)\s*(?:Bonus\s*)?CP/gi,
    /(?:gains?|earned?|receives?|awarded?)\s+(\d+)\s*(?:Bonus\s*)?CP/gi,
    /total[_\-]?cp['":\s]+(\d+)/gi,
    /<cp[^>]*>(\d+)<\/cp>/gi,
    /cp[_\-]?earned['":\s]+(\d+)/gi
];

const CORRUPTION_PATTERNS = [
    /\+(\d+)\s*Corruption/gi,
    /Corruption:\s*\+(\d+)/gi,
    /[-–—](\d+)\s*Corruption/gi,
    /corruption['":\s]+(\d+)/gi,
    /<corruption[^>]*>(\d+)<\/corruption>/gi
];

const SANITY_PATTERNS = [
    /\+(\d+)\s*Sanity\s*(?:Erosion|Cost)/gi,
    /Sanity\s*(?:Erosion|Cost):\s*\+(\d+)/gi,
    /sanity[_\-]?erosion['":\s]+(\d+)/gi,
    /<sanity[^>]*>(\d+)<\/sanity>/gi
];

// NEW: Forge block parser (from v9)
const FORGE_BLOCK_PATTERN = /```forge\s*([\s\S]*?)```/gi;

// ============================================
// PERK STRUCTURE WITH SCALING
// ============================================

function createPerk(name, cost, description = '', flags = []) {
    const hasScaling = flags.includes('SCALING');
    const isUncapped = flags.includes('UNCAPPED');
    
    return {
        id: generateId(),
        name: name.toUpperCase(),
        cost: parseInt(cost) || 0,
        description: description.trim(),
        flags: flags.filter(f => f.trim()),
        isToggleable: flags.includes('TOGGLEABLE'),
        isActive: true,
        acquiredAt: Date.now(),
        // NEW: Scaling support from v9!
        scaling: hasScaling ? {
            level: 1,
            maxLevel: isUncapped ? Infinity : 10,
            xp: 0,
            xp_needed: 10, // XP needed for next level
            uncapped: isUncapped
        } : null
    };
}

function generateId() {
    return `perk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================
// STATE MANAGEMENT
// ============================================

let extensionSettings = {};
let saveSettingsDebounced;

function getSettings() {
    return extensionSettings[MODULE_NAME] || defaultSettings;
}

function saveSettings() {
    if (saveSettingsDebounced) {
        saveSettingsDebounced();
    }
}

function getCurrentState() {
    const settings = getSettings();
    const chatId = settings.currentChatId;
    
    if (!chatId) return null;
    
    if (!settings.chatStates[chatId]) {
        settings.chatStates[chatId] = { ...defaultChatState, createdAt: Date.now() };
    }
    
    return settings.chatStates[chatId];
}

function getTotalCP(state) {
    return (state.responseCount * getSettings().cpPerResponse) + (state.bonusCP || 0);
}

function getAvailableCP(state) {
    return getTotalCP(state) - (state.spentCP || 0);
}

// ============================================
// PERK MANAGEMENT WITH SCALING
// ============================================

function addPerk(perkData) {
    const state = getCurrentState();
    if (!state) return false;
    
    const exists = state.acquiredPerks.some(p => 
        p.name.toUpperCase() === perkData.name.toUpperCase()
    );
    
    if (exists) {
        log(`⚠️ Perk already exists: ${perkData.name}`);
        return false;
    }
    
    const perk = createPerk(
        perkData.name,
        perkData.cost,
        perkData.description || '',
        perkData.flags || []
    );
    
    // Check if this is UNCAPPED perk - special handling!
    if (perk.flags.includes('UNCAPPED')) {
        applyUncappedToAllPerks(state);
    }
    
    state.acquiredPerks.push(perk);
    state.spentCP = (state.spentCP || 0) + perk.cost;
    state.perk_history.push({ name: perk.name, timestamp: Date.now() });
    
    if (perk.isToggleable && perk.isActive) {
        state.activeToggles.push(perk.name);
    }
    
    log(`✅ Added perk: ${perk.name} (${perk.cost} CP)${perk.scaling ? ' [SCALING]' : ''}`);
    
    saveSettings();
    updateUI();
    return true;
}

function applyUncappedToAllPerks(state) {
    log('🔓 UNCAPPED acquired! Removing level caps from all scaling perks!');
    state.has_uncapped = true;
    
    state.acquiredPerks.forEach(perk => {
        if (perk.scaling) {
            perk.scaling.maxLevel = Infinity;
            perk.scaling.uncapped = true;
        }
    });
}

function addXPToPerk(perkName, xpAmount) {
    const state = getCurrentState();
    if (!state) return false;
    
    const perk = state.acquiredPerks.find(p => 
        p.name.toUpperCase() === perkName.toUpperCase()
    );
    
    if (!perk || !perk.scaling) {
        log(`⚠️ Can't add XP to ${perkName} - not a scaling perk`);
        return false;
    }
    
    perk.scaling.xp += xpAmount;
    log(`📈 ${perk.name} +${xpAmount} XP (${perk.scaling.xp}/${perk.scaling.xp_needed})`);
    
    // Check for level up!
    while (perk.scaling.xp >= perk.scaling.xp_needed && perk.scaling.level < perk.scaling.maxLevel) {
        perk.scaling.xp -= perk.scaling.xp_needed;
        perk.scaling.level++;
        perk.scaling.xp_needed = perk.scaling.level * 10; // Scales with level
        log(`⬆️ ${perk.name} leveled up to Level ${perk.scaling.level}!`);
    }
    
    saveSettings();
    updateUI();
    return true;
}

function setPerkLevel(perkName, level) {
    const state = getCurrentState();
    if (!state) return false;
    
    const perk = state.acquiredPerks.find(p => 
        p.name.toUpperCase() === perkName.toUpperCase()
    );
    
    if (!perk || !perk.scaling) return false;
    
    perk.scaling.level = Math.min(level, perk.scaling.maxLevel);
    perk.scaling.xp_needed = perk.scaling.level * 10;
    log(`📊 ${perk.name} set to Level ${perk.scaling.level}`);
    
    saveSettings();
    updateUI();
    return true;
}

function togglePerk(perkId) {
    const state = getCurrentState();
    if (!state) return;
    
    const perk = state.acquiredPerks.find(p => p.id === perkId);
    if (!perk || !perk.isToggleable) return;
    
    perk.isActive = !perk.isActive;
    
    if (perk.isActive) {
        state.activeToggles.push(perk.name);
    } else {
        state.activeToggles = state.activeToggles.filter(n => n !== perk.name);
    }
    
    log(`🔄 Toggled ${perk.name}: ${perk.isActive ? 'ON' : 'OFF'}`);
    
    saveSettings();
    updateUI();
}

function removePerk(perkId) {
    const state = getCurrentState();
    if (!state) return;
    
    const index = state.acquiredPerks.findIndex(p => p.id === perkId);
    if (index === -1) return;
    
    const perk = state.acquiredPerks[index];
    state.spentCP -= perk.cost;
    state.acquiredPerks.splice(index, 1);
    state.activeToggles = state.activeToggles.filter(n => n !== perk.name);
    
    log(`❌ Removed perk: ${perk.name}`);
    
    saveSettings();
    updateUI();
}

// ============================================
// MESSAGE PROCESSING - v7's WORKING METHOD!
// ============================================

function processAIMessage(messageText) {
    const settings = getSettings();
    const state = getCurrentState();
    if (!state) return;
    
    log('🔍 Processing AI message...');
    
    // Parse forge blocks first (from v9)
    parseForgeBlocks(messageText);
    
    // Detect perks
    if (settings.autoDetectPerks) {
        detectPerks(messageText);
    }
    
    // Detect XP gains (NEW!)
    detectXPGains(messageText);
    
    // Detect level ups (NEW!)
    detectLevelUps(messageText);
    
    // Detect CP gains
    if (settings.autoDetectCP) {
        detectCPGains(messageText);
    }
    
    // Detect corruption/sanity
    detectCorruption(messageText);
    detectSanity(messageText);
    
    saveSettings();
    updateUI();
}

function parseForgeBlocks(text) {
    const state = getCurrentState();
    if (!state) return;
    
    let match;
    FORGE_BLOCK_PATTERN.lastIndex = 0;
    
    while ((match = FORGE_BLOCK_PATTERN.exec(text)) !== null) {
        try {
            const cleanText = match[1].replace(/<[^>]*>/g, ''); // Strip HTML
            const data = JSON.parse(cleanText);
            
            if (data.characters && data.characters[0]) {
                const char = data.characters[0];
                const stats = char.stats || char;
                
                log('📦 Forge block detected!');
                
                // Sync CP
                if (stats.total_cp !== undefined) {
                    const responseCP = state.responseCount * getSettings().cpPerResponse;
                    state.bonusCP = stats.total_cp - responseCP;
                }
                
                // Sync corruption/sanity
                if (stats.corruption !== undefined) state.corruption = stats.corruption;
                if (stats.sanity !== undefined) state.sanityErosion = stats.sanity;
                
                // Sync perks
                if (stats.perks && Array.isArray(stats.perks)) {
                    stats.perks.forEach(perkData => {
                        const exists = state.acquiredPerks.some(p => 
                            p.name.toUpperCase() === perkData.name.toUpperCase()
                        );
                        
                        if (!exists) {
                            addPerk(perkData);
                        } else {
                            // Update existing perk (for scaling data)
                            const perk = state.acquiredPerks.find(p => 
                                p.name.toUpperCase() === perkData.name.toUpperCase()
                            );
                            
                            if (perk && perkData.scaling && perk.scaling) {
                                perk.scaling.level = perkData.scaling.level || perk.scaling.level;
                                perk.scaling.xp = perkData.scaling.xp || perk.scaling.xp;
                            }
                        }
                    });
                }
            }
        } catch (e) {
            logError('Failed to parse forge block:', e);
        }
    }
}

function detectPerks(text) {
    const state = getCurrentState();
    if (!state) return;
    
    for (const pattern of PERK_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        
        while ((match = pattern.exec(text)) !== null) {
            const name = match[1];
            const cost = parseInt(match[2]) || 0;
            const description = match[3] || '';
            const flagsStr = match[4] || '';
            const flags = flagsStr.split(/[,\s]+/).filter(f => f.trim());
            
            const exists = state.acquiredPerks.some(p => 
                p.name.toUpperCase() === name.toUpperCase()
            );
            
            if (!exists && cost > 0) {
                addPerk({ name, cost, description, flags });
            }
        }
    }
}

function detectXPGains(text) {
    const state = getCurrentState();
    if (!state) return;
    
    for (const pattern of XP_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        
        while ((match = pattern.exec(text)) !== null) {
            // Pattern 1: **PERK** gains XP
            if (match[1] && match[2]) {
                addXPToPerk(match[1], parseInt(match[2]));
            }
            // Pattern 2: +XP to PERK (reversed order)
            else if (match[2] && match[1]) {
                addXPToPerk(match[2], parseInt(match[1]));
            }
        }
    }
}

function detectLevelUps(text) {
    const state = getCurrentState();
    if (!state) return;
    
    for (const pattern of LEVEL_UP_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        
        while ((match = pattern.exec(text)) !== null) {
            const name = match[1];
            const level = parseInt(match[2]);
            
            if (name && level) {
                setPerkLevel(name, level);
            }
        }
    }
}

function detectCPGains(text) {
    const state = getCurrentState();
    if (!state) return;
    
    for (const pattern of CP_GAIN_PATTERNS) {
        pattern.lastIndex = 0;
        const match = pattern.exec(text);
        
        if (match && match[1]) {
            const bonus = parseInt(match[1]);
            state.bonusCP = (state.bonusCP || 0) + bonus;
            log(`💰 Bonus CP detected: +${bonus}`);
        }
    }
}

function detectCorruption(text) {
    const state = getCurrentState();
    if (!state) return;
    
    for (const pattern of CORRUPTION_PATTERNS) {
        pattern.lastIndex = 0;
        const match = pattern.exec(text);
        
        if (match && match[1]) {
            const amount = parseInt(match[1]);
            state.corruption = Math.min(100, Math.max(0, state.corruption + amount));
            log(`😈 Corruption: ${state.corruption}`);
        }
    }
}

function detectSanity(text) {
    const state = getCurrentState();
    if (!state) return;
    
    for (const pattern of SANITY_PATTERNS) {
        pattern.lastIndex = 0;
        const match = pattern.exec(text);
        
        if (match && match[1]) {
            const amount = parseInt(match[1]);
            state.sanityErosion = Math.min(100, Math.max(0, state.sanityErosion + amount));
            log(`🧠 Sanity Erosion: ${state.sanityErosion}`);
        }
    }
}

function incrementResponseCount() {
    const state = getCurrentState();
    if (!state) return;
    
    state.responseCount++;
    state.lastUpdated = Date.now();
    
    const totalCP = getTotalCP(state);
    const threshold = getSettings().thresholdCP;
    
    if (Math.floor(totalCP / threshold) > state.lastThresholdTriggered) {
        state.lastThresholdTriggered = Math.floor(totalCP / threshold);
        log(`🎯 Threshold reached: ${totalCP}/${threshold}`);
    }
    
    log(`📊 Response #${state.responseCount}, Total CP: ${totalCP}`);
    
    saveSettings();
}

// ============================================
// EVENT HANDLERS - v7's WORKING PATTERN!
// ============================================

function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    
    const context = SillyTavern.getContext();
    const message = context.chat?.[messageId]; // THIS IS THE FIX!
    
    if (message && !message.is_user) {
        incrementResponseCount();
        
        if (message.mes) {
            processAIMessage(message.mes);
        }
    }
}

function onChatChanged() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    
    settings.currentChatId = context.chatId || null;
    
    log(`📝 Chat changed to: ${settings.currentChatId}`);
    
    saveSettings();
    updateUI();
}

function onGenerationStarted() {
    const settings = getSettings();
    if (!settings.enabled) return;
    
    const context = SillyTavern.getContext();
    
    // Inject forge status for AI context
    const forgeStatus = generateForgeStatus();
    if (forgeStatus) {
        context.setExtensionPrompt(MODULE_NAME, forgeStatus, 0, 0);
        log('💉 Injected forge status');
    }
    
    // Also inject SimTracker JSON format
    if (settings.injectSimTracker) {
        const simJSON = generateSimTrackerJSON();
        context.setExtensionPrompt(MODULE_NAME + '_sim', simJSON, 0, 1);
    }
}

// ============================================
// CONTEXT INJECTION
// ============================================

function generateForgeStatus() {
    const state = getCurrentState();
    if (!state) return '';
    
    const totalCP = getTotalCP(state);
    const availableCP = getAvailableCP(state);
    
    let status = `\n=== CELESTIAL FORGE STATUS ===\n`;
    status += `Total CP: ${totalCP} | Available: ${availableCP} | Spent: ${state.spentCP}\n`;
    status += `Corruption: ${state.corruption}/100 | Sanity: ${state.sanityErosion}/100\n`;
    status += `Responses: ${state.responseCount}\n`;
    
    if (state.acquiredPerks.length > 0) {
        status += `\nACQUIRED PERKS (${state.acquiredPerks.length}):\n`;
        state.acquiredPerks.forEach(perk => {
            const activeIcon = perk.isToggleable ? (perk.isActive ? '🟢' : '🔴') : '⚪';
            const scalingInfo = perk.scaling ? 
                ` [Lv.${perk.scaling.level}${perk.scaling.uncapped ? '/∞' : `/${perk.scaling.maxLevel}`}, ${perk.scaling.xp}/${perk.scaling.xp_needed} XP]` : 
                '';
            status += `${activeIcon} ${perk.name} (${perk.cost} CP)${scalingInfo}\n`;
            if (perk.flags.length > 0) {
                status += `   [${perk.flags.join(', ')}]\n`;
            }
        });
    }
    
    if (state.pendingPerk) {
        status += `\nPENDING: ${state.pendingPerk.name} (need ${state.pendingPerkCost - availableCP} more CP)\n`;
    }
    
    status += `===============================\n`;
    
    return status;
}

function generateSimTrackerJSON() {
    const state = getCurrentState();
    if (!state) return '';
    
    const totalCP = getTotalCP(state);
    const availableCP = getAvailableCP(state);
    
    const jsonData = {
        characters: [{
            characterName: "Smith",
            currentDateTime: new Date().toLocaleString(),
            stats: {
                total_cp: totalCP,
                available_cp: availableCP,
                spent_cp: state.spentCP,
                corruption: state.corruption,
                sanity: state.sanityErosion,
                perk_count: state.acquiredPerks.length,
                perks: state.acquiredPerks.map(p => ({
                    name: p.name,
                    cost: p.cost,
                    flags: p.flags,
                    description: p.description,
                    toggleable: p.isToggleable,
                    active: p.isActive,
                    scaling: p.scaling ? {
                        level: p.scaling.level,
                        maxLevel: p.scaling.maxLevel === Infinity ? '∞' : p.scaling.maxLevel,
                        xp: p.scaling.xp,
                        xp_needed: p.scaling.xp_needed,
                        uncapped: p.scaling.uncapped
                    } : null
                }))
            }
        }]
    };
    
    return '```forge\n' + JSON.stringify(jsonData, null, 2) + '\n```';
}

// ============================================
// UI CREATION
// ============================================

function createSettingsHtml() {
    return `
    <div id="celestial-forge-settings" class="extension-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>⚒️ Celestial Forge Tracker v8.0</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                
                <div class="forge-section">
                    <h4>📊 Current Status</h4>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">
                        <div><b>Responses:</b> <span id="forge-responses">0</span></div>
                        <div><b>Total CP:</b> <span id="forge-total-cp">0</span></div>
                        <div><b>Available CP:</b> <span id="forge-available-cp">0</span></div>
                        <div><b>Perks:</b> <span id="forge-perk-count">0</span></div>
                    </div>
                    
                    <div style="margin-top:10px">
                        <label>Corruption: <span id="forge-corruption-val">0</span>/100</label>
                        <input type="range" id="forge-corruption" min="0" max="100" value="0" style="width:100%">
                    </div>
                    
                    <div style="margin-top:5px">
                        <label>Sanity Erosion: <span id="forge-sanity-val">0</span>/100</label>
                        <input type="range" id="forge-sanity" min="0" max="100" value="0" style="width:100%">
                    </div>
                </div>
                
                <div class="forge-section" style="margin-top:10px">
                    <h4>⚙️ Settings</h4>
                    <label class="checkbox_label">
                        <input type="checkbox" id="forge-enabled" checked>
                        <span>Enable Tracking</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="forge-auto-perks" checked>
                        <span>Auto-detect Perks</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="forge-auto-cp" checked>
                        <span>Auto-detect CP</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="forge-inject-simtracker" checked>
                        <span>Inject SimTracker JSON</span>
                    </label>
                    
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;font-size:12px">
                        <div>
                            <label>CP per Response:</label>
                            <input type="number" id="forge-cp-rate" value="10" min="1" style="width:100%">
                        </div>
                        <div>
                            <label>Threshold CP:</label>
                            <input type="number" id="forge-threshold" value="100" min="1" style="width:100%">
                        </div>
                    </div>
                </div>
                
                <div class="forge-section" style="margin-top:10px">
                    <h4>🎯 Actions</h4>
                    <div style="display:grid;grid-template-columns:1fr auto;gap:5px;margin-bottom:5px">
                        <input type="number" id="forge-bonus-input" placeholder="Bonus CP amount" style="width:100%">
                        <button id="forge-add-bonus" class="menu_button">Add CP</button>
                    </div>
                    <button id="forge-force-process" class="menu_button" style="width:100%;margin-bottom:5px">Force Process Last Message</button>
                    <button id="forge-reset" class="menu_button" style="width:100%">Reset State</button>
                </div>
                
                <div class="forge-section" style="margin-top:10px">
                    <h4>📜 Acquired Perks</h4>
                    <div id="forge-perk-list" style="max-height:300px;overflow-y:auto;border:1px solid var(--SmartThemeBorderColor);border-radius:4px;padding:5px"></div>
                </div>
                
            </div>
        </div>
    </div>
    `;
}

function updateUI() {
    const state = getCurrentState();
    const settings = getSettings();
    
    if (!state) return;
    
    const totalCP = getTotalCP(state);
    const availableCP = getAvailableCP(state);
    
    $('#forge-responses').text(state.responseCount);
    $('#forge-total-cp').text(totalCP);
    $('#forge-available-cp').text(availableCP);
    $('#forge-corruption').val(state.corruption);
    $('#forge-corruption-val').text(state.corruption);
    $('#forge-sanity').val(state.sanityErosion);
    $('#forge-sanity-val').text(state.sanityErosion);
    $('#forge-perk-count').text(state.acquiredPerks.length);
    
    // Settings
    $('#forge-enabled').prop('checked', settings.enabled);
    $('#forge-auto-perks').prop('checked', settings.autoDetectPerks);
    $('#forge-auto-cp').prop('checked', settings.autoDetectCP);
    $('#forge-inject-simtracker').prop('checked', settings.injectSimTracker);
    $('#forge-cp-rate').val(settings.cpPerResponse);
    $('#forge-threshold').val(settings.thresholdCP);
    
    updatePerkListUI();
}

function updatePerkListUI() {
    const state = getCurrentState();
    if (!state) return;
    
    const html = state.acquiredPerks.map(perk => {
        const toggleBtn = perk.isToggleable 
            ? `<button class="menu_button forge-toggle" data-id="${perk.id}" style="padding:2px 5px;font-size:10px">${perk.isActive ? '🟢' : '🔴'}</button>`
            : '';
        
        const scalingInfo = perk.scaling 
            ? `<div style="color:#2ecc71;font-size:10px;margin-top:2px">
                Level ${perk.scaling.level}${perk.scaling.uncapped ? '/∞' : `/${perk.scaling.maxLevel}`} | 
                ${perk.scaling.xp}/${perk.scaling.xp_needed} XP
               </div>`
            : '';
        
        return `<div style="padding:5px;margin:3px 0;border:1px solid var(--SmartThemeBorderColor);border-radius:3px;font-size:11px;background:rgba(233,69,96,0.1)">
            <strong>${perk.name}</strong> (${perk.cost}CP) ${toggleBtn}
            <button class="menu_button forge-remove-perk" data-id="${perk.id}" style="float:right;padding:2px 5px;font-size:10px">×</button>
            <div style="color:#888;font-size:10px">${perk.description || 'No description'}</div>
            <div style="color:#666;font-size:9px">[${perk.flags.join(', ') || 'No flags'}]</div>
            ${scalingInfo}
        </div>`;
    }).join('') || '<div style="color:#888;text-align:center;padding:10px">No perks yet</div>';
    
    $('#forge-perk-list').html(html);
    
    $('.forge-toggle').off('click').on('click', function() {
        togglePerk($(this).data('id'));
    });
    
    $('.forge-remove-perk').off('click').on('click', function() {
        if (confirm('Remove this perk?')) {
            removePerk($(this).data('id'));
        }
    });
}

function bindUIEvents() {
    $('#forge-enabled').on('change', function() {
        getSettings().enabled = $(this).prop('checked');
        saveSettings();
        log(`Tracking ${getSettings().enabled ? 'enabled' : 'disabled'}`);
    });
    
    $('#forge-auto-perks').on('change', function() {
        getSettings().autoDetectPerks = $(this).prop('checked');
        saveSettings();
    });
    
    $('#forge-auto-cp').on('change', function() {
        getSettings().autoDetectCP = $(this).prop('checked');
        saveSettings();
    });
    
    $('#forge-inject-simtracker').on('change', function() {
        getSettings().injectSimTracker = $(this).prop('checked');
        saveSettings();
    });
    
    $('#forge-cp-rate').on('change', function() {
        getSettings().cpPerResponse = parseInt($(this).val()) || 10;
        saveSettings();
        updateUI();
    });
    
    $('#forge-threshold').on('change', function() {
        getSettings().thresholdCP = parseInt($(this).val()) || 100;
        saveSettings();
    });
    
    $('#forge-corruption').on('input', function() {
        const state = getCurrentState();
        if (state) {
            state.corruption = parseInt($(this).val());
            $('#forge-corruption-val').text(state.corruption);
            saveSettings();
        }
    });
    
    $('#forge-sanity').on('input', function() {
        const state = getCurrentState();
        if (state) {
            state.sanityErosion = parseInt($(this).val());
            $('#forge-sanity-val').text(state.sanityErosion);
            saveSettings();
        }
    });
    
    $('#forge-add-bonus').on('click', function() {
        const amount = parseInt($('#forge-bonus-input').val());
        if (!isNaN(amount) && amount > 0) {
            const state = getCurrentState();
            if (state) {
                state.bonusCP = (state.bonusCP || 0) + amount;
                log(`💰 Added ${amount} bonus CP`);
                saveSettings();
                updateUI();
                $('#forge-bonus-input').val('');
            }
        }
    });
    
    $('#forge-force-process').on('click', function() {
        const context = SillyTavern.getContext();
        const lastMsg = context.chat?.filter(m => !m.is_user).pop();
        if (lastMsg?.mes) {
            log('🔄 Force processing last message...');
            processAIMessage(lastMsg.mes);
        }
    });
    
    $('#forge-reset').on('click', function() {
        if (confirm('Reset all Celestial Forge progress? This cannot be undone!')) {
            const state = getCurrentState();
            if (state) {
                Object.assign(state, defaultChatState);
                state.createdAt = Date.now();
                saveSettings();
                updateUI();
                log('🔄 State reset');
            }
        }
    });
}

// ============================================
// INITIALIZATION - v7's WORKING PATTERN!
// ============================================

jQuery(async () => {
    const context = SillyTavern.getContext();
    
    extensionSettings = context.extensionSettings;
    saveSettingsDebounced = context.saveSettingsDebounced;
    
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...defaultSettings };
        saveSettingsDebounced();
    }
    
    // Set current chat ID
    extensionSettings[MODULE_NAME].currentChatId = context.chatId || null;
    
    // Create UI
    $('#extensions_settings').append(createSettingsHtml());
    bindUIEvents();
    updateUI();
    
    // Register event handlers - v7's WORKING pattern!
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, onChatChanged);
    context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    context.eventSource.on(context.eventTypes.GENERATION_STARTED, onGenerationStarted);
    
    // Expose to console for debugging
    window.celestialForge = {
        getState: getCurrentState,
        getSettings: getSettings,
        processMessage: processAIMessage,
        addPerk: addPerk,
        addXP: addXPToPerk,
        setLevel: setPerkLevel
    };
    
    log('✅ Celestial Forge Tracker v8.0 loaded!');
    log('📝 Chat ID:', context.chatId);
});

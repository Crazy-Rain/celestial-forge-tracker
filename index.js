// Celestial Forge Tracker Extension v2.0 for SillyTavern
// Full-featured tracking with database, auto-detection, per-chat state, and more

import { extension_settings, getContext, saveSettingsDebounced } from "../../../extensions.js";
import { eventSource, event_types, saveSettings } from "../../../../script.js";

const extensionName = "celestial-forge-tracker";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// ============================================
// DEFAULT SETTINGS & STATE STRUCTURE
// ============================================

const defaultSettings = {
    enabled: true,
    autoDetectPerks: true,
    autoDetectCP: true,
    cpPerResponse: 10,
    thresholdCP: 100,
    showNotifications: true,
    
    // Global perk archive (persists across all chats)
    perkArchive: [],
    
    // Per-chat states (keyed by chat identifier)
    chatStates: {},
    
    // Current active chat ID
    currentChatId: null
};

// Default state for a new chat
const defaultChatState = {
    responseCount: 0,
    bonusCP: 0,
    spentCP: 0,
    corruption: 0,
    sanityErosion: 0,
    pendingPerk: null,
    pendingPerkCost: 0,
    acquiredPerks: [],  // Array of perk objects with toggle states
    activeToggles: [],  // Names of currently active toggleable perks
    lastThresholdTriggered: 0,
    checkpoints: [],    // For branch support - snapshots at key points
    createdAt: null,
    lastUpdated: null
};

// ============================================
// PERK & PATTERN DEFINITIONS
// ============================================

// Regex patterns for detecting perks in AI output
const PERK_PATTERNS = [
    // **PERK NAME** (XXX CP) - Description [FLAGS]
    /\*\*([A-Z][A-Z\s\-\']+)\*\*\s*\((\d+)\s*CP\)\s*[-–—:]\s*([^\[]+?)(?:\[([^\]]+)\])?/gi,
    
    // [ACQUIRED: PERK NAME - XXX CP]
    /\[ACQUIRED:\s*([A-Z][A-Z\s\-\']+)\s*[-–—]\s*(\d+)\s*CP\]/gi,
    
    // You gain **PERK NAME** (XXX CP)
    /(?:you\s+)?gain(?:ed|s)?\s+\*\*([A-Z][A-Z\s\-\']+)\*\*\s*\((\d+)\s*CP\)/gi,
    
    // PERK NAME (XXX CP) [FLAGS] - more flexible
    /^([A-Z][A-Z\s\-\']{3,})\s*\((\d+)\s*CP\)\s*(?:\[([^\]]+)\])?\s*[-–—:]/gim,
    
    // The Forge grants: PERK NAME
    /(?:forge\s+grants|acquired|unlocked|gained):\s*\*?\*?([A-Z][A-Z\s\-\']+)\*?\*?\s*\((\d+)\s*CP\)/gi
];

// Regex patterns for detecting CP gains
const CP_GAIN_PATTERNS = [
    // +XX Bonus CP / +XX CP
    /\+(\d+)\s*(?:Bonus\s*)?CP/gi,
    
    // Award: +XX CP
    /Award:\s*\+?(\d+)\s*(?:Bonus\s*)?CP/gi,
    
    // [FORGE RESONANCE - TYPE BONUS] ... +XX CP
    /\[FORGE\s+RESONANCE[^\]]*\].*?\+(\d+)\s*(?:Bonus\s*)?CP/gi,
    
    // gains XX CP / earned XX CP
    /(?:gains?|earned?|receives?|awarded?)\s+(\d+)\s*(?:Bonus\s*)?CP/gi
];

// Patterns for detecting corruption/sanity changes
const CORRUPTION_PATTERNS = [
    /\+(\d+)\s*Corruption/gi,
    /Corruption:\s*\+(\d+)/gi,
    /[-–—](\d+)\s*Corruption/gi  // Negative (reduction)
];

const SANITY_PATTERNS = [
    /\+(\d+)\s*Sanity\s*(?:Erosion|Cost)/gi,
    /Sanity\s*(?:Erosion|Cost):\s*\+(\d+)/gi
];

// Patterns for detecting toggle activation
const TOGGLE_PATTERNS = [
    /(?:activate|activates|activating|turn(?:s|ing)?\s+on|enable(?:s|d)?)\s+(?:your\s+)?(?:the\s+)?\*?\*?([A-Z][A-Za-z\s\-\']+)\*?\*?/gi,
    /(?:deactivate|deactivates|deactivating|turn(?:s|ing)?\s+off|disable(?:s|d)?)\s+(?:your\s+)?(?:the\s+)?\*?\*?([A-Z][A-Za-z\s\-\']+)\*?\*?/gi,
    /\*?\*?([A-Z][A-Za-z\s\-\']+)\*?\*?\s+(?:flickers\s+)?(?:to\s+life|awakens?|activates?|engages?)/gi,
    /\*?\*?([A-Z][A-Za-z\s\-\']+)\*?\*?\s+(?:fades?|recedes?|deactivates?|disengages?)/gi
];

// ============================================
// CORE FUNCTIONS
// ============================================

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }
    
    // Ensure all default properties exist (for upgrades)
    for (const key in defaultSettings) {
        if (!(key in extension_settings[extensionName])) {
            extension_settings[extensionName][key] = defaultSettings[key];
        }
    }
    
    updateCurrentChat();
    updateUI();
}

function getSettings() {
    return extension_settings[extensionName];
}

function getCurrentChatId() {
    const context = getContext();
    if (!context.chatId) return null;
    
    // Create a unique identifier that includes character and chat
    const charName = context.characters[context.characterId]?.name || 'unknown';
    return `${charName}_${context.chatId}`;
}

function getCurrentState() {
    const settings = getSettings();
    const chatId = getCurrentChatId();
    
    if (!chatId) return null;
    
    if (!settings.chatStates[chatId]) {
        settings.chatStates[chatId] = {
            ...JSON.parse(JSON.stringify(defaultChatState)),
            createdAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString()
        };
        saveSettingsDebounced();
    }
    
    return settings.chatStates[chatId];
}

function updateCurrentChat() {
    const settings = getSettings();
    const chatId = getCurrentChatId();
    settings.currentChatId = chatId;
}

function getTotalCP(state = null) {
    state = state || getCurrentState();
    if (!state) return 0;
    
    const settings = getSettings();
    const baseCP = state.responseCount * settings.cpPerResponse;
    return baseCP + state.bonusCP - state.spentCP;
}

function getAvailableCP(state = null) {
    // CP available for spending (total minus what's been spent on perks)
    state = state || getCurrentState();
    if (!state) return 0;
    
    const settings = getSettings();
    const baseCP = state.responseCount * settings.cpPerResponse;
    return baseCP + state.bonusCP - state.spentCP;
}

// ============================================
// PERK MANAGEMENT
// ============================================

function addPerk(name, cost, description, flags = [], source = 'generated') {
    const state = getCurrentState();
    const settings = getSettings();
    if (!state) return false;
    
    const perk = {
        id: `perk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: name.trim(),
        cost: parseInt(cost) || 0,
        description: description.trim(),
        flags: Array.isArray(flags) ? flags : flags.split(',').map(f => f.trim()).filter(f => f),
        isToggleable: false,
        isActive: false,
        acquiredAt: state.responseCount,
        acquiredDate: new Date().toISOString(),
        source: source  // 'generated', 'archive', 'manual'
    };
    
    // Check if toggleable
    perk.isToggleable = perk.flags.some(f => 
        f.toUpperCase().includes('TOGGLEABLE') || 
        f.toUpperCase().includes('TOGGLE')
    );
    
    // Default toggleable perks to active
    if (perk.isToggleable) {
        perk.isActive = true;
        if (!state.activeToggles.includes(perk.name)) {
            state.activeToggles.push(perk.name);
        }
    }
    
    // Add to current chat's perks
    state.acquiredPerks.push(perk);
    state.spentCP += perk.cost;
    state.lastUpdated = new Date().toISOString();
    
    // Add to global archive if not already there
    const existingInArchive = settings.perkArchive.find(p => 
        p.name.toLowerCase() === perk.name.toLowerCase()
    );
    if (!existingInArchive) {
        settings.perkArchive.push({
            ...perk,
            timesAcquired: 1,
            firstAcquired: new Date().toISOString()
        });
    } else {
        existingInArchive.timesAcquired = (existingInArchive.timesAcquired || 1) + 1;
    }
    
    saveSettingsDebounced();
    updateUI();
    
    if (settings.showNotifications) {
        toastr.success(`Acquired: ${perk.name} (${perk.cost} CP)`, 'Celestial Forge');
    }
    
    return perk;
}

function removePerk(perkId) {
    const state = getCurrentState();
    if (!state) return false;
    
    const index = state.acquiredPerks.findIndex(p => p.id === perkId);
    if (index > -1) {
        const perk = state.acquiredPerks[index];
        state.spentCP -= perk.cost;
        
        // Remove from active toggles if present
        const toggleIndex = state.activeToggles.indexOf(perk.name);
        if (toggleIndex > -1) {
            state.activeToggles.splice(toggleIndex, 1);
        }
        
        state.acquiredPerks.splice(index, 1);
        state.lastUpdated = new Date().toISOString();
        saveSettingsDebounced();
        updateUI();
        return true;
    }
    return false;
}

function togglePerk(perkId) {
    const state = getCurrentState();
    if (!state) return false;
    
    const perk = state.acquiredPerks.find(p => p.id === perkId);
    if (perk && perk.isToggleable) {
        perk.isActive = !perk.isActive;
        
        if (perk.isActive) {
            if (!state.activeToggles.includes(perk.name)) {
                state.activeToggles.push(perk.name);
            }
        } else {
            const index = state.activeToggles.indexOf(perk.name);
            if (index > -1) {
                state.activeToggles.splice(index, 1);
            }
        }
        
        state.lastUpdated = new Date().toISOString();
        saveSettingsDebounced();
        updateUI();
        return true;
    }
    return false;
}

function togglePerkByName(perkName, forceState = null) {
    const state = getCurrentState();
    if (!state) return false;
    
    const perk = state.acquiredPerks.find(p => 
        p.name.toLowerCase() === perkName.toLowerCase() && p.isToggleable
    );
    
    if (perk) {
        if (forceState !== null) {
            perk.isActive = forceState;
        } else {
            perk.isActive = !perk.isActive;
        }
        
        // Update activeToggles list
        const toggleIndex = state.activeToggles.indexOf(perk.name);
        if (perk.isActive && toggleIndex === -1) {
            state.activeToggles.push(perk.name);
        } else if (!perk.isActive && toggleIndex > -1) {
            state.activeToggles.splice(toggleIndex, 1);
        }
        
        state.lastUpdated = new Date().toISOString();
        saveSettingsDebounced();
        updateUI();
        return true;
    }
    return false;
}

// ============================================
// CP & TRACKER MANAGEMENT
// ============================================

function addBonusCP(amount, reason = '') {
    const state = getCurrentState();
    const settings = getSettings();
    if (!state) return;
    
    amount = parseInt(amount) || 0;
    state.bonusCP += amount;
    state.lastUpdated = new Date().toISOString();
    saveSettingsDebounced();
    updateUI();
    
    if (settings.showNotifications && amount !== 0) {
        const sign = amount > 0 ? '+' : '';
        toastr.info(`${sign}${amount} CP${reason ? ` (${reason})` : ''}`, 'Celestial Forge');
    }
    
    checkThreshold();
}

function setCP(totalCP) {
    const state = getCurrentState();
    const settings = getSettings();
    if (!state) return;
    
    // Calculate what bonus CP should be to achieve desired total
    const baseCP = state.responseCount * settings.cpPerResponse;
    const neededBonus = totalCP - baseCP + state.spentCP;
    
    state.bonusCP = Math.max(0, neededBonus);
    state.lastUpdated = new Date().toISOString();
    saveSettingsDebounced();
    updateUI();
}

function modifyCorruption(amount) {
    const state = getCurrentState();
    const settings = getSettings();
    if (!state) return;
    
    const oldValue = state.corruption;
    state.corruption = Math.max(0, Math.min(100, state.corruption + amount));
    state.lastUpdated = new Date().toISOString();
    saveSettingsDebounced();
    updateUI();
    
    if (settings.showNotifications && amount !== 0) {
        const sign = amount > 0 ? '+' : '';
        toastr.warning(`Corruption: ${sign}${amount} (now ${state.corruption}/100)`, 'Celestial Forge');
    }
}

function modifySanity(amount) {
    const state = getCurrentState();
    const settings = getSettings();
    if (!state) return;
    
    state.sanityErosion = Math.max(0, Math.min(100, state.sanityErosion + amount));
    state.lastUpdated = new Date().toISOString();
    saveSettingsDebounced();
    updateUI();
    
    if (settings.showNotifications && amount !== 0) {
        const sign = amount > 0 ? '+' : '';
        toastr.warning(`Sanity Erosion: ${sign}${amount} (now ${state.sanityErosion}/100)`, 'Celestial Forge');
    }
}

function setPendingPerk(name, cost) {
    const state = getCurrentState();
    if (!state) return;
    
    state.pendingPerk = name;
    state.pendingPerkCost = parseInt(cost) || 0;
    state.lastUpdated = new Date().toISOString();
    saveSettingsDebounced();
    updateUI();
}

function clearPendingPerk() {
    const state = getCurrentState();
    if (!state) return;
    
    state.pendingPerk = null;
    state.pendingPerkCost = 0;
    state.lastUpdated = new Date().toISOString();
    saveSettingsDebounced();
    updateUI();
}

function incrementResponseCount() {
    const state = getCurrentState();
    if (!state) return;
    
    state.responseCount++;
    state.lastUpdated = new Date().toISOString();
    saveSettingsDebounced();
    updateUI();
    checkThreshold();
}

function setResponseCount(count) {
    const state = getCurrentState();
    if (!state) return;
    
    state.responseCount = Math.max(0, parseInt(count) || 0);
    state.lastUpdated = new Date().toISOString();
    saveSettingsDebounced();
    updateUI();
}

// ============================================
// THRESHOLD & ROLL SYSTEM
// ============================================

function checkThreshold() {
    const state = getCurrentState();
    const settings = getSettings();
    if (!state) return false;
    
    const totalCP = getTotalCP(state);
    const currentThresholds = Math.floor(totalCP / settings.thresholdCP);
    
    if (currentThresholds > state.lastThresholdTriggered) {
        state.lastThresholdTriggered = currentThresholds;
        state.lastUpdated = new Date().toISOString();
        saveSettingsDebounced();
        
        if (settings.showNotifications) {
            toastr.info(
                `The Celestial Forge resonates... (${settings.thresholdCP} CP threshold reached!)`, 
                'Forge Resonance',
                { timeOut: 5000 }
            );
        }
        
        return true;
    }
    return false;
}

function triggerManualRoll() {
    const state = getCurrentState();
    const settings = getSettings();
    if (!state) return;
    
    const availableCP = getAvailableCP(state);
    
    // Inject a roll trigger into the next message
    const rollPrompt = `\n\n[CELESTIAL FORGE - MANUAL ROLL TRIGGERED]
The Smith calls upon the Forge. Available CP: ${availableCP}
Roll a constellation and generate an appropriate perk. Follow the generation guidelines.
If the rolled perk costs more than available CP, set it as PENDING.
[END FORGE TRIGGER]\n`;
    
    // Store for injection
    state._pendingRollTrigger = rollPrompt;
    saveSettingsDebounced();
    
    toastr.info('Roll triggered! Send your next message to activate.', 'Celestial Forge');
}

// ============================================
// AUTO-DETECTION FUNCTIONS
// ============================================

function parseMessageForPerks(messageText) {
    const detectedPerks = [];
    
    for (const pattern of PERK_PATTERNS) {
        // Reset lastIndex for global patterns
        pattern.lastIndex = 0;
        
        let match;
        while ((match = pattern.exec(messageText)) !== null) {
            const perkData = {
                name: match[1]?.trim(),
                cost: parseInt(match[2]) || 0,
                description: match[3]?.trim() || '',
                flags: match[4]?.split(',').map(f => f.trim()).filter(f => f) || []
            };
            
            // Validate it looks like a real perk
            if (perkData.name && 
                perkData.name.length > 2 && 
                perkData.name.length < 100 &&
                perkData.cost >= 0 &&
                perkData.cost <= 2000) {
                
                // Avoid duplicates in this parse
                if (!detectedPerks.find(p => p.name.toLowerCase() === perkData.name.toLowerCase())) {
                    detectedPerks.push(perkData);
                }
            }
        }
    }
    
    return detectedPerks;
}

function parseMessageForCPGains(messageText) {
    let totalGain = 0;
    
    for (const pattern of CP_GAIN_PATTERNS) {
        pattern.lastIndex = 0;
        
        let match;
        while ((match = pattern.exec(messageText)) !== null) {
            const amount = parseInt(match[1]) || 0;
            if (amount > 0 && amount <= 500) {  // Sanity check
                totalGain += amount;
            }
        }
    }
    
    return totalGain;
}

function parseMessageForCorruption(messageText) {
    let change = 0;
    
    for (const pattern of CORRUPTION_PATTERNS) {
        pattern.lastIndex = 0;
        
        let match;
        while ((match = pattern.exec(messageText)) !== null) {
            const amount = parseInt(match[1]) || 0;
            // Check if it's a reduction (negative pattern has dash)
            if (pattern.source.includes('[-–—]')) {
                change -= amount;
            } else {
                change += amount;
            }
        }
    }
    
    return change;
}

function parseMessageForSanity(messageText) {
    let change = 0;
    
    for (const pattern of SANITY_PATTERNS) {
        pattern.lastIndex = 0;
        
        let match;
        while ((match = pattern.exec(messageText)) !== null) {
            change += parseInt(match[1]) || 0;
        }
    }
    
    return change;
}

function parseMessageForToggles(messageText) {
    const toggleChanges = [];
    
    // Check activation patterns (first two patterns)
    const activatePattern = TOGGLE_PATTERNS[0];
    const deactivatePattern = TOGGLE_PATTERNS[1];
    const activateAlt = TOGGLE_PATTERNS[2];
    const deactivateAlt = TOGGLE_PATTERNS[3];
    
    for (const pattern of [activatePattern, activateAlt]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(messageText)) !== null) {
            toggleChanges.push({ name: match[1]?.trim(), active: true });
        }
    }
    
    for (const pattern of [deactivatePattern, deactivateAlt]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(messageText)) !== null) {
            toggleChanges.push({ name: match[1]?.trim(), active: false });
        }
    }
    
    return toggleChanges;
}

function processAIMessage(messageText) {
    const settings = getSettings();
    const state = getCurrentState();
    if (!state || !settings.enabled) return;
    
    // Auto-detect perks
    if (settings.autoDetectPerks) {
        const detectedPerks = parseMessageForPerks(messageText);
        for (const perkData of detectedPerks) {
            // Check if we already have this perk in current chat
            const existing = state.acquiredPerks.find(p => 
                p.name.toLowerCase() === perkData.name.toLowerCase()
            );
            
            if (!existing) {
                addPerk(perkData.name, perkData.cost, perkData.description, perkData.flags, 'auto-detected');
            }
        }
    }
    
    // Auto-detect CP gains
    if (settings.autoDetectCP) {
        const cpGain = parseMessageForCPGains(messageText);
        if (cpGain > 0) {
            addBonusCP(cpGain, 'auto-detected');
        }
        
        // Corruption changes
        const corruptionChange = parseMessageForCorruption(messageText);
        if (corruptionChange !== 0) {
            modifyCorruption(corruptionChange);
        }
        
        // Sanity changes
        const sanityChange = parseMessageForSanity(messageText);
        if (sanityChange !== 0) {
            modifySanity(sanityChange);
        }
    }
    
    // Toggle detection
    const toggleChanges = parseMessageForToggles(messageText);
    for (const toggle of toggleChanges) {
        togglePerkByName(toggle.name, toggle.active);
    }
}

// ============================================
// CHECKPOINT & BRANCH SUPPORT
// ============================================

function createCheckpoint(label = '') {
    const state = getCurrentState();
    if (!state) return null;
    
    const checkpoint = {
        id: `checkpoint_${Date.now()}`,
        label: label || `Checkpoint at response ${state.responseCount}`,
        createdAt: new Date().toISOString(),
        state: JSON.parse(JSON.stringify({
            responseCount: state.responseCount,
            bonusCP: state.bonusCP,
            spentCP: state.spentCP,
            corruption: state.corruption,
            sanityErosion: state.sanityErosion,
            pendingPerk: state.pendingPerk,
            pendingPerkCost: state.pendingPerkCost,
            acquiredPerks: state.acquiredPerks,
            activeToggles: state.activeToggles,
            lastThresholdTriggered: state.lastThresholdTriggered
        }))
    };
    
    state.checkpoints.push(checkpoint);
    
    // Keep only last 10 checkpoints
    if (state.checkpoints.length > 10) {
        state.checkpoints.shift();
    }
    
    saveSettingsDebounced();
    updateUI();
    
    toastr.success(`Checkpoint created: ${checkpoint.label}`, 'Celestial Forge');
    return checkpoint;
}

function restoreCheckpoint(checkpointId) {
    const state = getCurrentState();
    if (!state) return false;
    
    const checkpoint = state.checkpoints.find(c => c.id === checkpointId);
    if (!checkpoint) return false;
    
    // Restore state from checkpoint
    Object.assign(state, checkpoint.state);
    state.lastUpdated = new Date().toISOString();
    
    saveSettingsDebounced();
    updateUI();
    
    toastr.info(`Restored to: ${checkpoint.label}`, 'Celestial Forge');
    return true;
}

function deleteCheckpoint(checkpointId) {
    const state = getCurrentState();
    if (!state) return false;
    
    const index = state.checkpoints.findIndex(c => c.id === checkpointId);
    if (index > -1) {
        state.checkpoints.splice(index, 1);
        saveSettingsDebounced();
        updateUI();
        return true;
    }
    return false;
}

// ============================================
// ARCHIVE FUNCTIONS
// ============================================

function getArchive() {
    return getSettings().perkArchive || [];
}

function searchArchive(query) {
    const archive = getArchive();
    const lowerQuery = query.toLowerCase();
    
    return archive.filter(perk => 
        perk.name.toLowerCase().includes(lowerQuery) ||
        perk.description.toLowerCase().includes(lowerQuery) ||
        perk.flags.some(f => f.toLowerCase().includes(lowerQuery))
    );
}

function acquireFromArchive(archivePerkId) {
    const settings = getSettings();
    const archivePerk = settings.perkArchive.find(p => p.id === archivePerkId);
    
    if (archivePerk) {
        return addPerk(
            archivePerk.name,
            archivePerk.cost,
            archivePerk.description,
            archivePerk.flags,
            'archive'
        );
    }
    return null;
}

function deleteFromArchive(archivePerkId) {
    const settings = getSettings();
    const index = settings.perkArchive.findIndex(p => p.id === archivePerkId);
    
    if (index > -1) {
        settings.perkArchive.splice(index, 1);
        saveSettingsDebounced();
        updateUI();
        return true;
    }
    return false;
}

function clearArchive() {
    const settings = getSettings();
    settings.perkArchive = [];
    saveSettingsDebounced();
    updateUI();
}

// ============================================
// PROMPT INJECTION
// ============================================

function generateForgeStatus() {
    const state = getCurrentState();
    const settings = getSettings();
    if (!state) return '';
    
    const totalCP = getTotalCP(state);
    const availableCP = getAvailableCP(state);
    const thresholdProgress = totalCP % settings.thresholdCP;
    
    // Build perk list with toggle states
    let perkList = "None yet - the Forge awaits its first resonance.";
    if (state.acquiredPerks.length > 0) {
        perkList = state.acquiredPerks.map((perk, index) => {
            let toggleStatus = '';
            if (perk.isToggleable) {
                toggleStatus = perk.isActive ? ' [ACTIVE]' : ' [INACTIVE]';
            }
            return `${index + 1}. ${perk.name} (${perk.cost} CP)${toggleStatus} - ${perk.description} [${perk.flags.join(', ')}]`;
        }).join('\n');
    }
    
    // Active toggles list
    let toggleList = "None active";
    if (state.activeToggles.length > 0) {
        toggleList = state.activeToggles.join(', ');
    }
    
    // Pending perk
    let pendingText = "None";
    if (state.pendingPerk) {
        const remaining = state.pendingPerkCost - availableCP;
        pendingText = remaining > 0 
            ? `${state.pendingPerk} (${state.pendingPerkCost} CP) - ${remaining} CP remaining to manifest`
            : `${state.pendingPerk} (${state.pendingPerkCost} CP) - READY TO MANIFEST!`;
    }
    
    // Corruption/Sanity warnings
    let warnings = '';
    if (state.corruption >= 75) {
        warnings += '\n[WARNING: High corruption - dark aesthetics intensifying]';
    } else if (state.corruption >= 50) {
        warnings += '\n[Note: Moderate corruption - Dark Forge resonance strengthening]';
    }
    if (state.sanityErosion >= 75) {
        warnings += '\n[WARNING: High sanity erosion - reality perception shifting]';
    } else if (state.sanityErosion >= 50) {
        warnings += '\n[Note: Moderate sanity erosion - Eldritch insights accumulating]';
    }
    
    let status = `[CELESTIAL FORGE - CURRENT STATUS]
Response Count: ${state.responseCount}
Total CP Earned: ${totalCP} | Available: ${availableCP}
(Base: ${state.responseCount * settings.cpPerResponse} + Bonus: ${state.bonusCP} - Spent: ${state.spentCP})
Threshold Progress: ${thresholdProgress}/${settings.thresholdCP} CP until next resonance

Corruption Level: ${state.corruption}/100
Sanity Erosion: ${state.sanityErosion}/100${warnings}

Pending Perk: ${pendingText}
Currently Active Toggles: ${toggleList}

ACQUIRED PERKS (${state.acquiredPerks.length}):
${perkList}

[The Forge tracks all. When generating perks, use format: **PERK NAME** (XXX CP) - Description [FLAGS] for auto-detection.]`;

    // Add pending roll trigger if set
    if (state._pendingRollTrigger) {
        status += state._pendingRollTrigger;
        state._pendingRollTrigger = null;
        saveSettingsDebounced();
    }
    
    return status;
}

// ============================================
// EVENT HOOKS
// ============================================

function onChatChanged() {
    updateCurrentChat();
    updateUI();
}

function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    
    const context = getContext();
    const message = context.chat[messageId];
    
    // Only process assistant messages
    if (message && !message.is_user) {
        // Increment response count
        incrementResponseCount();
        
        // Process message content for auto-detection
        if (message.mes) {
            processAIMessage(message.mes);
        }
    }
}

function onPromptReady(eventData) {
    const settings = getSettings();
    if (!settings.enabled) return;
    
    const forgeStatus = generateForgeStatus();
    
    // Inject as system-level context
    if (eventData && forgeStatus) {
        // Try different injection points based on ST version
        if (typeof eventData === 'object') {
            if (eventData.prompt !== undefined) {
                eventData.prompt = forgeStatus + "\n\n" + eventData.prompt;
            }
        }
    }
}

// ============================================
// UI CREATION
// ============================================

function createUI() {
    const html = `
    <div id="celestial-forge-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>⚒️ Celestial Forge Tracker</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                
                <!-- Tab Navigation -->
                <div class="forge-tabs">
                    <button class="forge-tab active" data-tab="status">Status</button>
                    <button class="forge-tab" data-tab="perks">Perks</button>
                    <button class="forge-tab" data-tab="archive">Archive</button>
                    <button class="forge-tab" data-tab="checkpoints">Checkpoints</button>
                    <button class="forge-tab" data-tab="settings">Settings</button>
                </div>
                
                <!-- Status Tab -->
                <div class="forge-tab-content active" data-tab="status">
                    <div class="forge-panel">
                        <h4>📊 Current Status</h4>
                        
                        <div class="forge-stat-row">
                            <label>Responses:</label>
                            <span id="forge-responses">0</span>
                            <button class="menu_button forge-btn-small" id="forge-dec-response">-</button>
                            <button class="menu_button forge-btn-small" id="forge-inc-response">+</button>
                            <input type="number" id="forge-set-response" class="forge-input-small" placeholder="Set">
                            <button class="menu_button forge-btn-small" id="forge-apply-response">Set</button>
                        </div>
                        
                        <div class="forge-stat-row">
                            <label>Total CP:</label>
                            <span id="forge-total-cp" class="forge-highlight">0</span>
                            <label>Available:</label>
                            <span id="forge-available-cp" class="forge-highlight">0</span>
                        </div>
                        
                        <div class="forge-stat-row">
                            <label>Set Total CP:</label>
                            <input type="number" id="forge-set-cp" class="forge-input-medium" placeholder="Enter CP">
                            <button class="menu_button" id="forge-apply-cp">Apply</button>
                        </div>
                        
                        <div class="forge-stat-row">
                            <label>Add Bonus CP:</label>
                            <input type="number" id="forge-add-bonus" class="forge-input-small" placeholder="+/-">
                            <button class="menu_button" id="forge-apply-bonus">Add</button>
                        </div>
                        
                        <div class="forge-stat-row">
                            <label>Corruption:</label>
                            <input type="range" id="forge-corruption" min="0" max="100" value="0">
                            <span id="forge-corruption-val">0</span>/100
                            <input type="number" id="forge-corruption-add" class="forge-input-tiny" placeholder="+/-">
                            <button class="menu_button forge-btn-small" id="forge-apply-corruption">±</button>
                        </div>
                        
                        <div class="forge-stat-row">
                            <label>Sanity Erosion:</label>
                            <input type="range" id="forge-sanity" min="0" max="100" value="0">
                            <span id="forge-sanity-val">0</span>/100
                            <input type="number" id="forge-sanity-add" class="forge-input-tiny" placeholder="+/-">
                            <button class="menu_button forge-btn-small" id="forge-apply-sanity">±</button>
                        </div>
                        
                        <div class="forge-stat-row">
                            <label>Threshold Progress:</label>
                            <div class="forge-progress-bar">
                                <div class="forge-progress-fill" id="forge-threshold-bar"></div>
                            </div>
                            <span id="forge-threshold-text">0/100</span>
                        </div>
                        
                        <div class="forge-actions">
                            <button class="menu_button forge-btn-primary" id="forge-roll-btn">⚡ Trigger Roll</button>
                            <button class="menu_button" id="forge-checkpoint-btn">📌 Create Checkpoint</button>
                        </div>
                    </div>
                    
                    <div class="forge-panel">
                        <h4>⏳ Pending Perk</h4>
                        <div id="forge-pending-display">None</div>
                        <div class="forge-stat-row">
                            <input type="text" id="forge-pending-name" placeholder="Perk name" class="forge-input-wide">
                            <input type="number" id="forge-pending-cost" placeholder="Cost" class="forge-input-small">
                        </div>
                        <div class="forge-actions">
                            <button class="menu_button" id="forge-set-pending">Set Pending</button>
                            <button class="menu_button" id="forge-clear-pending">Clear</button>
                            <button class="menu_button" id="forge-acquire-pending">Acquire Now</button>
                        </div>
                    </div>
                </div>
                
                <!-- Perks Tab -->
                <div class="forge-tab-content" data-tab="perks">
                    <div class="forge-panel">
                        <h4>✨ Acquired Perks (<span id="forge-perk-count">0</span>)</h4>
                        <div id="forge-perk-list" class="forge-scrollable"></div>
                    </div>
                    
                    <div class="forge-panel">
                        <h4>➕ Add Perk Manually</h4>
                        <div class="forge-add-perk-form">
                            <input type="text" id="forge-new-perk-name" placeholder="Perk Name" class="forge-input-wide">
                            <input type="number" id="forge-new-perk-cost" placeholder="Cost" class="forge-input-small">
                            <textarea id="forge-new-perk-desc" placeholder="Description" class="forge-textarea"></textarea>
                            <input type="text" id="forge-new-perk-flags" placeholder="Flags (comma-separated: TOGGLEABLE, PASSIVE, etc.)">
                            <button class="menu_button forge-btn-primary" id="forge-add-perk-btn">Add Perk</button>
                        </div>
                    </div>
                    
                    <div class="forge-panel">
                        <h4>🔘 Active Toggles</h4>
                        <div id="forge-active-toggles">None</div>
                    </div>
                </div>
                
                <!-- Archive Tab -->
                <div class="forge-tab-content" data-tab="archive">
                    <div class="forge-panel">
                        <h4>📚 Perk Archive (<span id="forge-archive-count">0</span>)</h4>
                        <p class="forge-hint">All perks ever generated across all chats. Click to re-acquire.</p>
                        <input type="text" id="forge-archive-search" placeholder="Search archive..." class="forge-input-wide">
                        <div id="forge-archive-list" class="forge-scrollable forge-archive-grid"></div>
                        <div class="forge-actions">
                            <button class="menu_button" id="forge-clear-archive">Clear Archive</button>
                            <button class="menu_button" id="forge-export-archive">Export Archive</button>
                            <button class="menu_button" id="forge-import-archive">Import Archive</button>
                        </div>
                    </div>
                </div>
                
                <!-- Checkpoints Tab -->
                <div class="forge-tab-content" data-tab="checkpoints">
                    <div class="forge-panel">
                        <h4>📌 Checkpoints</h4>
                        <p class="forge-hint">Save points for branching chats. Restore to return to a previous state.</p>
                        <div class="forge-stat-row">
                            <input type="text" id="forge-checkpoint-label" placeholder="Checkpoint label" class="forge-input-wide">
                            <button class="menu_button" id="forge-create-checkpoint">Create</button>
                        </div>
                        <div id="forge-checkpoint-list" class="forge-scrollable"></div>
                    </div>
                </div>
                
                <!-- Settings Tab -->
                <div class="forge-tab-content" data-tab="settings">
                    <div class="forge-panel">
                        <h4>⚙️ Extension Settings</h4>
                        
                        <label class="forge-checkbox-label">
                            <input type="checkbox" id="forge-enabled" checked>
                            Enable Forge Tracking
                        </label>
                        
                        <label class="forge-checkbox-label">
                            <input type="checkbox" id="forge-auto-perks" checked>
                            Auto-detect perks from AI messages
                        </label>
                        
                        <label class="forge-checkbox-label">
                            <input type="checkbox" id="forge-auto-cp" checked>
                            Auto-detect CP gains from AI messages
                        </label>
                        
                        <label class="forge-checkbox-label">
                            <input type="checkbox" id="forge-notifications" checked>
                            Show notifications
                        </label>
                        
                        <div class="forge-stat-row">
                            <label>CP per response:</label>
                            <input type="number" id="forge-cp-rate" value="10" min="1" class="forge-input-small">
                        </div>
                        
                        <div class="forge-stat-row">
                            <label>Threshold CP:</label>
                            <input type="number" id="forge-threshold" value="100" min="10" class="forge-input-small">
                        </div>
                    </div>
                    
                    <div class="forge-panel">
                        <h4>💾 Data Management</h4>
                        <div class="forge-actions">
                            <button class="menu_button" id="forge-export-state">Export Current State</button>
                            <button class="menu_button" id="forge-import-state">Import State</button>
                            <button class="menu_button forge-btn-danger" id="forge-reset-chat">Reset This Chat</button>
                            <button class="menu_button forge-btn-danger" id="forge-reset-all">Reset Everything</button>
                        </div>
                    </div>
                    
                    <div class="forge-panel">
                        <h4>📋 Current Chat ID</h4>
                        <div id="forge-chat-id" class="forge-code">Not loaded</div>
                    </div>
                </div>
                
            </div>
        </div>
    </div>`;
    
    $('#extensions_settings').append(html);
    bindUIEvents();
}

function bindUIEvents() {
    // Tab switching
    $('.forge-tab').on('click', function() {
        const tab = $(this).data('tab');
        $('.forge-tab').removeClass('active');
        $(this).addClass('active');
        $('.forge-tab-content').removeClass('active');
        $(`.forge-tab-content[data-tab="${tab}"]`).addClass('active');
    });
    
    // Response count controls
    $('#forge-inc-response').on('click', () => incrementResponseCount());
    $('#forge-dec-response').on('click', () => {
        const state = getCurrentState();
        if (state) {
            state.responseCount = Math.max(0, state.responseCount - 1);
            saveSettingsDebounced();
            updateUI();
        }
    });
    $('#forge-apply-response').on('click', () => {
        setResponseCount($('#forge-set-response').val());
        $('#forge-set-response').val('');
    });
    
    // CP controls
    $('#forge-apply-cp').on('click', () => {
        setCP(parseInt($('#forge-set-cp').val()) || 0);
        $('#forge-set-cp').val('');
    });
    $('#forge-apply-bonus').on('click', () => {
        addBonusCP(parseInt($('#forge-add-bonus').val()) || 0, 'manual');
        $('#forge-add-bonus').val('');
    });
    
    // Corruption/Sanity sliders
    $('#forge-corruption').on('input', function() {
        const state = getCurrentState();
        if (state) {
            state.corruption = parseInt($(this).val());
            $('#forge-corruption-val').text($(this).val());
            saveSettingsDebounced();
        }
    });
    $('#forge-apply-corruption').on('click', () => {
        modifyCorruption(parseInt($('#forge-corruption-add').val()) || 0);
        $('#forge-corruption-add').val('');
    });
    
    $('#forge-sanity').on('input', function() {
        const state = getCurrentState();
        if (state) {
            state.sanityErosion = parseInt($(this).val());
            $('#forge-sanity-val').text($(this).val());
            saveSettingsDebounced();
        }
    });
    $('#forge-apply-sanity').on('click', () => {
        modifySanity(parseInt($('#forge-sanity-add').val()) || 0);
        $('#forge-sanity-add').val('');
    });
    
    // Roll trigger
    $('#forge-roll-btn').on('click', triggerManualRoll);
    
    // Checkpoints
    $('#forge-checkpoint-btn, #forge-create-checkpoint').on('click', () => {
        createCheckpoint($('#forge-checkpoint-label').val());
        $('#forge-checkpoint-label').val('');
    });
    
    // Pending perk
    $('#forge-set-pending').on('click', () => {
        setPendingPerk($('#forge-pending-name').val(), $('#forge-pending-cost').val());
    });
    $('#forge-clear-pending').on('click', clearPendingPerk);
    $('#forge-acquire-pending').on('click', () => {
        const state = getCurrentState();
        if (state && state.pendingPerk) {
            addPerk(state.pendingPerk, state.pendingPerkCost, 'Acquired from pending', [], 'pending');
            clearPendingPerk();
        }
    });
    
    // Add perk
    $('#forge-add-perk-btn').on('click', () => {
        const name = $('#forge-new-perk-name').val();
        const cost = $('#forge-new-perk-cost').val();
        const desc = $('#forge-new-perk-desc').val();
        const flags = $('#forge-new-perk-flags').val();
        
        if (name) {
            addPerk(name, cost, desc, flags, 'manual');
            $('#forge-new-perk-name').val('');
            $('#forge-new-perk-cost').val('');
            $('#forge-new-perk-desc').val('');
            $('#forge-new-perk-flags').val('');
        }
    });
    
    // Archive search
    $('#forge-archive-search').on('input', function() {
        updateArchiveUI($(this).val());
    });
    
    // Archive actions
    $('#forge-clear-archive').on('click', () => {
        if (confirm('Clear entire perk archive? This cannot be undone.')) {
            clearArchive();
        }
    });
    
    $('#forge-export-archive').on('click', () => {
        const archive = getArchive();
        downloadJSON(archive, 'celestial-forge-archive.json');
    });
    
    $('#forge-import-archive').on('click', () => {
        uploadJSON((data) => {
            if (Array.isArray(data)) {
                const settings = getSettings();
                settings.perkArchive = data;
                saveSettingsDebounced();
                updateUI();
                toastr.success('Archive imported!', 'Celestial Forge');
            }
        });
    });
    
    // Settings checkboxes
    $('#forge-enabled').on('change', function() {
        getSettings().enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#forge-auto-perks').on('change', function() {
        getSettings().autoDetectPerks = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#forge-auto-cp').on('change', function() {
        getSettings().autoDetectCP = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#forge-notifications').on('change', function() {
        getSettings().showNotifications = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#forge-cp-rate').on('change', function() {
        getSettings().cpPerResponse = parseInt($(this).val()) || 10;
        saveSettingsDebounced();
        updateUI();
    });
    $('#forge-threshold').on('change', function() {
        getSettings().thresholdCP = parseInt($(this).val()) || 100;
        saveSettingsDebounced();
        updateUI();
    });
    
    // Data management
    $('#forge-export-state').on('click', () => {
        const state = getCurrentState();
        if (state) {
            downloadJSON(state, `celestial-forge-state-${getCurrentChatId()}.json`);
        }
    });
    
    $('#forge-import-state').on('click', () => {
        uploadJSON((data) => {
            const settings = getSettings();
            const chatId = getCurrentChatId();
            if (chatId && data) {
                settings.chatStates[chatId] = data;
                saveSettingsDebounced();
                updateUI();
                toastr.success('State imported!', 'Celestial Forge');
            }
        });
    });
    
    $('#forge-reset-chat').on('click', () => {
        if (confirm('Reset Forge state for this chat? This cannot be undone.')) {
            const settings = getSettings();
            const chatId = getCurrentChatId();
            if (chatId) {
                settings.chatStates[chatId] = {
                    ...JSON.parse(JSON.stringify(defaultChatState)),
                    createdAt: new Date().toISOString(),
                    lastUpdated: new Date().toISOString()
                };
                saveSettingsDebounced();
                updateUI();
            }
        }
    });
    
    $('#forge-reset-all').on('click', () => {
        if (confirm('Reset ALL Celestial Forge data including archive? This cannot be undone.')) {
            Object.assign(extension_settings[extensionName], JSON.parse(JSON.stringify(defaultSettings)));
            saveSettingsDebounced();
            updateUI();
        }
    });
}

// ============================================
// UI UPDATE FUNCTIONS
// ============================================

function updateUI() {
    const state = getCurrentState();
    const settings = getSettings();
    
    if (!state) {
        $('#forge-chat-id').text('No chat selected');
        return;
    }
    
    const totalCP = getTotalCP(state);
    const availableCP = getAvailableCP(state);
    const thresholdProgress = totalCP % settings.thresholdCP;
    
    // Status tab
    $('#forge-responses').text(state.responseCount);
    $('#forge-total-cp').text(totalCP);
    $('#forge-available-cp').text(availableCP);
    $('#forge-corruption').val(state.corruption);
    $('#forge-corruption-val').text(state.corruption);
    $('#forge-sanity').val(state.sanityErosion);
    $('#forge-sanity-val').text(state.sanityErosion);
    $('#forge-threshold-bar').css('width', `${(thresholdProgress / settings.thresholdCP) * 100}%`);
    $('#forge-threshold-text').text(`${thresholdProgress}/${settings.thresholdCP}`);
    
    // Pending perk
    if (state.pendingPerk) {
        const remaining = state.pendingPerkCost - availableCP;
        const status = remaining > 0 
            ? `<span class="forge-pending">${remaining} CP remaining</span>`
            : `<span class="forge-ready">READY TO MANIFEST!</span>`;
        $('#forge-pending-display').html(`<strong>${state.pendingPerk}</strong> (${state.pendingPerkCost} CP)<br>${status}`);
    } else {
        $('#forge-pending-display').text('None');
    }
    
    // Perks tab
    $('#forge-perk-count').text(state.acquiredPerks.length);
    updatePerkListUI();
    updateActiveTogglesUI();
    
    // Archive tab
    updateArchiveUI();
    
    // Checkpoints tab
    updateCheckpointUI();
    
    // Settings tab
    $('#forge-enabled').prop('checked', settings.enabled);
    $('#forge-auto-perks').prop('checked', settings.autoDetectPerks);
    $('#forge-auto-cp').prop('checked', settings.autoDetectCP);
    $('#forge-notifications').prop('checked', settings.showNotifications);
    $('#forge-cp-rate').val(settings.cpPerResponse);
    $('#forge-threshold').val(settings.thresholdCP);
    $('#forge-chat-id').text(getCurrentChatId() || 'Not loaded');
}

function updatePerkListUI() {
    const state = getCurrentState();
    if (!state) return;
    
    const html = state.acquiredPerks.map(perk => {
        const toggleBtn = perk.isToggleable 
            ? `<button class="forge-toggle-btn ${perk.isActive ? 'active' : ''}" data-perk-id="${perk.id}">
                ${perk.isActive ? '🟢 ON' : '🔴 OFF'}
               </button>`
            : '';
        
        const flagsHtml = perk.flags.length > 0 
            ? `<div class="forge-perk-flags">[${perk.flags.join(', ')}]</div>`
            : '';
        
        return `
        <div class="forge-perk-item ${perk.isToggleable ? 'toggleable' : ''} ${perk.isActive ? 'active' : ''}">
            <div class="forge-perk-header">
                <strong>${perk.name}</strong> <span class="forge-perk-cost">(${perk.cost} CP)</span>
                ${toggleBtn}
                <button class="forge-remove-btn" data-perk-id="${perk.id}">×</button>
            </div>
            <div class="forge-perk-desc">${perk.description || 'No description'}</div>
            ${flagsHtml}
            <div class="forge-perk-meta">Source: ${perk.source} | Acquired at response #${perk.acquiredAt}</div>
        </div>`;
    }).join('') || '<div class="forge-empty">No perks acquired yet</div>';
    
    $('#forge-perk-list').html(html);
    
    // Bind toggle buttons
    $('.forge-toggle-btn').on('click', function() {
        togglePerk($(this).data('perk-id'));
    });
    
    // Bind remove buttons
    $('.forge-remove-btn').on('click', function() {
        if (confirm('Remove this perk?')) {
            removePerk($(this).data('perk-id'));
        }
    });
}

function updateActiveTogglesUI() {
    const state = getCurrentState();
    if (!state) return;
    
    const toggleablePerks = state.acquiredPerks.filter(p => p.isToggleable);
    
    if (toggleablePerks.length === 0) {
        $('#forge-active-toggles').html('<div class="forge-empty">No toggleable perks</div>');
        return;
    }
    
    const html = toggleablePerks.map(perk => `
        <div class="forge-toggle-item">
            <button class="forge-toggle-btn ${perk.isActive ? 'active' : ''}" data-perk-id="${perk.id}">
                ${perk.isActive ? '🟢' : '🔴'} ${perk.name}
            </button>
        </div>
    `).join('');
    
    $('#forge-active-toggles').html(html);
    
    // Rebind events
    $('#forge-active-toggles .forge-toggle-btn').on('click', function() {
        togglePerk($(this).data('perk-id'));
    });
}

function updateArchiveUI(searchQuery = '') {
    const settings = getSettings();
    const archive = searchQuery ? searchArchive(searchQuery) : settings.perkArchive;
    
    $('#forge-archive-count').text(settings.perkArchive.length);
    
    const html = archive.map(perk => `
        <div class="forge-archive-item" data-perk-id="${perk.id}">
            <div class="forge-archive-name">${perk.name}</div>
            <div class="forge-archive-cost">${perk.cost} CP</div>
            <div class="forge-archive-flags">${perk.flags.join(', ') || 'No flags'}</div>
            <div class="forge-archive-actions">
                <button class="forge-acquire-btn" data-perk-id="${perk.id}" title="Acquire this perk">+</button>
                <button class="forge-delete-archive-btn" data-perk-id="${perk.id}" title="Delete from archive">×</button>
            </div>
        </div>
    `).join('') || '<div class="forge-empty">No perks in archive</div>';
    
    $('#forge-archive-list').html(html);
    
    // Bind events
    $('.forge-acquire-btn').on('click', function(e) {
        e.stopPropagation();
        acquireFromArchive($(this).data('perk-id'));
    });
    
    $('.forge-delete-archive-btn').on('click', function(e) {
        e.stopPropagation();
        if (confirm('Delete this perk from the archive?')) {
            deleteFromArchive($(this).data('perk-id'));
        }
    });
    
    // Click on archive item to view details
    $('.forge-archive-item').on('click', function() {
        const perkId = $(this).data('perk-id');
        const perk = settings.perkArchive.find(p => p.id === perkId);
        if (perk) {
            alert(`${perk.name} (${perk.cost} CP)\n\n${perk.description}\n\nFlags: ${perk.flags.join(', ') || 'None'}\n\nTimes acquired: ${perk.timesAcquired || 1}`);
        }
    });
}

function updateCheckpointUI() {
    const state = getCurrentState();
    if (!state) return;
    
    const html = state.checkpoints.map(cp => `
        <div class="forge-checkpoint-item">
            <div class="forge-checkpoint-info">
                <strong>${cp.label}</strong>
                <div class="forge-checkpoint-meta">
                    Response #${cp.state.responseCount} | ${cp.state.acquiredPerks.length} perks | ${cp.state.corruption} corruption
                </div>
                <div class="forge-checkpoint-date">${new Date(cp.createdAt).toLocaleString()}</div>
            </div>
            <div class="forge-checkpoint-actions">
                <button class="forge-restore-btn" data-checkpoint-id="${cp.id}" title="Restore this checkpoint">↩️</button>
                <button class="forge-delete-checkpoint-btn" data-checkpoint-id="${cp.id}" title="Delete checkpoint">×</button>
            </div>
        </div>
    `).join('') || '<div class="forge-empty">No checkpoints saved</div>';
    
    $('#forge-checkpoint-list').html(html);
    
    // Bind events
    $('.forge-restore-btn').on('click', function() {
        if (confirm('Restore to this checkpoint? Current progress will be lost.')) {
            restoreCheckpoint($(this).data('checkpoint-id'));
        }
    });
    
    $('.forge-delete-checkpoint-btn').on('click', function() {
        deleteCheckpoint($(this).data('checkpoint-id'));
    });
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function uploadJSON(callback) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const data = JSON.parse(event.target.result);
                callback(data);
            } catch (err) {
                toastr.error('Failed to parse JSON: ' + err.message, 'Import Error');
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

// ============================================
// INITIALIZATION
// ============================================

jQuery(async () => {
    loadSettings();
    createUI();
    
    // Hook into SillyTavern events
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, onPromptReady);
    
    console.log('[Celestial Forge] Extension v2.0 loaded!');
});

// ============================================
// GLOBAL API
// ============================================

window.CelestialForge = {
    // Perk management
    addPerk,
    removePerk,
    togglePerk,
    togglePerkByName,
    
    // CP management
    addBonusCP,
    setCP,
    modifyCorruption,
    modifySanity,
    
    // Pending perk
    setPendingPerk,
    clearPendingPerk,
    
    // Response tracking
    incrementResponseCount,
    setResponseCount,
    
    // Threshold
    triggerManualRoll,
    checkThreshold,
    
    // Checkpoints
    createCheckpoint,
    restoreCheckpoint,
    deleteCheckpoint,
    
    // Archive
    getArchive,
    searchArchive,
    acquireFromArchive,
    deleteFromArchive,
    
    // State access
    getCurrentState,
    getSettings,
    getTotalCP,
    getAvailableCP,
    generateForgeStatus,
    
    // Detection (for testing)
    parseMessageForPerks,
    parseMessageForCPGains,
    processAIMessage
};

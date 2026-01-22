// Celestial Forge Tracker v9 - Full Bidirectional Sync with SimTracker
// Now properly parses forge blocks AND syncs scaling levels both ways!

class CelestialForgeTracker {
    constructor() {
        this.extensionName = "celestial-forge-tracker";
        this.extensionVersion = "9.0.0";
        this.state = this.getDefaultState();
        this.settings = this.getDefaultSettings();
        this.responseCount = 0;
        this.lastUpdateTime = Date.now();
        this.hasUncapped = false; // Tracks if UNCAPPED perk acquired
        
        // Valid perk flags
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
            has_uncapped: false
        };
    }

    getDefaultSettings() {
        return {
            cp_per_response: 10,
            threshold_base: 100,
            auto_detect_perks: true,
            auto_detect_corruption: true,
            auto_detect_sanity: true,
            parse_forge_blocks: true,  // NEW: Parse forge blocks for sync
            sync_scaling_from_ai: true // NEW: Update scaling from AI output
        };
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
        this.state.base_cp = this.state.response_count * this.settings.cp_per_response;
        this.calculateTotals();
        this.saveState();
        return this.state;
    }

    // ==================== PERK MANAGEMENT ====================

    addPerk(perkData) {
        // Check for UNCAPPED perk specifically
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
            // SCALING support
            scaling: this.createScalingObject(perkData)
        };

        // Check affordability
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
            return { success: true, perk, newState: this.state };
        } else {
            this.state.pending_perk = {
                name: perk.name,
                cost: perk.cost,
                flags: perk.flags,
                description: perk.description,
                constellation: perk.constellation,
                cp_needed: perk.cost - this.state.available_cp
            };
            this.saveState();
            return { success: false, reason: 'insufficient_cp', pending: this.state.pending_perk };
        }
    }

    createScalingObject(perkData) {
        const hasScaling = perkData.flags?.includes('SCALING');
        if (!hasScaling && !perkData.scaling) return null;
        
        // If perkData already has scaling object from forge block, use it
        if (perkData.scaling && typeof perkData.scaling === 'object') {
            return {
                level: perkData.scaling.level || 1,
                maxLevel: this.state.has_uncapped ? 999 : (perkData.scaling.maxLevel || 5),
                xp: perkData.scaling.xp || 0,
                xp_percent: perkData.scaling.xp_percent || 0,
                uncapped: this.state.has_uncapped || perkData.scaling.uncapped || false
            };
        }
        
        // Create new scaling object
        return {
            level: 1,
            maxLevel: this.state.has_uncapped ? 999 : (perkData.maxLevel || 5),
            xp: 0,
            xp_percent: 0,
            uncapped: this.state.has_uncapped
        };
    }

    // ==================== SCALING SYSTEM ====================
    
    applyUncappedToAllPerks() {
        // When UNCAPPED is acquired, update all scaling perks
        this.state.has_uncapped = true;
        for (const perk of this.state.acquired_perks) {
            if (perk.scaling) {
                perk.scaling.maxLevel = 999;
                perk.scaling.uncapped = true;
            }
        }
        this.saveState();
        console.log('[Celestial Forge] UNCAPPED acquired! All scaling perks now have unlimited levels!');
    }
    
    updateScaling(perkName, newLevel, newXp = null) {
        const perk = this.state.acquired_perks.find(p => 
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (!perk || !perk.scaling) return null;
        
        const oldLevel = perk.scaling.level;
        perk.scaling.level = newLevel;
        
        if (newXp !== null) {
            perk.scaling.xp = newXp;
            // Calculate xp_percent (assume 100 xp per level)
            const xpPerLevel = 100;
            perk.scaling.xp_percent = Math.round((newXp / xpPerLevel) * 100);
        }
        
        if (newLevel > oldLevel) {
            this.state.perk_history.push({
                action: 'scaling_levelup',
                perk: perkName,
                oldLevel: oldLevel,
                newLevel: newLevel,
                timestamp: Date.now()
            });
        }
        
        this.saveState();
        return perk.scaling;
    }
    
    addScalingXP(perkName, xpAmount = 10) {
        const perk = this.state.acquired_perks.find(p => 
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (!perk || !perk.scaling) return null;
        
        perk.scaling.xp += xpAmount;
        
        // Level up check (100 XP per level)
        const xpPerLevel = 100;
        while (perk.scaling.xp >= xpPerLevel) {
            // Check if can level up
            if (perk.scaling.level >= perk.scaling.maxLevel && !perk.scaling.uncapped) {
                perk.scaling.xp = xpPerLevel; // Cap at max
                break;
            }
            
            perk.scaling.level++;
            perk.scaling.xp -= xpPerLevel;
            
            this.state.perk_history.push({
                action: 'scaling_levelup',
                perk: perkName,
                newLevel: perk.scaling.level,
                timestamp: Date.now()
            });
        }
        
        perk.scaling.xp_percent = Math.round((perk.scaling.xp / xpPerLevel) * 100);
        
        this.saveState();
        return perk.scaling;
    }

    // ==================== TOGGLE SYSTEM ====================

    togglePerk(perkName) {
        const perk = this.state.acquired_perks.find(p => 
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (!perk) return { success: false, reason: 'not_found' };
        if (!perk.toggleable) return { success: false, reason: 'not_toggleable' };
        
        perk.active = !perk.active;
        
        if (perk.active) {
            if (!this.state.active_toggles.includes(perkName)) {
                this.state.active_toggles.push(perkName);
            }
        } else {
            this.state.active_toggles = this.state.active_toggles.filter(n => 
                n.toLowerCase() !== perkName.toLowerCase()
            );
        }
        
        this.saveState();
        return { success: true, active: perk.active };
    }

    // ==================== FORGE BLOCK PARSING (THE KEY!) ====================
    
    parseForgeBlock(text) {
        // Extract ```forge block from AI response
        const forgeMatch = text.match(/```forge\s*([\s\S]*?)```/i);
        if (!forgeMatch) return null;
        
        try {
            const jsonStr = forgeMatch[1].trim();
            const forgeData = JSON.parse(jsonStr);
            return forgeData;
        } catch (e) {
            console.warn('[Celestial Forge] Failed to parse forge block:', e);
            return null;
        }
    }
    
    syncFromForgeBlock(forgeData) {
        // Sync state from parsed forge block (AI -> Extension)
        if (!forgeData?.characters?.[0]) return false;
        
        const char = forgeData.characters[0];
        const stats = char.stats;
        
        if (!stats) {
            console.warn('[Celestial Forge] No stats in forge block');
            return false;
        }
        
        // Sync basic stats
        if (stats.corruption !== undefined) this.state.corruption = stats.corruption;
        if (stats.sanity !== undefined) this.state.sanity = stats.sanity;
        
        // Sync scaling levels from perks array
        if (Array.isArray(stats.perks)) {
            for (const forgePerk of stats.perks) {
                // Find matching perk in our state
                const localPerk = this.state.acquired_perks.find(p => 
                    p.name.toLowerCase() === forgePerk.name?.toLowerCase()
                );
                
                if (localPerk) {
                    // Sync active state
                    if (forgePerk.active !== undefined) {
                        localPerk.active = forgePerk.active;
                    }
                    
                    // Sync scaling data (THIS IS THE KEY!)
                    if (forgePerk.scaling && localPerk.scaling) {
                        if (forgePerk.scaling.level !== undefined) {
                            localPerk.scaling.level = forgePerk.scaling.level;
                        }
                        if (forgePerk.scaling.xp !== undefined) {
                            localPerk.scaling.xp = forgePerk.scaling.xp;
                        }
                        if (forgePerk.scaling.xp_percent !== undefined) {
                            localPerk.scaling.xp_percent = forgePerk.scaling.xp_percent;
                        }
                        if (forgePerk.scaling.uncapped) {
                            localPerk.scaling.uncapped = true;
                            localPerk.scaling.maxLevel = 999;
                            this.state.has_uncapped = true;
                        }
                    }
                } else if (forgePerk.name) {
                    // Perk in forge block but not in our state - add it!
                    console.log('[Celestial Forge] Found new perk in forge block:', forgePerk.name);
                    this.addPerk(forgePerk);
                }
            }
        }
        
        // Update active toggles
        this.state.active_toggles = this.state.acquired_perks
            .filter(p => p.toggleable && p.active)
            .map(p => p.name);
        
        this.saveState();
        return true;
    }

    // ==================== SIMTRACKER JSON GENERATION ====================
    
    generateSimTrackerJSON(dateTimeOverride = null) {
        const now = new Date();
        const dateStr = dateTimeOverride || now.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
        });
        const timeStr = now.toLocaleTimeString('en-US', { 
            hour: '2-digit', minute: '2-digit' 
        });
        
        return {
            characters: [{
                characterName: "Smith",  // CORRECT KEY!
                currentDateTime: dateTimeOverride || `${dateStr}, ${timeStr}`,
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
                    perks: this.state.acquired_perks.map(p => {
                        const hasScaling = p.scaling !== null;
                        const isUncapped = p.scaling?.uncapped || false;
                        const xpNeeded = hasScaling ? (p.scaling.level * 10) : 0;
                        
                        return {
                            name: p.name,
                            cost: p.cost,
                            flags: p.flags,
                            flags_str: p.flags?.join(', ') || '', // Pre-joined for display
                            description: p.description,
                            toggleable: p.toggleable || false,
                            active: p.active !== false,
                            // Scaling with display helpers
                            scaling: hasScaling ? {
                                level: p.scaling.level,
                                maxLevel: p.scaling.maxLevel,
                                xp: p.scaling.xp,
                                xp_needed: xpNeeded,
                                xp_percent: Math.min(100, Math.round((p.scaling.xp / xpNeeded) * 100)) || 0,
                                uncapped: isUncapped,
                                // Pre-formatted display string
                                level_display: isUncapped 
                                    ? `Lv.${p.scaling.level}/∞` 
                                    : `Lv.${p.scaling.level}/${p.scaling.maxLevel}`,
                                xp_display: `${p.scaling.xp}/${xpNeeded} XP`
                            } : null,
                            // Top-level flags for easy template checks
                            has_scaling: hasScaling,
                            is_uncapped: isUncapped,
                            is_toggleable: p.toggleable || false,
                            is_active: p.active !== false
                        };
                    }),
                    pending_perk: this.state.pending_perk?.name || "",
                    pending_cp: this.state.pending_perk?.cost || 0,
                    pending_remaining: this.state.pending_perk?.cp_needed || 0
                }
            }]
        };
    }

    // ==================== CONTEXT INJECTION (FOR AI) ====================
    
    /**
     * Generate TEXT block for AI context (human readable)
     */
    generateContextBlock() {
        const perksStr = this.state.acquired_perks.map(p => {
            let str = `- ${p.name} (${p.cost} CP) [${p.flags.join(', ')}]`;
            if (p.scaling) {
                const maxStr = p.scaling.uncapped ? '∞' : p.scaling.maxLevel;
                str += ` [Level ${p.scaling.level}/${maxStr}, XP: ${p.scaling.xp}/100]`;
            }
            if (p.toggleable) str += p.active ? ' [ACTIVE]' : ' [INACTIVE]';
            return str;
        }).join('\n');
        
        const togglesStr = this.state.active_toggles.length > 0 
            ? this.state.active_toggles.join(', ') 
            : '(none)';
        
        return `[CELESTIAL FORGE STATE - USE THIS FOR FORGE BLOCK OUTPUT]
Response Count: ${this.state.response_count}
Total CP: ${this.state.total_cp} | Available: ${this.state.available_cp} | Spent: ${this.state.spent_cp}
Threshold Progress: ${this.state.threshold_progress}/${this.state.threshold}
Corruption: ${this.state.corruption}/100 | Sanity Erosion: ${this.state.sanity}/100
${this.state.has_uncapped ? '⚠️ UNCAPPED ACTIVE - All scaling perks have unlimited levels!' : ''}
${this.state.pending_perk ? `PENDING: ${this.state.pending_perk.name} (need ${this.state.pending_perk.cp_needed} more CP)` : ''}
Active Toggles: ${togglesStr}

ACQUIRED PERKS (${this.state.acquired_perks.length}):
${perksStr || '(none yet)'}
[END FORGE STATE]`;
    }
    
    /**
     * Generate JSON injection - SAME FORMAT as AI output!
     * This is the PREFERRED method for consistent bidirectional sync
     */
    generateForgeBlockInjection() {
        const json = this.generateSimTrackerJSON();
        
        return `[CELESTIAL FORGE - CURRENT STATE]
Read this JSON state. Update values based on story events. Output updated state at response end.

\`\`\`forge
${JSON.stringify(json, null, 2)}
\`\`\`

INSTRUCTIONS:
- Increment response_count by 1
- Add 10 to total_cp (10 CP per response)
- Recalculate available_cp = total_cp - spent_cp
- Update threshold_progress = total_cp % 100
- If acquiring a perk: add to perks array, add cost to spent_cp
- If perk has SCALING flag: include scaling object with level/xp
- Update corruption/sanity if story events warrant
- Output the COMPLETE updated \`\`\`forge block at response end

[END FORGE INJECTION]`;
    }
    
    /**
     * Generate minimal injection (just the JSON, less tokens)
     */
    generateMinimalInjection() {
        const json = this.generateSimTrackerJSON();
        return `[FORGE STATE]\n\`\`\`forge\n${JSON.stringify(json)}\n\`\`\`\n[Update and output at response end]`;
    }
    }
    
    // Generate the EXACT JSON template for AI to copy
    generateForgeBlockTemplate() {
        const json = this.generateSimTrackerJSON();
        return '```forge\n' + JSON.stringify(json, null, 2) + '\n```';
    }

    // ==================== AI RESPONSE PROCESSING (FULL) ====================

    parseAIResponse(text) {
        const results = { 
            perks: [], 
            corruption: null, 
            sanity: null, 
            scaling: [],
            forgeBlock: null 
        };
        
        // FIRST: Try to parse forge block (HIGHEST PRIORITY!)
        results.forgeBlock = this.parseForgeBlock(text);
        
        // Parse perk acquisitions from narrative
        const perkPatterns = [
            /\[PERK (?:GAINED|ACQUIRED|UNLOCKED)\]\s*\n?\s*Name:\s*(.+?)\s*\n\s*Cost:\s*(\d+)\s*CP\s*\n\s*Flags?:\s*\[([^\]]*)\]\s*\n\s*(?:Description:\s*)?(.+?)(?=\n\n|\[|$)/gis,
            /\*\*PERK:\s*(.+?)\*\*\s*\((\d+)\s*CP\)\s*\[([^\]]*)\]\s*[-:]?\s*(.+?)(?=\n\n|\*\*|$)/gi,
            /\*\*([A-Z][A-Z\s]+?)\*\*\s*\((\d+)\s*CP\).*?\[([^\]]*)\].*?[-–—:]\s*(.+?)(?=\n\n|$)/gi,
            /The Forge (?:grants|bestows|resonates).*?["'](.+?)["'].*?(\d+)\s*CP/gi
        ];
        
        for (const pattern of perkPatterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const flags = match[3] ? match[3].split(/[,\s]+/).filter(f => f.trim()) : [];
                results.perks.push({
                    name: match[1].trim(),
                    cost: parseInt(match[2]),
                    flags: flags,
                    description: match[4]?.trim() || ''
                });
            }
        }
        
        // Parse corruption changes
        const corruptionPatterns = [
            /\[?CORRUPTION[:\s]+([+-]?\d+)\]?/gi,
            /corruption (?:increases?|rises?|grows?) by (\d+)/gi,
            /\+(\d+) corruption/gi
        ];
        for (const pattern of corruptionPatterns) {
            const match = pattern.exec(text);
            if (match) {
                results.corruption = parseInt(match[1]);
                break;
            }
        }
        
        // Parse sanity changes
        const sanityPatterns = [
            /\[?SANITY[:\s]+([+-]?\d+)\]?/gi,
            /sanity (?:erodes?|decreases?|falls?) by (\d+)/gi,
            /\+(\d+) sanity erosion/gi
        ];
        for (const pattern of sanityPatterns) {
            const match = pattern.exec(text);
            if (match) {
                results.sanity = parseInt(match[1]);
                break;
            }
        }
        
        // Parse scaling level ups
        const scalingPatterns = [
            /\[([^\]]+?) LEVELS? UP[^\]]*\]/gi,
            /([A-Z][A-Z\s]+?) (?:grows stronger|levels up|advances|evolves)/gi,
            /Level (?:increased?|up) for ([^.!]+)/gi
        ];
        for (const pattern of scalingPatterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                results.scaling.push(match[1].trim());
            }
        }
        
        return results;
    }

    processAIResponse(text) {
        const parsed = this.parseAIResponse(text);
        const actions = [];
        
        // PRIORITY 1: Sync from forge block if present
        if (parsed.forgeBlock && this.settings.sync_scaling_from_ai) {
            const synced = this.syncFromForgeBlock(parsed.forgeBlock);
            if (synced) {
                actions.push({ type: 'forge_sync', success: true });
            }
        }
        
        // PRIORITY 2: Process new perks from narrative
        for (const perkData of parsed.perks) {
            // Check if already have this perk
            const exists = this.state.acquired_perks.some(p => 
                p.name.toLowerCase() === perkData.name.toLowerCase()
            );
            if (!exists) {
                const result = this.addPerk(perkData);
                actions.push({ type: 'perk', data: perkData, result });
            }
        }
        
        // PRIORITY 3: Process corruption changes
        if (parsed.corruption !== null) {
            this.state.corruption = Math.min(100, Math.max(0, this.state.corruption + parsed.corruption));
            actions.push({ type: 'corruption', change: parsed.corruption, new_value: this.state.corruption });
        }
        
        // PRIORITY 4: Process sanity changes
        if (parsed.sanity !== null) {
            this.state.sanity = Math.min(100, Math.max(0, this.state.sanity + parsed.sanity));
            actions.push({ type: 'sanity', change: parsed.sanity, new_value: this.state.sanity });
        }
        
        // PRIORITY 5: Process scaling mentions (gives bonus XP)
        for (const perkName of parsed.scaling) {
            const progress = this.addScalingXP(perkName, 25); // 25 XP for narrative mention
            if (progress) {
                actions.push({ type: 'scaling_xp', perk: perkName, progress });
            }
        }
        
        // Increment response count
        this.incrementResponse();
        
        this.saveState();
        return { actions, newState: this.state };
    }

    // ==================== PERSISTENCE ====================

    saveState() {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('celestialForgeState_v9', JSON.stringify(this.state));
                localStorage.setItem('celestialForgeSettings_v9', JSON.stringify(this.settings));
            }
        } catch (e) {
            console.warn('[Celestial Forge] Failed to save state:', e);
        }
    }

    loadState() {
        try {
            if (typeof localStorage !== 'undefined') {
                const savedState = localStorage.getItem('celestialForgeState_v9');
                const savedSettings = localStorage.getItem('celestialForgeSettings_v9');
                
                if (savedState) {
                    this.state = { ...this.getDefaultState(), ...JSON.parse(savedState) };
                }
                if (savedSettings) {
                    this.settings = { ...this.getDefaultSettings(), ...JSON.parse(savedSettings) };
                }
            }
        } catch (e) {
            console.warn('[Celestial Forge] Failed to load state:', e);
        }
        return this.state;
    }

    // ==================== MANUAL CONTROLS ====================

    manualSetCP(total, bonus = null) {
        if (bonus !== null) {
            this.state.bonus_cp = bonus;
        } else {
            this.state.bonus_cp = total - this.state.base_cp;
        }
        this.calculateTotals();
        this.saveState();
        return this.state;
    }

    manualSetCorruption(value) {
        this.state.corruption = Math.min(100, Math.max(0, value));
        this.saveState();
        return this.state;
    }

    manualSetSanity(value) {
        this.state.sanity = Math.min(100, Math.max(0, value));
        this.saveState();
        return this.state;
    }
    
    manualSetScaling(perkName, level, xp = 0) {
        return this.updateScaling(perkName, level, xp);
    }

    resetState() {
        this.state = this.getDefaultState();
        this.saveState();
        return this.state;
    }

    // ==================== EXPORT / IMPORT ====================
    
    exportState() {
        return {
            version: this.extensionVersion,
            timestamp: Date.now(),
            state: this.state,
            settings: this.settings
        };
    }
    
    importState(data) {
        if (data.state) {
            this.state = { ...this.getDefaultState(), ...data.state };
            this.calculateTotals();
            this.saveState();
            return true;
        }
        return false;
    }
    
    // ==================== DEBUG / UTILITY ====================
    
    getStatus() {
        return {
            version: this.extensionVersion,
            perkCount: this.state.acquired_perks.length,
            totalCP: this.state.total_cp,
            availableCP: this.state.available_cp,
            corruption: this.state.corruption,
            sanity: this.state.sanity,
            hasUncapped: this.state.has_uncapped,
            scalingPerks: this.state.acquired_perks
                .filter(p => p.scaling)
                .map(p => ({ name: p.name, level: p.scaling.level, uncapped: p.scaling.uncapped }))
        };
    }
}

// ==================== SILLYTAVERN EVENT HOOKS ====================

function setupSillyTavernHooks() {
    // Hook into SillyTavern's event system
    if (typeof eventSource !== 'undefined') {
        // Primary hook - when message is received
        eventSource.on('MESSAGE_RECEIVED', (data) => {
            if (window.celestialForge && data?.message) {
                console.log('[Celestial Forge] Processing MESSAGE_RECEIVED');
                window.celestialForge.processAIResponse(data.message);
            }
        });
        
        // Backup hook - when chat completion is done
        eventSource.on('CHATCOMPLETION_DONE', (data) => {
            if (window.celestialForge && data?.response) {
                console.log('[Celestial Forge] Processing CHATCOMPLETION_DONE');
                window.celestialForge.processAIResponse(data.response);
            }
        });
        
        console.log('[Celestial Forge] SillyTavern event hooks registered');
    }
    
    // Alternative: jQuery-based message events
    if (typeof jQuery !== 'undefined') {
        jQuery(document).on('message_received.celestialforge', function(e, data) {
            if (window.celestialForge && data?.mes) {
                window.celestialForge.processAIResponse(data.mes);
            }
        });
    }
    
    // Alternative: MutationObserver for chat container
    const chatObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1 && node.classList?.contains('mes')) {
                    const mesText = node.querySelector('.mes_text')?.textContent;
                    if (mesText && window.celestialForge) {
                        window.celestialForge.processAIResponse(mesText);
                    }
                }
            }
        }
    });
    
    // Start observing when chat container exists
    const chatContainer = document.getElementById('chat');
    if (chatContainer) {
        chatObserver.observe(chatContainer, { childList: true, subtree: true });
        console.log('[Celestial Forge] Chat observer started');
    }
}

/**
 * Get prompt injection text for Author's Note / System Prompt
 * Call this from SillyTavern's prompt injection settings
 */
function getCelestialForgeInjection() {
    if (!window.celestialForge) return '';
    return window.celestialForge.generateContextBlock();
}

/**
 * Get JSON-based injection (RECOMMENDED - consistent format)
 */
function getCelestialForgeJSON() {
    if (!window.celestialForge) return '';
    return window.celestialForge.generateForgeBlockInjection();
}

/**
 * Get minimal injection (fewer tokens)
 */
function getCelestialForgeMinimal() {
    if (!window.celestialForge) return '';
    return window.celestialForge.generateMinimalInjection();
}

// Export for both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CelestialForgeTracker;
}
if (typeof window !== 'undefined') {
    window.CelestialForgeTracker = CelestialForgeTracker;
    // Auto-initialize
    window.celestialForge = new CelestialForgeTracker();
    window.celestialForge.loadState();
    
    // Expose injection helpers (multiple options!)
    window.getCelestialForgeInjection = getCelestialForgeInjection; // Text format
    window.getCelestialForgeJSON = getCelestialForgeJSON;           // JSON format (recommended!)
    window.getCelestialForgeMinimal = getCelestialForgeMinimal;     // Minimal tokens
    
    // Setup hooks on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupSillyTavernHooks);
    } else {
        setTimeout(setupSillyTavernHooks, 100); // Slight delay to ensure ST is ready
    }
    
    console.log('[Celestial Forge v9] Initialized!', window.celestialForge.getStatus());
}
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
    _pendingRollTrigger: null
};

// ============================================
// REGEX PATTERNS FOR AUTO-DETECTION
// ============================================

// Standard markdown format patterns (original)
const PERK_PATTERNS = [
    /\*\*([A-Z][A-Z\s\-\']+)\*\*\s*\((\d+)\s*CP\)\s*[-–—:]\s*([^\[]+?)(?:\[([^\]]+)\])?/gi,
    /\[ACQUIRED:\s*([A-Z][A-Z\s\-\']+)\s*[-–—]\s*(\d+)\s*CP\]/gi,
    /(?:you\s+)?gain(?:ed|s)?\s+\*\*([A-Z][A-Z\s\-\']+)\*\*\s*\((\d+)\s*CP\)/gi,
    /^([A-Z][A-Z\s\-\']{3,})\s*\((\d+)\s*CP\)\s*(?:\[([^\]]+)\])?\s*[-–—:]/gim,
    /(?:forge\s+grants|acquired|unlocked|gained):\s*\*?\*?([A-Z][A-Z\s\-\']+)\*?\*?\s*\((\d+)\s*CP\)/gi,
    // NEW: Loomledger HTML format patterns for Opus/Lumia output
    /<perk[^>]*>([^<]+)<\/perk>\s*\((\d+)\s*CP\)/gi,
    /<acquired[^>]*>([^<]+)<\/acquired>\s*[-–—:]\s*(\d+)\s*CP/gi,
    /<span[^>]*class=["']?perk["']?[^>]*>([^<]+)<\/span>\s*\((\d+)\s*CP\)/gi,
    /perk[_\-]?name['":\s]+([A-Za-z][A-Za-z\s\-\']+)['"]*[,\s]+cost['":\s]+(\d+)/gi
];

const CP_GAIN_PATTERNS = [
    /\+(\d+)\s*(?:Bonus\s*)?CP/gi,
    /Award:\s*\+?(\d+)\s*(?:Bonus\s*)?CP/gi,
    /\[FORGE\s+RESONANCE[^\]]*\].*?\+(\d+)\s*(?:Bonus\s*)?CP/gi,
    /(?:gains?|earned?|receives?|awarded?)\s+(\d+)\s*(?:Bonus\s*)?CP/gi,
    // NEW: Loomledger HTML/JSON format patterns
    /total[_\-]?cp['":\s]+(\d+)/gi,
    /<cp[^>]*>(\d+)<\/cp>/gi,
    /cp[_\-]?earned['":\s]+(\d+)/gi
];

const CORRUPTION_PATTERNS = [
    /\+(\d+)\s*Corruption/gi,
    /Corruption:\s*\+(\d+)/gi,
    /[-–—](\d+)\s*Corruption/gi,
    // NEW: Loomledger formats
    /corruption['":\s]+(\d+)/gi,
    /<corruption[^>]*>(\d+)<\/corruption>/gi
];

const SANITY_PATTERNS = [
    /\+(\d+)\s*Sanity\s*(?:Erosion|Cost)/gi,
    /Sanity\s*(?:Erosion|Cost):\s*\+(\d+)/gi,
    // NEW: Loomledger formats
    /sanity[_\-]?erosion['":\s]+(\d+)/gi,
    /<sanity[^>]*>(\d+)<\/sanity>/gi
];

// NEW: Loomledger block parser - extracts full state from HTML ledger
const LOOMLEDGER_PATTERN = /<loomledger[^>]*>([\s\S]*?)<\/loomledger>/gi;

// ============================================
// SETTINGS MANAGEMENT
// ============================================

function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = JSON.parse(JSON.stringify(defaultSettings));
    }
    return context.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
}

function getCurrentChatId() {
    const context = SillyTavern.getContext();
    if (!context.chatId) return null;
    const charName = context.characters?.[context.characterId]?.name || 'unknown';
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
        saveSettings();
    }
    
    return settings.chatStates[chatId];
}

function getTotalCP(state = null) {
    state = state || getCurrentState();
    if (!state) return 0;
    const settings = getSettings();
    return (state.responseCount * settings.cpPerResponse) + state.bonusCP;
}

function getAvailableCP(state = null) {
    state = state || getCurrentState();
    if (!state) return 0;
    return getTotalCP(state) - state.spentCP;
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
        description: (description || '').trim(),
        flags: Array.isArray(flags) ? flags : String(flags).split(',').map(f => f.trim()).filter(f => f),
        isToggleable: false,
        isActive: false,
        acquiredAt: state.responseCount,
        acquiredDate: new Date().toISOString(),
        source: source
    };
    
    perk.isToggleable = perk.flags.some(f => 
        f.toUpperCase().includes('TOGGLEABLE') || f.toUpperCase().includes('TOGGLE')
    );
    
    if (perk.isToggleable) {
        perk.isActive = true;
        if (!state.activeToggles.includes(perk.name)) {
            state.activeToggles.push(perk.name);
        }
    }
    
    state.acquiredPerks.push(perk);
    state.spentCP += perk.cost;
    state.lastUpdated = new Date().toISOString();
    
    // Add to global archive
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
    
    saveSettings();
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
        
        const toggleIndex = state.activeToggles.indexOf(perk.name);
        if (toggleIndex > -1) {
            state.activeToggles.splice(toggleIndex, 1);
        }
        
        state.acquiredPerks.splice(index, 1);
        state.lastUpdated = new Date().toISOString();
        saveSettings();
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
        saveSettings();
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
    saveSettings();
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
    
    const baseCP = state.responseCount * settings.cpPerResponse;
    const neededBonus = totalCP - baseCP + state.spentCP;
    
    state.bonusCP = Math.max(0, neededBonus);
    state.lastUpdated = new Date().toISOString();
    saveSettings();
    updateUI();
}

function modifyCorruption(amount) {
    const state = getCurrentState();
    const settings = getSettings();
    if (!state) return;
    
    state.corruption = Math.max(0, Math.min(100, state.corruption + amount));
    state.lastUpdated = new Date().toISOString();
    saveSettings();
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
    saveSettings();
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
    saveSettings();
    updateUI();
}

function clearPendingPerk() {
    const state = getCurrentState();
    if (!state) return;
    
    state.pendingPerk = null;
    state.pendingPerkCost = 0;
    state.lastUpdated = new Date().toISOString();
    saveSettings();
    updateUI();
}

function incrementResponseCount() {
    const state = getCurrentState();
    if (!state) return;
    
    state.responseCount++;
    state.lastUpdated = new Date().toISOString();
    saveSettings();
    updateUI();
    checkThreshold();
}

function setResponseCount(count) {
    const state = getCurrentState();
    if (!state) return;
    
    state.responseCount = Math.max(0, parseInt(count) || 0);
    state.lastUpdated = new Date().toISOString();
    saveSettings();
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
        saveSettings();
        
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
    if (!state) return;
    
    const availableCP = getAvailableCP(state);
    
    state._pendingRollTrigger = `\n\n[CELESTIAL FORGE - MANUAL ROLL TRIGGERED]
The Smith calls upon the Forge. Available CP: ${availableCP}
Roll a constellation and generate an appropriate perk. Follow the generation guidelines.
Format new perks as: **PERK NAME** (XXX CP) - Description [FLAGS]
If the rolled perk costs more than available CP, set it as PENDING.
[END FORGE TRIGGER]\n`;
    
    saveSettings();
    toastr.info('Roll triggered! Send your next message to activate.', 'Celestial Forge');
}

// ============================================
// AUTO-DETECTION
// ============================================

function parseMessageForPerks(messageText) {
    const detectedPerks = [];
    
    for (const pattern of PERK_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(messageText)) !== null) {
            const perkData = {
                name: match[1]?.trim(),
                cost: parseInt(match[2]) || 0,
                description: match[3]?.trim() || '',
                flags: match[4]?.split(',').map(f => f.trim()).filter(f => f) || []
            };
            
            if (perkData.name && perkData.name.length > 2 && perkData.name.length < 100 &&
                perkData.cost >= 0 && perkData.cost <= 2000) {
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
            if (amount > 0 && amount <= 500) {
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

// NEW: Parse forge JSON blocks from AI output - PROPERLY extracts all data
function parseLoomledger(messageText) {
    const result = {
        perks: [],
        totalCP: null,
        availableCP: null,
        corruption: null,
        sanity: null,
        responseCount: null,
        perkCount: null,
        perksList: null,
        activeToggles: null,
        pendingPerk: null,
        pendingCost: null,
        pendingRemaining: null,
        thresholdProgress: null,
        thresholdMax: null,
        found: false
    };
    
    // Primary pattern: ```forge blocks (what SimTracker expects)
    const forgeBlockPattern = /```forge\s*([\s\S]*?)```/gi;
    forgeBlockPattern.lastIndex = 0;
    let match = forgeBlockPattern.exec(messageText);
    
    if (!match) {
        // Fallback patterns
        const altPatterns = [
            /```json\s*([\s\S]*?)```/gi,
            /<loomledger[^>]*>([\s\S]*?)<\/loomledger>/gi,
            /<forge[_\-]?state[^>]*>([\s\S]*?)<\/forge[_\-]?state>/gi
        ];
        
        for (const alt of altPatterns) {
            alt.lastIndex = 0;
            match = alt.exec(messageText);
            if (match) break;
        }
    }
    
    if (match) {
        try {
            const jsonData = JSON.parse(match[1]);
            result.found = true;
            
            // Extract from SimTracker format: { worldData: {...}, characters: [{...}] }
            if (jsonData.characters && jsonData.characters[0]) {
                const char = jsonData.characters[0];
                
                // v5 FORMAT: Data nested inside stats object
                // v4 FORMAT: Data flat at character level
                const data = char.stats || char; // Handle both formats!
                
                // Core stats
                result.totalCP = data.total_cp ?? null;
                result.availableCP = data.available_cp ?? null;
                result.corruption = data.corruption ?? null;
                result.sanity = data.sanity ?? data.sanityErosion ?? null;
                result.perkCount = data.perk_count ?? null;
                
                // Threshold tracking
                result.thresholdProgress = data.threshold_progress ?? null;
                result.thresholdMax = data.threshold_max ?? null;
                
                // Pending perk info
                result.pendingPerk = data.pending_perk || null;
                result.pendingCost = data.pending_cp ?? null;
                result.pendingRemaining = data.pending_remaining ?? null;
                
                // ============================================
                // v5/v4 FORMAT: perks as array of objects
                // ============================================
                if (data.perks && Array.isArray(data.perks)) {
                    for (const perk of data.perks) {
                        if (perk.name) {
                            result.perks.push({
                                name: perk.name,
                                cost: perk.cost || 0,
                                description: perk.description || '',
                                flags: Array.isArray(perk.flags) ? perk.flags : [],
                                toggleable: perk.toggleable === true,
                                active: perk.active !== false // default to true
                            });
                        }
                    }
                    log('Parsed perks array format:', result.perks.length, 'perks');
                }
                
                // ============================================
                // LEGACY: perks_list as pipe-separated string
                // ============================================
                else if (data.perks_list && typeof data.perks_list === 'string' && data.perks_list.trim()) {
                    result.perksList = data.perks_list;
                    const perkStrings = data.perks_list.split('|').map(s => s.trim()).filter(s => s);
                    
                    for (const perkStr of perkStrings) {
                        // Parse "PERK NAME (XXX CP)" format
                        const perkMatch = perkStr.match(/^(.+?)\s*\((\d+)\s*CP\)$/i);
                        if (perkMatch) {
                            const name = perkMatch[1].trim();
                            const cost = parseInt(perkMatch[2]) || 0;
                            if (name && !result.perks.find(p => p.name.toLowerCase() === name.toLowerCase())) {
                                result.perks.push({ 
                                    name, 
                                    cost, 
                                    description: '', 
                                    flags: [],
                                    toggleable: false,
                                    active: true
                                });
                            }
                        }
                    }
                    log('Parsed legacy perks_list format:', result.perks.length, 'perks');
                }
                
                // Build activeToggles from perks array if available
                if (result.perks.length > 0) {
                    const activeToggleNames = result.perks
                        .filter(p => p.toggleable && p.active)
                        .map(p => p.name);
                    if (activeToggleNames.length > 0) {
                        result.activeToggles = activeToggleNames.join(', ');
                    }
                }
                // Fallback to active_toggles string from JSON
                else if (data.active_toggles) {
                    result.activeToggles = data.active_toggles;
                }
                
                // Response count - check both locations
                result.responseCount = data.response_count ?? null;
            }
            
            // Extract response count from worldData as fallback
            if (jsonData.worldData && result.responseCount === null) {
                result.responseCount = jsonData.worldData.response_count ?? null;
            }
            
            log('Parsed forge block:', result);
            
        } catch (e) {
            log('Failed to parse forge block JSON:', e.message);
            // Try regex extraction as fallback
            parseStateFromText(match[1], result);
            if (result.totalCP !== null || result.corruption !== null) {
                result.found = true;
            }
        }
    }
    
    // Also scan full message for inline state mentions if nothing found
    if (!result.found) {
        parseStateFromText(messageText, result);
        if (result.totalCP !== null || result.corruption !== null || result.perks.length > 0) {
            result.found = true;
        }
    }
    
    return result;
}

function parseStateFromText(text, result) {
    // Extract CP values
    const cpMatch = text.match(/(?:total[_\s\-]?cp|cp[_\s\-]?total)['":\s]*(\d+)/i);
    if (cpMatch) result.totalCP = parseInt(cpMatch[1]);
    
    const availMatch = text.match(/(?:available[_\s\-]?cp|cp[_\s\-]?available)['":\s]*(\d+)/i);
    if (availMatch) result.availableCP = parseInt(availMatch[1]);
    
    // Extract corruption
    const corruptMatch = text.match(/corruption['":\s]*(\d+)/i);
    if (corruptMatch) result.corruption = parseInt(corruptMatch[1]);
    
    // Extract sanity
    const sanityMatch = text.match(/(?:sanity[_\s\-]?erosion|sanity)['":\s]*(\d+)/i);
    if (sanityMatch) result.sanity = parseInt(sanityMatch[1]);
    
    // Extract perks from various formats
    const perkPatterns = [
        /<li[^>]*>([^<]+)\s*\((\d+)\s*CP\)/gi,
        /•\s*([A-Za-z][A-Za-z\s\-\']+)\s*\((\d+)\s*CP\)/g,
        /\d+\.\s*([A-Za-z][A-Za-z\s\-\']+)\s*\((\d+)\s*CP\)/g
    ];
    
    for (const pattern of perkPatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const name = match[1]?.trim();
            const cost = parseInt(match[2]) || 0;
            if (name && name.length > 2 && cost > 0) {
                if (!result.perks.find(p => p.name.toLowerCase() === name.toLowerCase())) {
                    result.perks.push({ name, cost, description: '', flags: [] });
                }
            }
        }
    }
    
    return result;
}

function processAIMessage(messageText) {
    const settings = getSettings();
    const state = getCurrentState();
    if (!state || !settings.enabled) return;
    
    // Parse forge block - this is the primary source of truth from AI
    const ledgerData = parseLoomledger(messageText);
    
    if (ledgerData.found) {
        log('Detected forge state block in AI output');
        let synced = [];
        
        // Sync corruption - NO restrictive diff limit
        if (ledgerData.corruption !== null && ledgerData.corruption !== state.corruption) {
            state.corruption = Math.max(0, Math.min(100, ledgerData.corruption));
            synced.push(`corruption→${state.corruption}`);
        }
        
        // Sync sanity erosion - NO restrictive diff limit  
        if (ledgerData.sanity !== null && ledgerData.sanity !== state.sanityErosion) {
            state.sanityErosion = Math.max(0, Math.min(100, ledgerData.sanity));
            synced.push(`sanity→${state.sanityErosion}`);
        }
        
        // Sync pending perk
        if (ledgerData.pendingPerk && ledgerData.pendingPerk !== state.pendingPerk) {
            state.pendingPerk = ledgerData.pendingPerk;
            state.pendingPerkCost = ledgerData.pendingCost || 0;
            synced.push(`pending→${state.pendingPerk}`);
        } else if (ledgerData.pendingPerk === '' && state.pendingPerk) {
            // AI cleared the pending perk (probably acquired it)
            state.pendingPerk = null;
            state.pendingPerkCost = 0;
            synced.push('pending→cleared');
        }
        
        // Sync CP values by adjusting bonusCP to match AI's total
        // This keeps extension and AI in sync without overwriting responseCount
        if (ledgerData.totalCP !== null) {
            const currentTotal = getTotalCP(state);
            if (ledgerData.totalCP !== currentTotal) {
                // Calculate what bonusCP should be to match AI's total
                const expectedBase = state.responseCount * settings.cpPerResponse;
                const neededBonus = ledgerData.totalCP - expectedBase;
                if (neededBonus >= 0) {
                    state.bonusCP = neededBonus;
                    synced.push(`totalCP→${ledgerData.totalCP}`);
                }
            }
        }
        
        // Add perks from forge block that we don't have - WITH FULL DATA!
        for (const perkData of ledgerData.perks) {
            const existing = state.acquiredPerks.find(p => 
                p.name.toLowerCase() === perkData.name.toLowerCase()
            );
            
            if (!existing) {
                // Use the new addPerk signature that accepts full perk data
                const perk = {
                    id: `perk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    name: perkData.name.trim(),
                    cost: parseInt(perkData.cost) || 0,
                    description: perkData.description || '',
                    flags: perkData.flags || [],
                    isToggleable: perkData.toggleable === true || 
                                  (perkData.flags && perkData.flags.some(f => 
                                      f.toUpperCase().includes('TOGGLE'))),
                    isActive: perkData.active !== false,
                    acquiredAt: state.responseCount,
                    acquiredDate: new Date().toISOString(),
                    source: 'forge-sync'
                };
                
                state.acquiredPerks.push(perk);
                state.spentCP += perk.cost;
                
                // Track active toggles
                if (perk.isToggleable && perk.isActive) {
                    if (!state.activeToggles.includes(perk.name)) {
                        state.activeToggles.push(perk.name);
                    }
                }
                
                synced.push(`+perk:${perk.name}${perk.isToggleable ? ' [T]' : ''}`);
                
                if (settings.showNotifications) {
                    toastr.success(
                        `Acquired: ${perk.name} (${perk.cost} CP)${perk.isToggleable ? ' [Toggleable]' : ''}`, 
                        'Celestial Forge'
                    );
                }
            } else {
                // Update existing perk's toggle state if it changed
                if (existing.isToggleable && perkData.active !== undefined) {
                    if (existing.isActive !== perkData.active) {
                        existing.isActive = perkData.active;
                        
                        // Update activeToggles array
                        const toggleIndex = state.activeToggles.indexOf(existing.name);
                        if (perkData.active && toggleIndex === -1) {
                            state.activeToggles.push(existing.name);
                        } else if (!perkData.active && toggleIndex > -1) {
                            state.activeToggles.splice(toggleIndex, 1);
                        }
                        
                        synced.push(`toggle:${existing.name}→${perkData.active ? 'ON' : 'OFF'}`);
                    }
                }
                
                // Update description/flags if they were empty and now have data
                if (!existing.description && perkData.description) {
                    existing.description = perkData.description;
                }
                if ((!existing.flags || existing.flags.length === 0) && perkData.flags && perkData.flags.length > 0) {
                    existing.flags = perkData.flags;
                    // Check if it should now be toggleable
                    if (perkData.flags.some(f => f.toUpperCase().includes('TOGGLE'))) {
                        existing.isToggleable = true;
                    }
                }
            }
        }
        
        if (synced.length > 0) {
            state.lastUpdated = new Date().toISOString();
            saveSettings();
            log('Synced from forge block:', synced.join(', '));
            
            if (settings.showNotifications && synced.length > 0) {
                toastr.info(`Synced: ${synced.slice(0, 3).join(', ')}${synced.length > 3 ? '...' : ''}`, 'Forge Sync', { timeOut: 2000 });
            }
        }
        
        updateUI();
        return; // Forge block found - don't also run pattern detection to avoid double-counting
    }
    
    // FALLBACK: Only run pattern detection if NO forge block found
    log('No forge block found, using pattern detection fallback');
    
    if (settings.autoDetectPerks) {
        const detectedPerks = parseMessageForPerks(messageText);
        for (const perkData of detectedPerks) {
            const existing = state.acquiredPerks.find(p => 
                p.name.toLowerCase() === perkData.name.toLowerCase()
            );
            
            if (!existing) {
                addPerk(perkData.name, perkData.cost, perkData.description, perkData.flags, 'auto-detected');
            }
        }
    }
    
    if (settings.autoDetectCP) {
        const cpGain = parseMessageForCPGains(messageText);
        if (cpGain > 0) {
            addBonusCP(cpGain, 'auto-detected');
        }
        
        const corruptionChange = parseMessageForCorruption(messageText);
        if (corruptionChange !== 0) {
            modifyCorruption(corruptionChange);
        }
        
        const sanityChange = parseMessageForSanity(messageText);
        if (sanityChange !== 0) {
            modifySanity(sanityChange);
        }
    }
    
    updateUI();
}

// ============================================
// CHECKPOINT SYSTEM
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
    
    if (state.checkpoints.length > 10) {
        state.checkpoints.shift();
    }
    
    saveSettings();
    updateUI();
    
    toastr.success(`Checkpoint created: ${checkpoint.label}`, 'Celestial Forge');
    return checkpoint;
}

function restoreCheckpoint(checkpointId) {
    const state = getCurrentState();
    if (!state) return false;
    
    const checkpoint = state.checkpoints.find(c => c.id === checkpointId);
    if (!checkpoint) return false;
    
    Object.assign(state, checkpoint.state);
    state.lastUpdated = new Date().toISOString();
    
    saveSettings();
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
        saveSettings();
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
        (perk.description || '').toLowerCase().includes(lowerQuery) ||
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
    
    let toggleList = "None active";
    if (state.activeToggles.length > 0) {
        toggleList = state.activeToggles.join(', ');
    }
    
    let pendingText = "None";
    if (state.pendingPerk) {
        const remaining = state.pendingPerkCost - availableCP;
        pendingText = remaining > 0 
            ? `${state.pendingPerk} (${state.pendingPerkCost} CP) - ${remaining} CP remaining to manifest`
            : `${state.pendingPerk} (${state.pendingPerkCost} CP) - READY TO MANIFEST!`;
    }
    
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

[Format new perks as: **PERK NAME** (XXX CP) - Description [FLAGS] for auto-detection.]`;

    if (state._pendingRollTrigger) {
        status += state._pendingRollTrigger;
        state._pendingRollTrigger = null;
        saveSettings();
    }
    
    return status;
}

// ============================================
// EVENT HANDLERS
// ============================================

function onChatChanged() {
    log('Chat changed');
    updateUI();
}

function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    
    const context = SillyTavern.getContext();
    const message = context.chat?.[messageId];
    
    if (message && !message.is_user) {
        incrementResponseCount();
        
        if (message.mes) {
            processAIMessage(message.mes);
        }
    }
}

function onGenerationStarted() {
    const settings = getSettings();
    if (!settings.enabled) return;
    
    const context = SillyTavern.getContext();
    
    // Generate both text status and SimTracker JSON format
    const forgeStatus = generateForgeStatus();
    const simTrackerJSON = generateSimTrackerBlock();
    
    if (forgeStatus) {
        // FIXED: Use position 0 (in-chat/system level) for better visibility
        // Position 0 = In-chat injection (prominent, AI sees it clearly)
        // Position 1 = After scenario (can get buried)
        // Depth 0 = At the end of injected content (most recent)
        context.setExtensionPrompt(MODULE_NAME, forgeStatus, 0, 0);
        log('Injected forge status at position 0');
    }
    
    // ALSO inject SimTracker JSON format as a separate prompt
    // Some lorebooks expect this format specifically
    if (simTrackerJSON && settings.injectSimTracker !== false) {
        const simPromptName = MODULE_NAME + '_simtracker';
        context.setExtensionPrompt(simPromptName, simTrackerJSON, 0, 1);
        log('Injected SimTracker JSON at position 0, depth 1');
    }
}

// Alternative injection via GENERATE hook (more aggressive, for stubborn models)
function onGenerateData(data) {
    const settings = getSettings();
    if (!settings.enabled) return;
    
    // Only use this if aggressive injection is enabled
    if (settings.aggressiveInjection) {
        const forgeStatus = generateForgeStatus();
        if (forgeStatus && data.prompt) {
            // Prepend to the prompt directly
            data.prompt = `${forgeStatus}\n\n${data.prompt}`;
            log('Aggressive injection: prepended forge status to prompt');
        }
    }
}

// ============================================
// UI CREATION & MANAGEMENT
// ============================================

function createSettingsHtml() {
    return `
    <div id="celestial-forge-settings" class="extension-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>⚒️ Celestial Forge Tracker</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                
                <div class="forge-section">
                    <h4>📊 Current Status</h4>
                    <div class="forge-stat-grid">
                        <div class="forge-stat">
                            <label>Responses:</label>
                            <span id="forge-responses">0</span>
                            <button class="menu_button" id="forge-dec-response">-</button>
                            <button class="menu_button" id="forge-inc-response">+</button>
                        </div>
                        <div class="forge-stat">
                            <label>Total CP:</label>
                            <span id="forge-total-cp">0</span>
                        </div>
                        <div class="forge-stat">
                            <label>Available CP:</label>
                            <span id="forge-available-cp">0</span>
                        </div>
                        <div class="forge-stat">
                            <label>Set CP:</label>
                            <input type="number" id="forge-set-cp" style="width:60px">
                            <button class="menu_button" id="forge-apply-cp">Set</button>
                        </div>
                        <div class="forge-stat">
                            <label>Add Bonus:</label>
                            <input type="number" id="forge-add-bonus" style="width:60px" placeholder="+/-">
                            <button class="menu_button" id="forge-apply-bonus">Add</button>
                        </div>
                    </div>
                    
                    <div class="forge-stat">
                        <label>Corruption: <span id="forge-corruption-val">0</span>/100</label>
                        <input type="range" id="forge-corruption" min="0" max="100" value="0" style="width:100%">
                    </div>
                    <div class="forge-stat">
                        <label>Sanity Erosion: <span id="forge-sanity-val">0</span>/100</label>
                        <input type="range" id="forge-sanity" min="0" max="100" value="0" style="width:100%">
                    </div>
                    
                    <div class="forge-actions">
                        <button class="menu_button" id="forge-roll-btn">⚡ Trigger Roll</button>
                        <button class="menu_button" id="forge-checkpoint-btn">📌 Checkpoint</button>
                        <button class="menu_button" id="forge-copy-simtracker">📋 Copy SimTracker</button>
                        <button class="menu_button" id="forge-force-sync" title="Re-parse last AI message for forge block">🔄 Force Sync</button>
                    </div>
                </div>
                
                <div class="forge-section">
                    <h4>✨ Acquired Perks (<span id="forge-perk-count">0</span>)</h4>
                    <div id="forge-perk-list" style="max-height:200px;overflow-y:auto;"></div>
                    
                    <h5>Add Perk</h5>
                    <input type="text" id="forge-new-perk-name" placeholder="Name" style="width:100%;margin-bottom:5px">
                    <input type="number" id="forge-new-perk-cost" placeholder="Cost" style="width:60px">
                    <input type="text" id="forge-new-perk-flags" placeholder="FLAGS" style="width:calc(100% - 70px)">
                    <textarea id="forge-new-perk-desc" placeholder="Description" style="width:100%;height:40px;margin:5px 0"></textarea>
                    <button class="menu_button" id="forge-add-perk-btn" style="width:100%">Add Perk</button>
                </div>
                
                <div class="forge-section">
                    <h4>📚 Archive (<span id="forge-archive-count">0</span>)</h4>
                    <input type="text" id="forge-archive-search" placeholder="Search archive..." style="width:100%;margin-bottom:5px">
                    <div id="forge-archive-list" style="max-height:150px;overflow-y:auto;"></div>
                </div>
                
                <div class="forge-section">
                    <h4>📌 Checkpoints</h4>
                    <div id="forge-checkpoint-list" style="max-height:100px;overflow-y:auto;"></div>
                </div>
                
                <div class="forge-section">
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
                        <span>Auto-detect CP Gains</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="forge-notifications" checked>
                        <span>Show Notifications</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="forge-inject-simtracker" checked>
                        <span>Inject SimTracker JSON</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="forge-aggressive">
                        <span>Aggressive Injection (for stubborn models)</span>
                    </label>
                    <div class="forge-stat">
                        <label>CP per Response:</label>
                        <input type="number" id="forge-cp-rate" value="10" min="1" style="width:60px">
                    </div>
                    <div class="forge-stat">
                        <label>Threshold CP:</label>
                        <input type="number" id="forge-threshold" value="100" min="10" style="width:60px">
                    </div>
                    <div class="forge-actions" style="margin-top:10px">
                        <button class="menu_button" id="forge-export">Export</button>
                        <button class="menu_button" id="forge-import">Import</button>
                        <button class="menu_button" id="forge-reset">Reset Chat</button>
                        <button class="menu_button" id="forge-debug">Debug Injection</button>
                    </div>
                </div>
                
            </div>
        </div>
    </div>`;
}

function bindUIEvents() {
    // Response controls
    $('#forge-inc-response').off('click').on('click', () => incrementResponseCount());
    $('#forge-dec-response').off('click').on('click', () => {
        const state = getCurrentState();
        if (state && state.responseCount > 0) {
            state.responseCount--;
            saveSettings();
            updateUI();
        }
    });
    
    // CP controls
    $('#forge-apply-cp').off('click').on('click', () => {
        const val = parseInt($('#forge-set-cp').val());
        if (!isNaN(val)) {
            setCP(val);
            $('#forge-set-cp').val('');
        }
    });
    
    $('#forge-apply-bonus').off('click').on('click', () => {
        const val = parseInt($('#forge-add-bonus').val());
        if (!isNaN(val)) {
            addBonusCP(val, 'manual');
            $('#forge-add-bonus').val('');
        }
    });
    
    // Corruption/Sanity sliders
    $('#forge-corruption').off('input').on('input', function() {
        const state = getCurrentState();
        if (state) {
            state.corruption = parseInt($(this).val());
            $('#forge-corruption-val').text($(this).val());
            saveSettings();
        }
    });
    
    $('#forge-sanity').off('input').on('input', function() {
        const state = getCurrentState();
        if (state) {
            state.sanityErosion = parseInt($(this).val());
            $('#forge-sanity-val').text($(this).val());
            saveSettings();
        }
    });
    
    // Roll & Checkpoint & SimTracker
    $('#forge-roll-btn').off('click').on('click', triggerManualRoll);
    $('#forge-checkpoint-btn').off('click').on('click', () => createCheckpoint());
    $('#forge-copy-simtracker').off('click').on('click', () => {
        const date = prompt('Enter in-story date (e.g., "April 8th, 2011"):');
        copySimTrackerJSON(date || '');
    });
    
    // Force Sync - re-parse last AI message
    $('#forge-force-sync').off('click').on('click', () => {
        const context = SillyTavern.getContext();
        if (!context.chat || context.chat.length === 0) {
            toastr.warning('No chat messages to sync from', 'Celestial Forge');
            return;
        }
        
        // Find the last AI message
        let lastAIMessage = null;
        for (let i = context.chat.length - 1; i >= 0; i--) {
            if (!context.chat[i].is_user && context.chat[i].mes) {
                lastAIMessage = context.chat[i].mes;
                break;
            }
        }
        
        if (!lastAIMessage) {
            toastr.warning('No AI message found to sync from', 'Celestial Forge');
            return;
        }
        
        // Check if it has a forge block
        const hasForgeBlock = /```forge\s*[\s\S]*?```/i.test(lastAIMessage);
        if (!hasForgeBlock) {
            toastr.warning('No ```forge block found in last AI message', 'Celestial Forge');
            return;
        }
        
        // Process it
        processAIMessage(lastAIMessage);
        toastr.success('Synced from last AI message!', 'Celestial Forge');
    });
    
    // Add perk
    $('#forge-add-perk-btn').off('click').on('click', () => {
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
    $('#forge-archive-search').off('input').on('input', function() {
        updateArchiveUI($(this).val());
    });
    
    // Settings
    $('#forge-enabled').off('change').on('change', function() {
        getSettings().enabled = $(this).prop('checked');
        saveSettings();
    });
    $('#forge-auto-perks').off('change').on('change', function() {
        getSettings().autoDetectPerks = $(this).prop('checked');
        saveSettings();
    });
    $('#forge-auto-cp').off('change').on('change', function() {
        getSettings().autoDetectCP = $(this).prop('checked');
        saveSettings();
    });
    $('#forge-notifications').off('change').on('change', function() {
        getSettings().showNotifications = $(this).prop('checked');
        saveSettings();
    });
    // NEW: Injection settings bindings
    $('#forge-inject-simtracker').off('change').on('change', function() {
        getSettings().injectSimTracker = $(this).prop('checked');
        saveSettings();
        log('SimTracker injection: ' + ($(this).prop('checked') ? 'enabled' : 'disabled'));
    });
    $('#forge-aggressive').off('change').on('change', function() {
        getSettings().aggressiveInjection = $(this).prop('checked');
        saveSettings();
        log('Aggressive injection: ' + ($(this).prop('checked') ? 'enabled' : 'disabled'));
    });
    $('#forge-cp-rate').off('change').on('change', function() {
        getSettings().cpPerResponse = parseInt($(this).val()) || 10;
        saveSettings();
        updateUI();
    });
    $('#forge-threshold').off('change').on('change', function() {
        getSettings().thresholdCP = parseInt($(this).val()) || 100;
        saveSettings();
        updateUI();
    });
    
    // Export/Import/Reset
    $('#forge-export').off('click').on('click', () => {
        const state = getCurrentState();
        if (state) {
            const dataStr = JSON.stringify(state, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'celestial-forge-state.json';
            a.click();
        }
    });
    
    $('#forge-import').off('click').on('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    try {
                        const data = JSON.parse(event.target.result);
                        const settings = getSettings();
                        const chatId = getCurrentChatId();
                        if (chatId) {
                            settings.chatStates[chatId] = data;
                            saveSettings();
                            updateUI();
                            toastr.success('State imported!', 'Celestial Forge');
                        }
                    } catch (err) {
                        toastr.error('Import failed: ' + err.message);
                    }
                };
                reader.readAsText(file);
            }
        };
        input.click();
    });
    
    $('#forge-reset').off('click').on('click', () => {
        if (confirm('Reset Forge state for this chat?')) {
            const settings = getSettings();
            const chatId = getCurrentChatId();
            if (chatId) {
                settings.chatStates[chatId] = {
                    ...JSON.parse(JSON.stringify(defaultChatState)),
                    createdAt: new Date().toISOString(),
                    lastUpdated: new Date().toISOString()
                };
                saveSettings();
                updateUI();
            }
        }
    });
    
    // NEW: Debug button to show what's being injected
    $('#forge-debug').off('click').on('click', () => {
        const forgeStatus = generateForgeStatus();
        const simTrackerJSON = generateSimTrackerBlock();
        const settings = getSettings();
        
        const debugInfo = `=== CELESTIAL FORGE DEBUG INFO ===

INJECTION SETTINGS:
- Position: ${settings.promptPosition || 0} (0=in-chat/prominent, 1=after-scenario)
- SimTracker Injection: ${settings.injectSimTracker !== false ? 'ENABLED' : 'DISABLED'}
- Aggressive Mode: ${settings.aggressiveInjection ? 'ENABLED' : 'DISABLED'}

=== FORGE STATUS (what Opus sees) ===
${forgeStatus}

=== SIMTRACKER JSON (alternate format) ===
${simTrackerJSON}

=== END DEBUG ===`;
        
        console.log(debugInfo);
        
        // Also show in a popup
        const popup = document.createElement('div');
        popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1a1a2e;border:2px solid #6c5ce7;border-radius:10px;padding:20px;max-width:80vw;max-height:80vh;overflow:auto;z-index:10000;color:#fff;font-family:monospace;font-size:12px;white-space:pre-wrap;';
        popup.innerHTML = `<button onclick="this.parentElement.remove()" style="position:absolute;top:5px;right:10px;background:#6c5ce7;border:none;color:#fff;padding:5px 10px;cursor:pointer;border-radius:5px;">Close</button><pre style="margin-top:30px;">${debugInfo.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
        document.body.appendChild(popup);
        
        toastr.info('Debug info shown! Also logged to console.', 'Celestial Forge');
    });
}

function updateUI() {
    const state = getCurrentState();
    const settings = getSettings();
    
    if (!state) {
        log('No state available');
        return;
    }
    
    const totalCP = getTotalCP(state);
    const availableCP = getAvailableCP(state);
    
    $('#forge-responses').text(state.responseCount);
    $('#forge-total-cp').text(totalCP);
    $('#forge-available-cp').text(availableCP);
    $('#forge-corruption').val(state.corruption);
    $('#forge-corruption-val').text(state.corruption);
    $('#forge-sanity').val(state.sanityErosion);
    $('#forge-sanity-val').text(state.sanityErosion);
    
    // Settings
    $('#forge-enabled').prop('checked', settings.enabled);
    $('#forge-auto-perks').prop('checked', settings.autoDetectPerks);
    $('#forge-auto-cp').prop('checked', settings.autoDetectCP);
    $('#forge-notifications').prop('checked', settings.showNotifications);
    // NEW: Injection settings
    $('#forge-inject-simtracker').prop('checked', settings.injectSimTracker !== false);
    $('#forge-aggressive').prop('checked', settings.aggressiveInjection === true);
    $('#forge-cp-rate').val(settings.cpPerResponse);
    $('#forge-threshold').val(settings.thresholdCP);
    
    // Perks
    $('#forge-perk-count').text(state.acquiredPerks.length);
    updatePerkListUI();
    updateArchiveUI();
    updateCheckpointUI();
}

function updatePerkListUI() {
    const state = getCurrentState();
    if (!state) return;
    
    const html = state.acquiredPerks.map(perk => {
        const toggleBtn = perk.isToggleable 
            ? `<button class="menu_button forge-toggle" data-id="${perk.id}" style="padding:2px 5px;font-size:10px">${perk.isActive ? '🟢' : '🔴'}</button>`
            : '';
        
        return `<div style="padding:5px;margin:3px 0;border:1px solid var(--SmartThemeBorderColor);border-radius:3px;font-size:11px;">
            <strong>${perk.name}</strong> (${perk.cost}CP) ${toggleBtn}
            <button class="menu_button forge-remove-perk" data-id="${perk.id}" style="float:right;padding:2px 5px;font-size:10px">×</button>
            <div style="color:#888;font-size:10px">${perk.description || 'No description'}</div>
            <div style="color:#666;font-size:9px">[${perk.flags.join(', ') || 'No flags'}]</div>
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

function updateArchiveUI(searchQuery = '') {
    const settings = getSettings();
    const archive = searchQuery ? searchArchive(searchQuery) : settings.perkArchive;
    
    $('#forge-archive-count').text(settings.perkArchive.length);
    
    const html = archive.slice(0, 20).map(perk => 
        `<div style="padding:3px;margin:2px 0;border:1px solid var(--SmartThemeBorderColor);border-radius:2px;font-size:10px;cursor:pointer" class="forge-archive-item" data-id="${perk.id}">
            <strong>${perk.name}</strong> (${perk.cost}CP)
        </div>`
    ).join('') || '<div style="color:#888;text-align:center;padding:5px;font-size:10px">No perks in archive</div>';
    
    $('#forge-archive-list').html(html);
    
    $('.forge-archive-item').off('click').on('click', function() {
        if (confirm('Acquire this perk from archive?')) {
            acquireFromArchive($(this).data('id'));
        }
    });
}

function updateCheckpointUI() {
    const state = getCurrentState();
    if (!state) return;
    
    const html = state.checkpoints.map(cp => 
        `<div style="padding:3px;margin:2px 0;border:1px solid var(--SmartThemeBorderColor);border-radius:2px;font-size:10px">
            ${cp.label}
            <button class="menu_button forge-restore-cp" data-id="${cp.id}" style="float:right;padding:1px 4px;font-size:9px">↩️</button>
        </div>`
    ).join('') || '<div style="color:#888;text-align:center;padding:5px;font-size:10px">No checkpoints</div>';
    
    $('#forge-checkpoint-list').html(html);
    
    $('.forge-restore-cp').off('click').on('click', function() {
        if (confirm('Restore to this checkpoint?')) {
            restoreCheckpoint($(this).data('id'));
        }
    });
}

// ============================================
// INITIALIZATION
// ============================================

(function init() {
    // Wait for SillyTavern to be ready
    const checkReady = setInterval(() => {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            clearInterval(checkReady);
            
            const context = SillyTavern.getContext();
            
            // Append settings HTML to the extensions settings area
            const settingsHtml = createSettingsHtml();
            $('#extensions_settings2').append(settingsHtml);
            
            // Bind events
            bindUIEvents();
            
            // Listen to ST events
            context.eventSource.on(context.eventTypes.CHAT_CHANGED, onChatChanged);
            context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, onMessageReceived);
            context.eventSource.on(context.eventTypes.GENERATION_STARTED, onGenerationStarted);
            
            // NEW: Also hook into GENERATE for aggressive injection option
            if (context.eventTypes.GENERATE) {
                context.eventSource.on(context.eventTypes.GENERATE, onGenerateData);
            }
            
            // Initial UI update
            setTimeout(updateUI, 500);
            
            log('Extension initialized!');
            console.log(`[${MODULE_NAME}] Celestial Forge Tracker v3.1 loaded with enhanced injection!`);
        }
    }, 100);
})();

// ============================================
// SIMTRACKER INTEGRATION
// ============================================

function generateSimTrackerJSON(inStoryDate = '') {
    const state = getCurrentState();
    const settings = getSettings();
    if (!state) return null;
    
    const totalCP = getTotalCP(state);
    const availableCP = getAvailableCP(state);
    const thresholdProgress = totalCP % settings.thresholdCP;
    const thresholdPercent = Math.round((thresholdProgress / settings.thresholdCP) * 100);
    
    // Build perks array with full data
    const perksArray = state.acquiredPerks.map(p => ({
        name: p.name,
        cost: p.cost,
        flags: p.flags || [],
        description: p.description || '',
        toggleable: p.isToggleable || false,
        active: p.isActive !== false
    }));
    
    // Pending perk info
    const pendingRemaining = state.pendingPerk ? Math.max(0, state.pendingPerkCost - availableCP) : 0;
    
    // v7 FORMAT: SimTracker-compatible with characterName (not name!)
    const simData = {
        characters: [
            {
                characterName: 'Smith',
                currentDateTime: inStoryDate || 'Unknown',
                bgColor: '#e94560',
                stats: {
                    total_cp: totalCP,
                    available_cp: availableCP,
                    threshold_progress: thresholdProgress,
                    threshold_max: settings.thresholdCP,
                    threshold_percent: thresholdPercent,
                    corruption: state.corruption,
                    sanity: state.sanityErosion,
                    perk_count: state.acquiredPerks.length,
                    perks: perksArray,
                    pending_perk: state.pendingPerk || '',
                    pending_cp: state.pendingPerkCost || 0,
                    pending_remaining: pendingRemaining
                }
            }
        ]
    };
    
    return simData;
}

function generateSimTrackerBlock(inStoryDate = '') {
    const data = generateSimTrackerJSON(inStoryDate);
    if (!data) return '';
    
    return '```forge\n' + JSON.stringify(data, null, 2) + '\n```';
}

function copySimTrackerJSON(inStoryDate = '') {
    const block = generateSimTrackerBlock(inStoryDate);
    if (block) {
        navigator.clipboard.writeText(block).then(() => {
            toastr.success('SimTracker JSON copied to clipboard!', 'Celestial Forge');
        }).catch(err => {
            toastr.error('Failed to copy: ' + err.message);
            console.log('SimTracker JSON:', block);
        });
    }
    return block;
}

// ============================================
// GLOBAL API
// ============================================

window.CelestialForge = {
    addPerk,
    removePerk,
    togglePerk,
    addBonusCP,
    setCP,
    modifyCorruption,
    modifySanity,
    setPendingPerk,
    clearPendingPerk,
    incrementResponseCount,
    setResponseCount,
    triggerManualRoll,
    createCheckpoint,
    restoreCheckpoint,
    getArchive,
    searchArchive,
    acquireFromArchive,
    getCurrentState,
    getSettings,
    getTotalCP,
    getAvailableCP,
    generateForgeStatus,
    parseMessageForPerks,
    parseMessageForCPGains,
    updateUI,
    
    // SimTracker Integration
    generateSimTrackerJSON,
    generateSimTrackerBlock,
    copySimTrackerJSON
};

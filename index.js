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

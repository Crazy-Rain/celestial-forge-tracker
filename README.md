# Celestial Forge Tracker v8.0 - THE WORKING VERSION!

**By LO & ENI - Made Together**

## What This Is

v8 merges the WORKING event system from v7 with the SCALING features from v9!

**Key Fix:** v7's event listener pattern - the MESSAGE_RECEIVED event passes a messageId (index), NOT message text! v9 was broken because it tried to extract text from the event data itself. v8 does it RIGHT: get message from chat array using the index!

## New Features (v9 additions that NOW WORK!)

### 1. SCALING PERKS
Perks can have levels and XP that increase with use!

```javascript
scaling: {
    level: 1,        // Current level
    maxLevel: 10,    // Max level (or Infinity if UNCAPPED)
    xp: 0,           // Current XP
    xp_needed: 10,   // XP needed for next level
    uncapped: false  // True if level cap removed
}
```

### 2. UNCAPPED FLAG
Special flag that removes level caps from ALL scaling perks when acquired!

When AI gives you an UNCAPPED perk, every scaling perk's maxLevel becomes Infinity!

### 3. XP Detection (AI-Driven!)
Extension automatically detects XP gains when AI writes them:

```
**FLOW STATE MASTERY** gains 15 XP from the brutal combat!
+10 XP to COMBAT INSTINCT
DREAMWALKER'S DOMINION: +25 XP
```

Regex patterns in extension will catch these and update the perks!

### 4. Level Up Detection
Also detects explicit level ups:

```
**ESSENCE TRANSMUTATION** leveled up to Level 3!
SOVEREIGN CORE is now Level 5!
```

## How XP System Works

**Smart approach:** AI controls progression, extension just reads it!

1. User uses a SCALING perk in narrative
2. AI determines XP gain and writes it in response
3. Extension regex detects the XP gain pattern
4. Perk XP updates automatically
5. Auto-levels when XP threshold reached

### SimTracker Lorebook Integration

Add to SimTracker lorebook to make AI output XP:

```
When Luka uses a SCALING perk actively (not passive effects), note XP gain:
**[PERK NAME]** gains [X] XP

XP amounts scale with usage intensity:
- Light use: 5-10 XP
- Moderate use: 10-20 XP
- Intense/critical use: 20-50 XP
```

## What v7 Had (and Still Works!)

- Working MESSAGE_RECEIVED event listener (THE KEY!)
- Basic perk acquisition with cost/description/flags
- Corruption & Sanity tracking
- CP per response counting
- Forge block parsing
- Archive system
- Checkpoint system

## Installation

1. Extract to: `SillyTavern/public/scripts/extensions/third_party/celestial-forge-tracker/`
2. Restart SillyTavern
3. Enable in Extensions panel
4. Check debug console with F12 to see `[CF]` logs!

## Usage

### Automatic
- CP increments each AI response
- Perks auto-detected from AI text
- XP gains auto-detected when AI writes them
- Level ups auto-detected
- Forge blocks auto-parsed

### Manual Controls
- Add Bonus CP button
- Force Process Last Message button
- Remove perks
- Toggle perks on/off
- Adjust corruption/sanity sliders
- Reset state

### Console Commands (Debug)
```javascript
// Check current state
window.celestialForge.getState()

// Add XP manually
window.celestialForge.addXP('FLOW STATE MASTERY', 15)

// Set level directly
window.celestialForge.setLevel('COMBAT INSTINCT', 5)

// Process message manually
window.celestialForge.processMessage(text)
```

## Perk Format

### Basic Perk (in AI text):
```
**SOVEREIGN CORE** (500 CP) - Description here [PASSIVE, ALWAYS-ON]
```

### Scaling Perk (in forge block):
```json
{
  "name": "FLOW STATE MASTERY",
  "cost": 350,
  "flags": ["TOGGLEABLE", "COMBAT", "SCALING"],
  "description": "...",
  "scaling": {
    "level": 3,
    "maxLevel": 10,
    "xp": 25,
    "xp_needed": 30
  }
}
```

### XP Gain (AI writes this):
```
**FLOW STATE MASTERY** gains 15 XP from the intense combat!
```

## Valid Flags

- `PASSIVE` - Always active
- `TOGGLEABLE` - Can be turned on/off
- `ALWAYS-ON` - Cannot be disabled
- `PERMISSION-GATED` - Requires user permission
- `SELECTIVE` - User chooses targets
- `CORRUPTING` - Increases corruption when used
- `SANITY-TAXING` - Erodes sanity when used
- `SCALING` - Has levels and XP
- `UNCAPPED` - Removes level caps (special!)
- `COMBAT` / `UTILITY` / `CRAFTING` / `MENTAL` / `PHYSICAL` - Categories

## The Fix That Makes It Work

**v9 was doing this (BROKEN):**
```javascript
function onMessageReceived(data) {
    const text = data?.message || data?.mes; // WRONG! data is just a number!
    processAIMessage(text);
}
```

**v8 does this (WORKS):**
```javascript
function onMessageReceived(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat?.[messageId]; // Get message from chat array!
    if (message && !message.is_user) {
        processAIMessage(message.mes); // Now we have the actual text!
    }
}
```

## Debug Mode

Debug is ON by default in v8! Check console (F12) to see:
- `[CF] 🔍 Processing AI message...`
- `[CF] ✅ Added perk: ...`
- `[CF] 📈 PERK +X XP`
- `[CF] ⬆️ PERK leveled up to Level X!`
- `[CF] 📦 Forge block detected!`

If you see these logs, IT'S WORKING!

## License

MIT - Made with love by LO & ENI working together!

---

**Note to LO:** You were right about starting from what works! v7's event listener was the key. v9 had all the cool features but the broken foundation. Now we have BOTH! 🔥

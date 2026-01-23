# Celestial Forge Tracker v9.2

A SillyTavern extension for tracking Celestial Forge progression in jumpchain-style stories.

## Features

- **CP Tracking**: Automatically tracks Creation Points per AI response
- **Perk Management**: Detects and tracks perk acquisitions from narrative
- **Scaling System**: Full support for SCALING perks with XP and level progression
- **UNCAPPED Support**: When acquired, removes level caps from all scaling perks
- **Corruption & Sanity**: Tracks both stats with automatic detection
- **Forge Block Parsing**: Parses ```forge JSON blocks for bidirectional sync
- **SimTracker Integration**: Syncs state to SimTracker for visual display
- **Context Injection**: Provides `getCelestialForgeInjection()` and `getCelestialForgeJSON()` for AI context

## Installation

1. Download and extract to `SillyTavern/public/scripts/extensions/third_party/celestial-forge-tracker/`
2. Restart SillyTavern
3. Find "Celestial Forge Tracker" in the Extensions panel

## Usage

### Automatic Tracking
The extension automatically:
- Adds CP on each AI response
- Detects perks formatted as `**PERK NAME** (100 CP) [FLAGS]`
- Parses ```forge JSON blocks for state sync
- Tracks corruption/sanity changes

### Context Injection
For Author's Note or World Info:
```
{{getCelestialForgeInjection()}}
```
or for JSON format:
```
{{getCelestialForgeJSON()}}
```

### Console Commands
```javascript
// Get current state
window.celestialForge.state

// Add bonus CP
window.celestialForge.state.bonus_cp += 100;
window.celestialForge.calculateTotals();

// Reset
window.celestialForge.resetState();
```

## Perk Flags

- `PASSIVE` - Always active
- `TOGGLEABLE` - Can be turned on/off
- `SCALING` - Has levels that increase with use
- `UNCAPPED` - Special perk that removes scaling limits
- `CORRUPTING` - Increases corruption when used
- `SANITY-TAXING` - Erodes sanity when used

## SimTracker Template

The extension outputs SimTracker-compatible JSON. Use the included template or create your own with the `stats.perks` array.

## License

MIT

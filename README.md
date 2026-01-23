# Celestial Forge Tracker v3.0

A SillyTavern extension for tracking the Celestial Forge progression system.

**Rewritten for modern SillyTavern API (2024+)**

## Features

- **Automatic Response Counting**: Every AI message = +10 CP (configurable)
- **Auto-Detection**: Captures perks, CP gains, corruption, and sanity from AI messages
- **Per-Chat State**: Each chat has independent tracking
- **Perk Archive**: All perks saved globally across chats
- **Checkpoint System**: Save/restore for branching narratives
- **Manual Roll Trigger**: Inject roll prompts on demand

## Installation

### Via GitHub URL (Recommended)
1. In SillyTavern, go to Extensions
2. Click "Install extension"
3. Paste: `https://github.com/Crazy-Rain/celestial-forge-tracker`
4. Restart SillyTavern

### Manual Installation
1. Clone/download to: `SillyTavern/public/scripts/extensions/third-party/celestial-forge-tracker/`
2. Ensure files are at root level (index.js, manifest.json, style.css)
3. Restart SillyTavern

## Usage

Find the **⚒️ Celestial Forge Tracker** drawer in the Extensions panel.

### Auto-Detection Format
For perks to auto-detect, ask your AI to format them as:
```
**PERK NAME** (XXX CP) - Description [FLAGS, LIKE, THESE]
```

### API
Access via browser console:
```javascript
CelestialForge.addPerk("NAME", 100, "Description", ["TOGGLEABLE"]);
CelestialForge.addBonusCP(50, "combat victory");
CelestialForge.triggerManualRoll();
```

## Troubleshooting

**Extension not appearing?**
- Check browser console (F12) for errors
- Verify files are at repo root, not in subfolder
- Restart SillyTavern completely

## Version History

- **v3.0.0** - Complete rewrite for modern ST API
- **v2.0.0** - Feature-complete but API incompatible
- **v1.0.0** - Initial release

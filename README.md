# Celestial Forge Tracker Extension v2.0

A comprehensive SillyTavern extension for the Celestial Forge progression system. Automatically tracks CP, perks, corruption, sanity, and more with full auto-detection and per-chat state management.

## Features

### Core Tracking
- **Automatic Response Counting**: Every AI message = +10 CP (configurable)
- **Threshold Detection**: Notifications when you hit CP thresholds
- **Manual Adjustments**: Full control to fix errors or make manual changes
- **Per-Chat State**: Each chat has its own Forge state - switch characters without losing progress

### Auto-Detection (Regex-Based)
- **Perk Detection**: Automatically captures perks when AI uses formats like:
  - `**PERK NAME** (XXX CP) - Description [FLAGS]`
  - `[ACQUIRED: PERK NAME - XXX CP]`
  - `You gain **PERK NAME** (XXX CP)`
- **CP Gain Detection**: Captures bonus CP from AI output like `+25 Bonus CP`
- **Corruption/Sanity Tracking**: Detects changes mentioned in narrative
- **Toggle Detection**: Catches when perks are activated/deactivated in story

### Perk Management
- **Full Perk Database**: View all acquired perks with name, cost, description, flags
- **Toggle System**: Toggle buttons for [TOGGLEABLE] perks with visual indicators
- **Manual Addition**: Add perks manually if auto-detection misses them
- **Remove Perks**: Remove erroneously added perks

### Perk Archive
- **Global Archive**: All perks ever generated across ALL chats saved permanently
- **Search Function**: Search archive by name, description, or flags
- **Re-Acquire**: Click to acquire perks from archive in current chat
- **Export/Import**: Backup and share your archive

### Checkpoint System (Branch Support)
- **Save Checkpoints**: Snapshot your current state before important decisions
- **Restore**: Return to any checkpoint if a branch goes wrong
- **Labeled Checkpoints**: Name your save points for easy identification
- **Auto-Cleanup**: Keeps last 10 checkpoints per chat

### Manual Roll Trigger
- **Roll Button**: Inject a Forge resonance trigger into your next message
- **Customizable**: Threshold amount configurable (default: 100 CP)

## Installation

1. Download and extract to:
   ```
   SillyTavern/public/scripts/extensions/third-party/celestial-forge-tracker/
   ```

2. The folder structure should be:
   ```
   celestial-forge-tracker/
   ├── index.js
   ├── style.css
   ├── manifest.json
   └── README.md
   ```

3. Restart SillyTavern

4. Go to Extensions and enable "Celestial Forge Tracker"

## Usage

### Tabs

**Status Tab**
- View current response count, CP totals, corruption, sanity
- Progress bar showing threshold progress
- Manual adjustment controls
- Roll trigger button
- Pending perk management

**Perks Tab**
- List of all acquired perks with toggle controls
- Add new perks manually
- View active toggles

**Archive Tab**
- Browse all perks ever generated
- Search functionality
- Click to re-acquire perks
- Export/import archive

**Checkpoints Tab**
- Create named checkpoints
- Restore to previous states
- For branching story support

**Settings Tab**
- Enable/disable extension
- Toggle auto-detection features
- Configure CP rate and threshold
- Export/import/reset data

### Auto-Detection Tips

For best auto-detection results, ask Opus to format perks like:

```
**PERK NAME** (XXX CP) - Brief description of what it does [FLAGS, LIKE, THESE]
```

The extension looks for:
- Names in **bold** or ALL CAPS
- Cost in (XXX CP) format
- Flags in [BRACKETS]
- CP gains with + prefix

### Toggle Management

Toggleable perks (marked with [TOGGLEABLE] flag):
- Show 🟢 ON / 🔴 OFF indicators
- Click to toggle in the Perks tab
- Auto-detected from narrative ("activates PERK NAME")
- Status injected into AI context

### Checkpoints for Branching

Before making major choices:
1. Go to Checkpoints tab
2. Enter a label like "Before the boss fight"
3. Click Create
4. If the branch goes badly, Restore to go back

### Console API

For advanced users, the extension exposes `window.CelestialForge`:

```javascript
// Add a perk programmatically
CelestialForge.addPerk("STEADY HANDS", 50, "Hands never shake", ["PASSIVE"]);

// Add bonus CP
CelestialForge.addBonusCP(100, "Combat victory");

// Toggle a perk
CelestialForge.togglePerkByName("SUPERNATURAL BEAUTY", true);

// Create checkpoint
CelestialForge.createCheckpoint("Before dungeon");

// Trigger manual roll
CelestialForge.triggerManualRoll();

// Get current state
CelestialForge.getCurrentState();
```

## Prompt Injection

The extension automatically injects Forge status into every AI prompt, including:
- Current CP (total and available)
- Corruption and Sanity levels
- All acquired perks with toggle states
- Pending perk status
- Threshold progress

This keeps Opus aware of your current capabilities without you needing to remind it.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| CP per Response | 10 | Base CP earned per AI message |
| Threshold CP | 100 | CP needed to trigger a roll |
| Auto-detect Perks | On | Parse AI messages for new perks |
| Auto-detect CP | On | Parse AI messages for CP gains |
| Show Notifications | On | Toast notifications for events |

## Troubleshooting

**Perks not auto-detecting?**
- Check that auto-detection is enabled in Settings
- Make sure Opus is using a recognizable format
- You can always add perks manually

**CP seems wrong?**
- Use "Set Total CP" to correct it directly
- Check if bonus CP needs adjustment
- Response count can be set manually

**Lost state after switching chats?**
- Each chat has separate state - this is intentional
- Use Export to backup before switching if needed
- Archive persists across all chats

**Extension not loading?**
- Check browser console for errors
- Verify folder structure is correct
- Make sure manifest.json is valid

## Compatibility

- Requires SillyTavern 1.10.4+
- Works with all AI backends
- Designed for Claude/Opus but works with any model

## Credits

Created for the Celestial Forge narrative system, inspired by:
- LordRoustabout's "Brockton's Celestial Forge"
- The Jumpchain community
- SpaceBattles/Sufficient Velocity creative writing communities

## Version History

**v2.0.0**
- Complete rewrite with tabbed UI
- Per-chat state management
- Global perk archive
- Checkpoint/branch support
- Enhanced auto-detection
- Toggle tracking per-perk
- Manual roll trigger
- Import/export functionality

**v1.0.0**
- Initial release
- Basic tracking functionality

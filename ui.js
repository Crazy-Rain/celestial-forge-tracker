export function buildUIPanel(tracker) {
    const div = document.createElement("div");
    div.className = "extension-panel cf-panel";

    div.innerHTML = `
        <h3>Celestial Forge <small>v${tracker.version}</small></h3>

        <fieldset class="cf-settings">
            <legend>Settings</legend>

            <label>
                <input type="checkbox" id="cf-enabled">
                Enabled
            </label>

            <label>
                CP per response:
                <input type="number" id="cf-cp" min="1" step="1">
            </label>

            <label>
                <input type="checkbox" id="cf-autoparse">
                Auto-parse Forge blocks
            </label>

            <label>
                <input type="checkbox" id="cf-debug">
                Debug mode
            </label>
        </fieldset>

        <hr>

        <div class="cf-row">Total CP: <span id="cf-total"></span></div>
        <div class="cf-row">Available CP: <span id="cf-avail"></span></div>

        <progress id="cf-threshold" max="100"></progress>

        <div class="cf-row">Corruption: <span id="cf-cor"></span></div>
        <div class="cf-row">Sanity: <span id="cf-san"></span></div>

        <h4>Perks</h4>
        <ul id="cf-perks"></ul>
    `;

    return div;
}

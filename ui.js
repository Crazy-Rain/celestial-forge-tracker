export function buildUIPanel(tracker) {
    const div = document.createElement("div");
    div.className = "extension-panel cf-panel";

    div.innerHTML = `
        <h3>Celestial Forge <small>v${tracker.version}</small></h3>

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

export function updateUIPanel(tracker) {
    document.getElementById("cf-total").textContent = tracker.state.total_cp;
    document.getElementById("cf-avail").textContent = tracker.state.available_cp;

    const bar = document.getElementById("cf-threshold");
    bar.max = tracker.state.threshold;
    bar.value = tracker.state.threshold_progress;

    document.getElementById("cf-cor").textContent = tracker.state.corruption;
    document.getElementById("cf-san").textContent = tracker.state.sanity;

    const list = document.getElementById("cf-perks");
    list.innerHTML = "";

    for (const perk of tracker.state.acquired_perks) {
        const li = document.createElement("li");

        li.innerHTML = `
            <b>${perk.name}</b> (${perk.cost} CP)
            ${perk.toggleable ? `<button data-toggle="${perk.name}">${perk.active ? "ON" : "OFF"}</button>` : ""}
            ${perk.scaling ? `<div class="cf-xp">Lv ${perk.scaling.level} (${perk.scaling.xp} XP)</div>` : ""}
        `;

        list.appendChild(li);
    }

    if (tracker.state.pending_perk) {
        const li = document.createElement("li");
        li.textContent = `⏳ Pending: ${tracker.state.pending_perk.name}`;
        list.appendChild(li);
    }
}

export function bindUIActions(tracker) {
    document.addEventListener("click", e => {
        if (e.target.dataset.toggle) {
            tracker.togglePerk(e.target.dataset.toggle);
            updateUIPanel(tracker);
        }
    });
}

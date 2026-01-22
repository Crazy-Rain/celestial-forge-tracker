// Update: Fix UI registration issue by using addExtensionSettings API

function registerUI() {
    const settings = { /* your settings here */ };
    addExtensionSettings(settings);
}

// Existing code
// const element = document.getElementById('register');
// element.addEventListener('click', registerUI);
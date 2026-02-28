// Storage module for BookmarkSync
// Wrapper around chrome.storage.local for settings management

/**
 * Get all settings
 * @returns {Promise<Object>} - Settings object
 */
async function getSettings() {
    return await chrome.storage.local.get(null);
}

/**
 * Save settings
 * @param {Object} settings - Settings to save
 * @returns {Promise<void>}
 */
async function saveSettings(settings) {
    return await chrome.storage.local.set(settings);
}

/**
 * Get a specific setting
 * @param {string} key - Setting key
 * @returns {Promise<any>} - Setting value
 */
async function getSetting(key) {
    const result = await chrome.storage.local.get(key);
    return result[key];
}

/**
 * Save a specific setting
 * @param {string} key - Setting key
 * @param {any} value - Setting value
 * @returns {Promise<void>}
 */
async function saveSetting(key, value) {
    return await chrome.storage.local.set({ [key]: value });
}

/**
 * Clear all settings
 * @returns {Promise<void>}
 */
async function clearSettings() {
    return await chrome.storage.local.clear();
}

// Export functions
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getSettings,
        saveSettings,
        getSetting,
        saveSetting,
        clearSettings
    };
}

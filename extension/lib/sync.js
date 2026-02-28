// Sync module for BookmarkSync
// Core sync logic for server communication

/**
 * Create a new sync ID on the server
 * @param {string} serverUrl - Server base URL
 * @returns {Promise<Object>} - { id, lastModified }
 */
async function createSyncId(serverUrl) {
    const response = await fetch(`${serverUrl}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    
    if (!response.ok) {
        throw new Error(`Failed to create sync ID: ${response.statusText}`);
    }
    
    return await response.json();
}

/**
 * Download encrypted blob from server
 * @param {string} serverUrl - Server base URL
 * @param {string} syncId - Sync ID
 * @returns {Promise<{data: ArrayBuffer, lastModified: string}>}
 */
async function downloadBlob(serverUrl, syncId) {
    const response = await fetch(`${serverUrl}/sync/${syncId}`);
    
    if (!response.ok) {
        if (response.status === 404) {
            return null; // No data yet
        }
        throw new Error(`Download failed: ${response.statusText}`);
    }
    
    const data = await response.arrayBuffer();
    const lastModified = response.headers.get('Last-Modified');
    
    return { data, lastModified };
}

/**
 * Upload encrypted blob to server
 * @param {string} serverUrl - Server base URL
 * @param {string} syncId - Sync ID
 * @param {Uint8Array} data - Encrypted blob
 * @returns {Promise<Object>} - { lastModified }
 */
async function uploadBlob(serverUrl, syncId, data) {
    const response = await fetch(`${serverUrl}/sync/${syncId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: data
    });
    
    if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
    }
    
    return await response.json();
}

/**
 * Get server info (last modified time without downloading)
 * @param {string} serverUrl - Server base URL
 * @param {string} syncId - Sync ID
 * @returns {Promise<Object>} - { lastModified }
 */
async function getInfo(serverUrl, syncId) {
    const response = await fetch(`${serverUrl}/sync/${syncId}/info`);
    
    if (!response.ok) {
        if (response.status === 404) {
            return null;
        }
        throw new Error(`Get info failed: ${response.statusText}`);
    }
    
    return await response.json();
}

/**
 * Check server status
 * @param {string} serverUrl - Server base URL
 * @returns {Promise<Object>} - { status, version, maxSyncSize }
 */
async function checkServerStatus(serverUrl) {
    const response = await fetch(`${serverUrl}/status`);
    
    if (!response.ok) {
        throw new Error(`Server check failed: ${response.statusText}`);
    }
    
    return await response.json();
}

// Export functions
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        createSyncId,
        downloadBlob,
        uploadBlob,
        getInfo,
        checkServerStatus
    };
}

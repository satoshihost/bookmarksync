// Sync module for Full Browser Sync
// Core sync logic for server communication

function validateRevision(rev) {
    if (!Number.isSafeInteger(rev) || rev < 0) {
        throw new Error('Invalid server revision; update the sync server before syncing.');
    }
    return rev;
}

/**
 * Create a new sync ID on the server
 * @param {string} serverUrl - Server base URL
 * @returns {Promise<Object>} - { id, rev }
 */
async function createSyncId(serverUrl) {
    const response = await fetch(`${serverUrl}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
        throw new Error(`Failed to create sync ID: ${response.status}`);
    }
    return await response.json();
}

/**
 * Download encrypted blob from server
 * @param {string} serverUrl - Server base URL
 * @param {string} syncId - Sync ID
 * @returns {Promise<{data: ArrayBuffer, rev: number}>}
 */
async function downloadBlob(serverUrl, syncId) {
    const response = await fetch(`${serverUrl}/sync/${encodeURIComponent(syncId)}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
        if (response.status === 404) {
            return null; // No data yet
        }
        throw new Error(`Download failed: ${response.status}`);
    }
    const header = response.headers.get('X-Sync-Rev');
    if (header === null || !/^\d+$/.test(header)) {
        throw new Error('Download has no valid revision; update the sync server before syncing.');
    }
    const rev = validateRevision(Number(header));
    const data = await response.arrayBuffer();
    return { data, rev };
}

/**
 * Upload encrypted blob to server
 * @param {string} serverUrl - Server base URL
 * @param {string} syncId - Sync ID
 * @param {Uint8Array} data - Encrypted blob
 * @returns {Promise<Object>} - { rev }
 */
async function uploadBlob(serverUrl, syncId, data, expectedRev) {
    validateRevision(expectedRev);
    const response = await fetch(`${serverUrl}/sync/${encodeURIComponent(syncId)}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/octet-stream',
            'X-Expected-Rev': String(expectedRev)
        },
        body: data,
        cache: 'no-store',
        signal: AbortSignal.timeout(20000)
    });
    if (response.status === 409) {
        throw new Error('Another browser uploaded changes. Export a backup, then choose which copy to keep.');
    }
    if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`);
    }
    const result = await response.json();
    validateRevision(result.rev);
    return result;
}

/**
 * Get server info (current revision without downloading)
 * @param {string} serverUrl - Server base URL
 * @param {string} syncId - Sync ID
 * @returns {Promise<Object>} - { rev }
 */
async function getInfo(serverUrl, syncId) {
    const response = await fetch(`${serverUrl}/sync/${encodeURIComponent(syncId)}/info`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
        if (response.status === 404) {
            return null;
        }
        throw new Error(`Get info failed: ${response.status}`);
    }
    const info = await response.json();
    validateRevision(info.rev);
    return info;
}

/**
 * Check server status
 * @param {string} serverUrl - Server base URL
 * @returns {Promise<Object>} - { status, version, maxSyncSize }
 */
async function checkServerStatus(serverUrl) {
    const response = await fetch(`${serverUrl}/status`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
        throw new Error(`Server check failed: ${response.status}`);
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
        checkServerStatus,
        validateRevision
    };
}

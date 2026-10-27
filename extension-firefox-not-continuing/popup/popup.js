// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            document.getElementById(targetTab).classList.add('active');
        });
    });

    // Server sync handlers
    document.getElementById('generateIdBtn').addEventListener('click', generateSyncId);
    document.getElementById('syncNowBtn').addEventListener('click', syncNow);
    document.getElementById('forceDownloadBtn').addEventListener('click', forceDownload);
    document.getElementById('forceUploadBtn').addEventListener('click', forceUpload);
    document.getElementById('firstSyncDownloadBtn').addEventListener('click', () => firstSync('download'));
    document.getElementById('firstSyncUploadBtn').addEventListener('click', () => firstSync('upload'));

    // Settings tab handlers
    document.getElementById('saveIntervalBtn').addEventListener('click', saveIntervalSettings);

    // Local backup handlers
    document.getElementById('exportBookmarksBtn').addEventListener('click', exportBookmarks);
    document.getElementById('importBookmarksBtn').addEventListener('click', importBookmarks);
    document.getElementById('rollbackSafetyBackupBtn').addEventListener('click', restoreAutoSafetyBackup);

    // Settings handlers
    document.getElementById('resetBtn').addEventListener('click', resetSettings);
    
    // Initialize popup
    initializePopup();
});

async function initializePopup() {
    const settings = await chrome.storage.local.get([
        'serverUrl', 'syncId', 'passphrase', 'syncInterval', 'lastSync', 'syncMode', 'lastSyncRev', 'plaintextMode', 'autoSafetyBackup', 'syncDataVersion', 'restorePending', 'lastSyncError'
    ]);
    
    const devCfg = (typeof window !== 'undefined' && window.DEV_CONFIG) || {};
    const serverUrl = settings.serverUrl || devCfg.serverUrl || 'https://sync.satoshihost.com';
    const syncId = settings.syncId || devCfg.syncId || '';
    const passphrase = settings.passphrase || devCfg.passphrase || '';

    document.getElementById('serverUrl').value = serverUrl;
    document.getElementById('syncId').value = syncId;
    document.getElementById('passphrase').value = passphrase;
    if (settings.syncInterval) document.getElementById('syncInterval').value = settings.syncInterval;

    // Auto-persist dev defaults into storage if present
    if ((!settings.syncId && syncId) || (!settings.passphrase && passphrase)) {
        await chrome.storage.local.set({ serverUrl, syncId, passphrase });
        settings.syncId = syncId;
        settings.passphrase = passphrase;
    }
    document.getElementById('plaintextMode').checked = !!settings.plaintextMode;
    document.getElementById('plaintextMode').onchange = (e) => {
        chrome.storage.local.set({ plaintextMode: e.target.checked });
        showNotification(e.target.checked ? 'Plaintext Mode enabled' : 'Encryption Mode enabled');
    };

    const rollbackBtn = document.getElementById('rollbackSafetyBackupBtn');
    const rollbackHelpText = document.getElementById('rollbackHelpText');
    if (settings.autoSafetyBackup && settings.autoSafetyBackup.bookmarks) {
        const count = countBookmarks(settings.autoSafetyBackup.bookmarks[0] || {});
        const timeStr = new Date(settings.autoSafetyBackup.timestamp).toLocaleTimeString();
        rollbackBtn.style.display = 'block';
        rollbackHelpText.textContent = `Auto safety backup from ${timeStr} (${count} bookmarks)`;
    } else {
        rollbackBtn.style.display = 'none';
        rollbackHelpText.textContent = 'No auto safety backup available.';
    }
    
    updateStatistics(settings);
    updateStatus(settings);
    updateFirstSyncPanel(settings);

    const bookmarks = await chrome.bookmarks.getTree();
    document.getElementById('totalBookmarks').textContent = countBookmarks(bookmarks[0]);
}

async function restoreAutoSafetyBackup() {
    const { autoSafetyBackup } = await chrome.storage.local.get('autoSafetyBackup');
    if (!autoSafetyBackup || !autoSafetyBackup.bookmarks) {
        showNotification('No auto safety backup found', 'error');
        return;
    }
    const count = countBookmarks(autoSafetyBackup.bookmarks[0] || {});
    if (confirm(`Restore ${count} bookmarks from auto safety backup saved at ${new Date(autoSafetyBackup.timestamp).toLocaleString()}?`)) {
        try {
            await restoreLocally(autoSafetyBackup.bookmarks);
            const bookmarks = await chrome.bookmarks.getTree();
            document.getElementById('totalBookmarks').textContent = countBookmarks(bookmarks[0]);
            showNotification(`Restored ${count} bookmarks from safety backup`);
        } catch (e) {
            showNotification('Rollback failed: ' + e.message, 'error');
        }
    }
}

// Show the first-sync panel (choose direction) when configured but never synced.
// Show the normal Sync Now button otherwise.
function updateFirstSyncPanel(settings) {
    const needsFirstSync = settings.syncId && settings.passphrase &&
        (!Number.isSafeInteger(settings.lastSyncRev) || settings.syncDataVersion !== 2 || settings.restorePending);
    document.getElementById('firstSyncPanel').style.display = needsFirstSync ? 'flex' : 'none';
    document.getElementById('syncNowGroup').style.display = needsFirstSync ? 'none' : 'block';
    document.getElementById('firstSyncUploadBtn').disabled = !!settings.restorePending;
    document.querySelector('.first-sync-heading').textContent = settings.restorePending
        ? 'Restore interrupted. Recover your safety backup or download a complete server copy.'
        : Number.isSafeInteger(settings.lastSyncRev) && settings.syncDataVersion !== 2
            ? 'Sync upgraded: export a backup, then choose a fresh copy. Download keeps the server copy; Upload replaces it.'
            : 'Choose how to start syncing on this browser:';
}

function updateStatistics(settings) {
    const lastSync = settings.lastSync ? new Date(settings.lastSync).toLocaleString() : 'Never';
    document.getElementById('lastSync').textContent = lastSync;
    document.getElementById('syncMode').textContent = settings.syncMode || 'None';
}

function updateStatus(settings) {
    const statusIndicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');
    
    if (settings.lastSyncError) {
        statusIndicator.className = 'status-indicator offline';
        statusText.textContent = settings.lastSyncError;
    } else if (settings.syncId && settings.passphrase) {
        statusIndicator.className = 'status-indicator online';
        statusText.textContent = 'Configured';
    } else {
        statusIndicator.className = 'status-indicator offline';
        statusText.textContent = 'Not configured';
    }
}

// ── Local backup ────────────────────────────────────────────────────────────

async function exportBookmarks() {
    try {
        await downloadBookmarkBackup({ saveAs: true });
        showNotification('Bookmarks exported successfully!');
    } catch (error) {
        showNotification('Export failed: ' + error.message, 'error');
    }
}

async function importBookmarks() {
    try {
        const chooseBackupLocation = document.getElementById('chooseBackupLocation').checked;

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        
        input.onchange = async (e) => {
            let safetyBackupCreated = false;
            try {
                const file = e.target.files[0];
                if (!file) return;
                
                const text = await file.text();
                const data = JSON.parse(text);
                
                validateBookmarkBackup(data);

                const importCount = countBookmarksInTree(data.bookmarks);
                
                const backupLocationMessage = chooseBackupLocation
                    ? 'You will choose where to save a safety backup of your current bookmarks first.'
                    : 'A safety backup of your current bookmarks will be saved to Downloads first.';
                if (!confirm(`This will replace your current bookmarks with ${importCount} bookmarks from the selected file.\n\n${backupLocationMessage}\n\nContinue?`)) {
                    return;
                }
                
                await downloadBookmarkBackup({
                    filenamePrefix: 'before-import',
                    saveAs: chooseBackupLocation
                });
                safetyBackupCreated = true;

                await restoreLocally(data.bookmarks);
                document.getElementById('totalBookmarks').textContent = importCount;
                showNotification('Bookmarks imported successfully!');
                alert(`Import complete.\n\n${importCount} bookmarks were restored from "${file.name}".\n\nYour previous bookmarks were saved in the safety backup.`);
                
            } catch (error) {
                showImportError(error, safetyBackupCreated);
            }
        };
        
        input.click();
        
    } catch (error) {
        showImportError(error);
    }
}

function showImportError(error, safetyBackupCreated = false) {
    const message = 'Import failed: ' + error.message;
    showNotification(message, 'error');
    const recoveryMessage = safetyBackupCreated
        ? 'Your safety backup was saved before the import started.'
        : 'No changes were made before the failure.';
    alert(`${message}\n\n${recoveryMessage}`);
}

async function downloadBookmarkBackup({ filenamePrefix = 'bookmarks', saveAs }) {
    const bookmarks = await chrome.bookmarks.getTree();
    const data = {
        version: 1,
        created: new Date().toISOString(),
        bookmarks
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
        await chrome.downloads.download({
            url,
            filename: `${filenamePrefix}-${fileTimestamp()}.json`,
            saveAs
        });
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

function fileTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function validateBookmarkBackup(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.bookmarks)) {
        throw new Error('This is not a Full Browser Sync backup file.');
    }
    if (!data.bookmarks[0] || !Array.isArray(data.bookmarks[0].children)) {
        throw new Error('The backup does not contain a valid bookmark tree.');
    }
}

function countBookmarksInTree(nodes) {
    return nodes.reduce((total, node) => total + countBookmarks(node), 0);
}

// ── First-sync panel ─────────────────────────────────────────────────────────

async function firstSync(direction) {
    return requestSync(direction);
}

// ── Server sync ─────────────────────────────────────────────────────────────

function generateSyncId() {
    document.getElementById('syncId').value = crypto.randomUUID();
}

async function saveIntervalSettings() {
    const syncInterval = Number(document.getElementById('syncInterval').value);
    if (!Number.isInteger(syncInterval) || syncInterval < 1 || syncInterval > 1440) {
        showNotification('Choose an interval between 1 and 1440 minutes', 'error');
        return;
    }
    // The worker updates the alarm when this setting changes.
    await chrome.storage.local.set({ syncInterval });
    showNotification('Settings saved');
}

async function syncNow() {
    return requestSync('auto');
}

async function forceDownload() {
    if (confirm('Replace this browser’s bookmarks with the server copy? Export a backup first if you have local changes to keep.')) {
        return requestSync('download');
    }
}

async function forceUpload() {
    if (confirm('Replace the server copy with this browser’s bookmarks? Other browsers will receive this copy.')) {
        return requestSync('upload');
    }
}

// Returns the background worker's sync result, including the applied revision.
async function requestSync(direction) {
    // Read live values from the form so the user doesn't need to click Save first.
    const serverUrl = (document.getElementById('serverUrl').value.trim() || 'https://sync.satoshihost.com').replace(/\/+$/, '');
    const syncId = document.getElementById('syncId').value.trim();
    const passphrase = document.getElementById('passphrase').value;
    if (!syncId || !passphrase) {
        showNotification('Please fill in Sync ID and Passphrase first', 'error');
        return;
    }
    setSyncingStatus(true);
    try {
        // Persist settings within the worker's queue, not during another sync.
        const result = await chrome.runtime.sendMessage({
            action: 'sync', direction, settings: { serverUrl, syncId, passphrase }
        });
        if (!result || !result.success) throw new Error(result?.error || 'No response from sync worker');
        if (result.action === 'choose') {
            // The first-sync panel also handles migration from cached snapshots.
            // Do not report success or overwrite either copy without a direction.
            showNotification('Choose Download or Upload to establish a fresh sync copy', 'info');
        } else if (result.action === 'uploaded') {
            // An explicit first upload can initialise an empty server.
            // Later local changes use the same background upload path.
            showNotification(`Uploaded to server (Rev ${result.rev})`);
        } else if (result.action === 'downloaded') {
            // Downloads use the revision attached to the actual snapshot.
            showNotification(`Downloaded from server (Rev ${result.rev})`);
        } else if (result.action === 'unchanged') {
            showNotification(`Already up to date (Rev ${result.rev})`, 'info');
        }
        // The worker ensures the periodic alarm exists for every sync direction.
        await initializePopup();
    } catch (error) {
        showNotification('Sync failed: ' + error.message, 'error');
    } finally {
        setSyncingStatus(false);
    }
}

async function restoreLocally(bookmarks) {
    // Keep restoration in the background worker so bookmark change events
    // from the restore cannot trigger a spurious upload of partial data.
    const result = await chrome.runtime.sendMessage({ action: 'restore', bookmarks });
    // The worker marks this as a local edit without advancing the server revision.
    if (!result || !result.success) throw new Error(result?.error || 'No response from sync worker');
}

function setSyncingStatus(syncing) {
    const statusIndicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');
    const syncBtn = document.getElementById('syncNowBtn');
    document.querySelectorAll('button, input').forEach(control => { control.disabled = syncing; });
    if (syncing) {
        statusIndicator.className = 'status-indicator syncing';
        statusText.textContent = 'Syncing...';
        syncBtn.disabled = true;
        syncBtn.textContent = 'Syncing...';
    } else {
        syncBtn.disabled = false;
        syncBtn.textContent = 'Sync Now';
        chrome.storage.local.get(['syncId', 'passphrase', 'lastSyncRev', 'syncDataVersion', 'restorePending', 'lastSyncError']).then(settings => {
            updateStatus(settings);
            updateFirstSyncPanel(settings);
        });
    }
}

// ── Settings ────────────────────────────────────────────────────────────────

async function resetSettings() {
    if (confirm('This will delete all settings. Continue?')) {
        const result = await chrome.runtime.sendMessage({ action: 'reset' });
        if (!result || !result.success) {
            showNotification(result?.error || 'Reset failed', 'error');
            return;
        }
        location.reload();
    }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function showNotification(message, type = 'success') {
    const notification = document.createElement('div');
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        padding: 0.75rem 1rem;
        border-radius: 4px;
        background: ${type === 'error' ? '#dc3545' : type === 'info' ? '#17a2b8' : '#28a745'};
        color: white;
        font-size: 0.9rem;
        z-index: 1000;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    `;
    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 3000);
}

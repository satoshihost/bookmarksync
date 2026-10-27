// Background service worker for Full Browser Sync
if (typeof importScripts === 'function') {
    importScripts('lib/crypto.js', 'lib/sync.js', 'lib/bookmarks.js');
}

// Guard against concurrent syncs and against events fired by restore operations
let syncQueue = Promise.resolve();
let stateQueue = Promise.resolve();
let alarmQueue = Promise.resolve();
let restoring = false;
let changeVersion = 0;
let syncDebounceTimer = null;

function saveState(values) {
    const task = stateQueue.then(() => chrome.storage.local.set(
        typeof values === 'function' ? values() : values
    ));
    stateQueue = task.catch(() => {});
    return task;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
    ensureSyncAlarm().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
    ensureSyncAlarm().then(() => automaticSync('startup')).catch(console.error);
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ['syncId', 'passphrase', 'syncInterval'].some(key => key in changes)) {
        ensureSyncAlarm().catch(console.error);
    }
});

function ensureSyncAlarm() {
    const task = alarmQueue.then(async () => {
        const settings = await chrome.storage.local.get(['syncId', 'passphrase', 'syncInterval']);
        if (!settings.syncId || !settings.passphrase) {
            await chrome.alarms.clear('autoSync');
            return;
        }
        const interval = Number(settings.syncInterval);
        const periodInMinutes = Number.isFinite(interval) && interval >= 1 ? Math.min(interval, 1440) : 10;
        const alarm = await chrome.alarms.get('autoSync');
        if (!alarm || alarm.periodInMinutes !== periodInMinutes) {
            await chrome.alarms.create('autoSync', { periodInMinutes });
        }
    });
    alarmQueue = task.catch(() => {});
    return task;
}

// ── Alarms — periodic & pending auto-sync ────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'autoSync' || alarm.name === 'pendingSync') {
        automaticSync(alarm.name);
    }
});

function automaticSync(reason) {
    return performSync(reason).catch(error => console.warn('Auto-sync warning:', error.message));
}

// ── Bookmark change listeners — debounced upload ─────────────────────────────

function onBookmarkChange() {
    if (restoring) return;
    changeVersion++;
    saveState({ localDirty: true }).catch(console.error);
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => automaticSync('change'), 5000);
    // MV3 alarm backup: ensures upload triggers even if service worker sleeps mid-debounce
    chrome.alarms.create('pendingSync', { delayInMinutes: 0.5 });
}

chrome.bookmarks.onCreated.addListener(onBookmarkChange);
chrome.bookmarks.onRemoved.addListener(onBookmarkChange);
chrome.bookmarks.onChanged.addListener(onBookmarkChange);
chrome.bookmarks.onMoved.addListener(onBookmarkChange);

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.action === 'sync') {
        performSync('message', message)
            .then(result => sendResponse({ success: true, ...result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // Keep channel open for async response
    }
    // Local imports also run in the worker so closing the popup cannot release
    // the restore guard or upload a half-restored bookmark tree.
    if (message.action === 'restore' || message.action === 'reset') {
        performSync('message', { direction: message.action, bookmarks: message.bookmarks })
            .then(result => sendResponse({ success: true, ...result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }
});

// ── Core sync logic ──────────────────────────────────────────────────────────

function performSync(reason = 'manual', options = {}) {
    const task = syncQueue.then(() => runSync(reason, options));
    syncQueue = task.catch(() => {});
    return task;
}

async function runSync(reason, options) {
    const direction = options.direction || 'auto';
    if (!['auto', 'upload', 'download', 'restore', 'reset'].includes(direction)) {
        throw new Error('Invalid sync direction');
    }
    try {
        await stateQueue;
        if (direction === 'reset') {
            clearTimeout(syncDebounceTimer);
            await chrome.storage.local.clear();
            await ensureSyncAlarm();
            await chrome.alarms.clear('pendingSync');
            return { action: 'reset' };
        }
        if (options.settings) {
            const { serverUrl, syncId, passphrase } = options.settings;
            if (typeof serverUrl !== 'string' || typeof syncId !== 'string' || typeof passphrase !== 'string' || !syncId || !passphrase) {
                throw new Error('Please fill in Sync ID and Passphrase first');
            }
            const old = await chrome.storage.local.get(['serverUrl', 'syncId', 'passphrase']);
            if (old.serverUrl !== serverUrl || old.syncId !== syncId || old.passphrase !== passphrase) {
                await chrome.storage.local.remove(['lastSyncRev', 'syncDataVersion', 'lastSync']);
            }
            await saveState({ serverUrl, syncId, passphrase, syncMode: 'Server' });
        }
        await ensureSyncAlarm();
        await stateQueue;
        const startVersion = changeVersion;
        const settings = await chrome.storage.local.get([
            'serverUrl', 'syncId', 'passphrase', 'lastSyncRev', 'localDirty',
            'plaintextMode', 'syncDataVersion', 'restorePending'
        ]);
        if (direction === 'restore') {
            await applyRestore(options.bookmarks, settings.restorePending, startVersion, { localDirty: true });
            await chrome.alarms.create('pendingSync', { delayInMinutes: 0.5 });
            return { action: 'restored' };
        }
        if (!settings.syncId || !settings.passphrase) {
            return { action: 'unconfigured' };
        }
        if (settings.restorePending && direction !== 'download') {
            throw new Error('A restore was interrupted. Export your bookmarks or recover the safety backup, then download a complete server copy before uploading.');
        }
        if (direction === 'auto' && (!Number.isSafeInteger(settings.lastSyncRev) || settings.syncDataVersion !== 2)) {
            // A first sync or an older cached snapshot needs an explicit choice.
            // Don't auto-download — could silently overwrite local bookmarks.
            // The user must do the first sync manually via the popup to choose direction.
            return { action: 'choose' };
        }

        const serverUrl = settings.serverUrl || 'https://sync.satoshihost.com';
        console.log(`Sync triggered by: ${reason}`);
        const info = await getInfo(serverUrl, settings.syncId);
        let action;
        let rev = settings.lastSyncRev;
        if (direction === 'download') {
            rev = await performDownload(serverUrl, settings, startVersion);
            action = 'downloaded';
        } else if (direction === 'upload') {
            // An explicit upload can initialise an empty server or replace its current copy.
            rev = await performUpload(serverUrl, settings, info ? info.rev : 0);
            action = 'uploaded';
        } else if (!info) {
            throw new Error('The server copy is missing. Choose an explicit upload to recreate it.');
        } else if (settings.localDirty) {
            // Local changes may be uploaded only against the revision they were based on.
            if (info.rev !== settings.lastSyncRev) {
                throw new Error('Both this browser and the server changed. Export a backup, then choose Upload or Download explicitly.');
            }
            rev = await performUpload(serverUrl, settings, settings.lastSyncRev);
            action = 'uploaded';
        } else if (info.rev !== settings.lastSyncRev) {
            // Server revision differs from what we last synced — download it.
            rev = await performDownload(serverUrl, settings, startVersion);
            action = 'downloaded';
        } else {
            action = 'unchanged';
        }
        await saveState({ lastSync: new Date().toISOString(), lastSyncError: null, lastSyncResult: action });
        console.log(`Sync: ${action} (Rev ${rev})`);
        return { action, rev };
    } catch (error) {
        await saveState({ lastSyncError: error.message });
        await chrome.alarms.create('pendingSync', { delayInMinutes: 1 });
        throw error;
    }
}

async function performUpload(serverUrl, settings, expectedRev) {
    const capturedVersion = changeVersion;
    const bookmarks = await chrome.bookmarks.getTree();
    const data = { version: 1, created: new Date().toISOString(), bookmarks };
    const encrypted = await encrypt(settings.passphrase, JSON.stringify(data), settings.plaintextMode);
    const result = await uploadBlob(serverUrl, settings.syncId, encrypted, expectedRev);
    validateRevision(result.rev);
    await saveState(() => ({
        lastSyncRev: result.rev,
        syncDataVersion: 2,
        localDirty: changeVersion !== capturedVersion
    }));
    return result.rev;
}

async function performDownload(serverUrl, settings, startVersion) {
    const result = await downloadBlob(serverUrl, settings.syncId);
    if (!result) throw new Error('No data on server');
    validateRevision(result.rev);
    const plaintext = await decrypt(settings.passphrase, new Uint8Array(result.data));
    const data = JSON.parse(plaintext);
    if (!data || data.version !== 1 || !Array.isArray(data.bookmarks)) {
        throw new Error('Invalid bookmark data from server');
    }
    // Store the revision attached to the downloaded snapshot, never the earlier /info result.
    await applyRestore(data.bookmarks, settings.restorePending, startVersion, {
        lastSyncRev: result.rev, syncDataVersion: 2, localDirty: false
    });
    return result.rev;
}

async function applyRestore(bookmarks, preserveSafetyBackup, startVersion, completedState) {
    if (changeVersion !== startVersion) {
        throw new Error('Bookmarks changed while downloading; keeping local edits. Try syncing again.');
    }
    restoring = true;
    try {
        await saveState({ restorePending: true });
        await restoreBookmarks(bookmarks, { preserveSafetyBackup: !!preserveSafetyBackup });
        await saveState({ ...completedState, restorePending: false, lastSyncError: null });
    } finally {
        restoring = false;
    }
}

ensureSyncAlarm().catch(console.error);
console.log('Full Browser Sync service worker loaded');

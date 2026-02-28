// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;
        
        // Update tab buttons
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Update tab content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
        });
        document.getElementById(targetTab).classList.add('active');
    });
});

// Local file sync handlers
document.getElementById('exportBtn')?.addEventListener('click', exportBookmarks);
document.getElementById('importBtn')?.addEventListener('click', importBookmarks);

// Server sync handlers
document.getElementById('generateIdBtn').addEventListener('click', generateSyncId);
document.getElementById('saveServerBtn').addEventListener('click', saveServerSettings);
document.getElementById('syncNowBtn').addEventListener('click', syncNow);

// Settings handlers
document.getElementById('resetBtn').addEventListener('click', resetSettings);

// Initialize on load
document.addEventListener('DOMContentLoaded', initializePopup);

async function initializePopup() {
    // Load saved settings
    const settings = await chrome.storage.local.get([
        'serverUrl',
        'syncId',
        'passphrase',
        'autoSync',
        'syncInterval',
        'lastSync',
        'syncMode'
    ]);
    
    // Populate form fields
    if (settings.serverUrl) {
        document.getElementById('serverUrl').value = settings.serverUrl;
    }
    if (settings.syncId) {
        document.getElementById('syncId').value = settings.syncId;
    }
    if (settings.passphrase) {
        document.getElementById('passphrase').value = settings.passphrase;
    }
    if (settings.autoSync) {
        document.getElementById('autoSync').checked = settings.autoSync;
    }
    if (settings.syncInterval) {
        document.getElementById('syncInterval').value = settings.syncInterval;
    }
    
    // Update statistics
    updateStatistics(settings);
    
    // Update status
    updateStatus(settings);
    
    // Get bookmark count
    const bookmarks = await chrome.bookmarks.getTree();
    const count = countBookmarks(bookmarks[0]);
    document.getElementById('totalBookmarks').textContent = count;
}

function countBookmarks(node) {
    let count = 0;
    if (node.url) count = 1;
    if (node.children) {
        node.children.forEach(child => {
            count += countBookmarks(child);
        });
    }
    return count;
}

function updateStatistics(settings) {
    const lastSync = settings.lastSync ? new Date(settings.lastSync).toLocaleString() : 'Never';
    document.getElementById('lastSync').textContent = lastSync;
    
    const syncMode = settings.syncMode || 'None';
    document.getElementById('syncMode').textContent = syncMode;
}

function updateStatus(settings) {
    const statusIndicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');
    
    if (settings.syncId && settings.passphrase) {
        statusIndicator.className = 'status-indicator online';
        statusText.textContent = 'Configured';
    } else {
        statusIndicator.className = 'status-indicator offline';
        statusText.textContent = 'Not configured';
    }
}

async function exportBookmarks() {
    try {
        // Get all bookmarks
        const bookmarks = await chrome.bookmarks.getTree();
        
        const data = {
            version: 1,
            created: new Date().toISOString(),
            bookmarks: bookmarks
        };
        
        // Create blob and download
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        await chrome.downloads.download({
            url: url,
            filename: `bookmarks-${Date.now()}.json`,
            saveAs: true
        });
        
        showNotification('Bookmarks exported successfully!');
    } catch (error) {
        showNotification('Export failed: ' + error.message, 'error');
    }
}

async function importBookmarks() {
    try {
        // Create file input element
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        
        input.onchange = async (e) => {
            try {
                const file = e.target.files[0];
                if (!file) return;
                
                const text = await file.text();
                const data = JSON.parse(text);
                
                // Validate format
                if (!data.version || !data.bookmarks) {
                    showNotification('Invalid bookmark file format', 'error');
                    return;
                }
                
                // Warn user about replacement
                if (!confirm('This will REPLACE all your current bookmarks. Make sure you have a backup!\n\nContinue?')) {
                    return;
                }
                
                // Restore bookmarks
                await restoreBookmarks(data.bookmarks);
                showNotification('Bookmarks imported successfully!');
                
            } catch (error) {
                showNotification('Import failed: ' + error.message, 'error');
            }
        };
        
        // Trigger file picker
        input.click();
        
    } catch (error) {
        showNotification('Import failed: ' + error.message, 'error');
    }
}

function generateSyncId() {
    // Generate UUID v4
    const uuid = crypto.randomUUID();
    document.getElementById('syncId').value = uuid;
}

async function saveServerSettings() {
    const serverUrl = document.getElementById('serverUrl').value;
    const syncId = document.getElementById('syncId').value;
    const passphrase = document.getElementById('passphrase').value;
    const autoSync = document.getElementById('autoSync').checked;
    const syncInterval = parseInt(document.getElementById('syncInterval').value);
    
    if (!syncId || !passphrase) {
        showNotification('Please fill in Sync ID and Passphrase', 'error');
        return;
    }
    
    await chrome.storage.local.set({
        serverUrl,
        syncId,
        passphrase,
        autoSync,
        syncInterval,
        syncMode: 'Server'
    });
    
    // Set up alarm for auto-sync
    if (autoSync) {
        chrome.alarms.create('autoSync', { periodInMinutes: syncInterval });
    } else {
        chrome.alarms.clear('autoSync');
    }
    
    showNotification('Settings saved successfully!');
    updateStatus({ syncId, passphrase });
}

async function syncNow() {
    // TODO: Implement server sync
    showNotification('Server sync feature coming soon!', 'info');
}

async function resetSettings() {
    if (confirm('This will delete all settings. Continue?')) {
        await chrome.storage.local.clear();
        await chrome.alarms.clearAll();
        location.reload();
    }
}

async function restoreBookmarks(bookmarkTree) {
    try {
        // Get the root bookmark folders
        const tree = await chrome.bookmarks.getTree();
        const root = tree[0];
        
        // Delete all existing bookmarks (except root structure)
        for (const child of root.children) {
            // Keep the root folders but delete their contents
            if (child.children) {
                for (const bookmark of child.children) {
                    await chrome.bookmarks.removeTree(bookmark.id);
                }
            }
        }
        
        // Restore from backup
        // The backup contains the full tree starting from root
        const backupRoot = bookmarkTree[0];
        
        if (backupRoot && backupRoot.children) {
            for (const sourceFolder of backupRoot.children) {
                // Find matching folder in current browser by title
                // Common names: "Bookmarks Bar", "Bookmarks bar", "Other Bookmarks", "Other bookmarks", "Mobile Bookmarks"
                const targetFolder = root.children.find(c => 
                    c.title.toLowerCase() === sourceFolder.title.toLowerCase()
                );
                
                if (targetFolder && sourceFolder.children) {
                    // Merge into existing top-level folder
                    for (const child of sourceFolder.children) {
                        await restoreNode(child, targetFolder.id);
                    }
                } else if (!targetFolder) {
                    // Folder doesn't exist in target, create it
                    const newFolder = await chrome.bookmarks.create({
                        parentId: root.id,
                        title: sourceFolder.title
                    });
                    if (sourceFolder.children) {
                        for (const child of sourceFolder.children) {
                            await restoreNode(child, newFolder.id);
                        }
                    }
                }
            }
        }
        
    } catch (error) {
        console.error('Restore failed:', error);
        throw new Error('Failed to restore bookmarks: ' + error.message);
    }
}

async function restoreNode(node, parentId) {
    // Skip if no parent
    if (!parentId) return;
    
    // Create folder or bookmark
    const createParams = {
        parentId: parentId,
        title: node.title
    };
    
    if (node.url) {
        // It's a bookmark
        createParams.url = node.url;
        await chrome.bookmarks.create(createParams);
    } else if (node.children) {
        // It's a folder
        const newFolder = await chrome.bookmarks.create(createParams);
        
        // Recursively restore children
        for (const child of node.children) {
            await restoreNode(child, newFolder.id);
        }
    }
}

function showNotification(message, type = 'success') {
    // Create a simple notification
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
    
    setTimeout(() => {
        notification.remove();
    }, 3000);
}

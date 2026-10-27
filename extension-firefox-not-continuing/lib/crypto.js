// Crypto module for Full Browser Sync
// AES-256-GCM encryption with PBKDF2 key derivation

const PBKDF2_ITERATIONS = 100000;
const SALT = new TextEncoder().encode("bookmarksync-v1");

/**
 * Derive encryption key from passphrase
 * @param {string} passphrase - User's passphrase
 * @returns {Promise<CryptoKey>} - Derived AES-GCM key
 */
async function deriveKey(passphrase) {
    const raw = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(passphrase),
        "PBKDF2",
        false,
        ["deriveKey"]
    );
    
    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: SALT,
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256"
        },
        raw,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

/**
 * Encrypt plaintext with passphrase (or return raw text if plaintextMode is true)
 * @param {string} passphrase - User's passphrase
 * @param {string} plaintext - Data to encrypt
 * @param {boolean} [plaintextMode=false] - If true, skip encryption for testing
 * @returns {Promise<Uint8Array>} - IV + ciphertext OR raw UTF-8 bytes
 */
async function encrypt(passphrase, plaintext, plaintextMode = false) {
    if (plaintextMode || passphrase === '__PLAINTEXT__') {
        return new TextEncoder().encode(plaintext);
    }

    const key = await deriveKey(passphrase);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoded
    );
    
    // Prepend IV to ciphertext for storage
    const result = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), iv.byteLength);
    
    return result;
}

/**
 * Check if binary data is unencrypted JSON plaintext
 * @param {Uint8Array} data
 * @returns {boolean}
 */
function isPlaintextData(data) {
    try {
        const text = new TextDecoder().decode(data);
        const trimmed = text.trim();
        return (trimmed.startsWith('{') || trimmed.startsWith('[')) && text.includes('"version"');
    } catch {
        return false;
    }
}

/**
 * Decrypt ciphertext with passphrase (or decode directly if payload is plaintext)
 * @param {string} passphrase - User's passphrase
 * @param {Uint8Array} data - IV + ciphertext OR raw UTF-8 bytes
 * @returns {Promise<string>} - Decrypted plaintext
 */
async function decrypt(passphrase, data) {
    if (isPlaintextData(data)) {
        return new TextDecoder().decode(data);
    }

    const key = await deriveKey(passphrase);
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);
    
    const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ciphertext
    );
    
    return new TextDecoder().decode(plaintext);
}

/**
 * SHA-256 hash of a plaintext string, returned as a hex string.
 * Used to detect whether server content has changed since our last sync.
 * @param {string} plaintext
 * @returns {Promise<string>} - Hex-encoded SHA-256 digest
 */
async function hashContent(plaintext) {
    const encoded = new TextEncoder().encode(plaintext);
    const buf = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// Export functions
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { encrypt, decrypt, deriveKey, hashContent, isPlaintextData };
}

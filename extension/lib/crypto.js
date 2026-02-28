// Crypto module for BookmarkSync
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
 * Encrypt plaintext with passphrase
 * @param {string} passphrase - User's passphrase
 * @param {string} plaintext - Data to encrypt
 * @returns {Promise<Uint8Array>} - IV + ciphertext
 */
async function encrypt(passphrase, plaintext) {
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
 * Decrypt ciphertext with passphrase
 * @param {string} passphrase - User's passphrase
 * @param {Uint8Array} data - IV + ciphertext
 * @returns {Promise<string>} - Decrypted plaintext
 */
async function decrypt(passphrase, data) {
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

// Export functions
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { encrypt, decrypt, deriveKey };
}

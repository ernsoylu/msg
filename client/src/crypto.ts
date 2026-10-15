// Client-side end-to-end encryption with RSA-2048 key wrapping + AES-GCM.
// RSA-2048 key pairs are generated via Rust/WASM (crypto-wasm crate) for
// performant key generation. Private keys never leave the browser.

import { generate_rsa_keypair } from './wasm/crypto_wasm';

const RSA_ALGO: AlgorithmIdentifier = { name: 'RSA-OAEP' };

const AES_ALGO = { name: 'AES-GCM' };

export interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

/** Generate a fresh ephemeral RSA-2048 key pair via Rust/WASM. */
export async function generateKeyPair(): Promise<KeyPair> {
  // generate_rsa_keypair is synchronous; wrap in a promise to avoid blocking
  // the UI thread during the computationally intensive prime generation.
  const keypair = await new Promise<any>((resolve) => {
    setTimeout(() => resolve(generate_rsa_keypair()), 0);
  });

  // Import public key from SPKI DER base64 (produced by WASM)
  const spkiDer = Uint8Array.from(
    atob(keypair.public_key_spki_b64),
    (c) => c.charCodeAt(0)
  );
  const publicKey = await crypto.subtle.importKey(
    'spki',
    spkiDer,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true,
    ['encrypt']
  );

  // Import private key from PKCS8 DER base64 (produced by WASM)
  const pkcs8Der = Uint8Array.from(
    atob(keypair.private_key_pkcs8_b64),
    (c) => c.charCodeAt(0)
  );
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8Der,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true,
    ['decrypt']
  );

  return { privateKey, publicKey };
}

/** Export the RSA public key as a base64-encoded JWK for transport. */
export async function exportPublicKeyBase64(key: CryptoKey): Promise<string> {
  const jwk = (await crypto.subtle.exportKey('jwk', key)) as JsonWebKey;
  return btoa(JSON.stringify(jwk));
}

/** Import a peer's base64-encoded RSA public key (JWK). */
export async function importPublicKeyBase64(text: string): Promise<CryptoKey> {
  const jwk = JSON.parse(atob(text)) as JsonWebKey;
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true,
    ['encrypt']
  );
}

/**
 * Generate a random AES-256 session key and wrap it with the peer's RSA-OAEP
 * public key. The wrapped key can be sent over the wire; only the holder of
 * the matching RSA private key can unwrap it.
 */
export async function wrapSessionKey(
  publicKey: CryptoKey
): Promise<{ wrappedKey: number[]; sessionKey: CryptoKey }> {
  const sessionKey = (await crypto.subtle.generateKey(
    AES_ALGO,
    true,
    ['encrypt', 'decrypt']
  )) as CryptoKey;
  const wrapped = await crypto.subtle.wrapKey(
    'jwk',
    sessionKey,
    publicKey as CryptoKey,
    RSA_ALGO
  );
  return {
    wrappedKey: Array.from(new Uint8Array(wrapped)),
    sessionKey,
  };
}

/** Unwrap an AES session key that was wrapped with our RSA-OAEP public key. */
export async function unwrapSessionKey(
  privateKey: CryptoKey,
  wrappedKey: number[]
): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'jwk',
    new Uint8Array(wrappedKey),
    privateKey,
    RSA_ALGO,
    AES_ALGO,
    true,
    ['encrypt', 'decrypt']
  );
}

/** Encrypt plaintext with a fresh random IV using AES-256-GCM. */
export async function encryptText(key: CryptoKey, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return {
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(ciphertext)),
  };
}

/** Decrypt a ciphertext produced by encryptText. */
export async function decryptText(
  key: CryptoKey,
  iv: number[],
  ciphertext: number[]
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    key,
    new Uint8Array(ciphertext)
  );
  return new TextDecoder().decode(plaintext);
}

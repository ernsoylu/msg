use wasm_bindgen::prelude::*;
use rsa::RsaPrivateKey;
use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey};
use getrandom::getrandom;
use rand_core::{RngCore, CryptoRng, Error as RandError};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};

// WASM-compatible RNG that uses getrandom (which uses crypto.getRandomValues in browsers)
struct WasmRng;

impl RngCore for WasmRng {
    fn next_u32(&mut self) -> u32 {
        let mut buf = [0u8; 4];
        getrandom(&mut buf).ok();
        u32::from_le_bytes(buf)
    }

    fn next_u64(&mut self) -> u64 {
        let mut buf = [0u8; 8];
        getrandom(&mut buf).ok();
        u64::from_le_bytes(buf)
    }

    fn fill_bytes(&mut self, dest: &mut [u8]) {
        getrandom(dest).ok();
    }

    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), RandError> {
        getrandom(dest)
            .map_err(|_| RandError::new("getrandom failed".to_string()))
    }
}

impl CryptoRng for WasmRng {}

#[wasm_bindgen]
pub struct Keypair {
    public_key_spki_b64: String,
    private_key_pkcs8_b64: String,
    public_key_pem: String,
}

#[wasm_bindgen]
impl Keypair {
    #[wasm_bindgen(getter)]
    pub fn public_key_spki_b64(&self) -> String {
        self.public_key_spki_b64.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn private_key_pkcs8_b64(&self) -> String {
        self.private_key_pkcs8_b64.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn public_key_pem(&self) -> String {
        self.public_key_pem.clone()
    }
}

#[wasm_bindgen]
pub fn generate_rsa_keypair() -> Keypair {
    let mut rng = WasmRng;
    let private_key =
        RsaPrivateKey::new(&mut rng, 2048).expect("failed to generate RSA-2048 keypair");
    let public_key = rsa::RsaPublicKey::from(&private_key);

    // Export public key as SPKI DER -> base64
    let spki_der = public_key
        .to_public_key_der()
        .expect("failed to serialize public key");
    let spki_b64 = BASE64.encode(spki_der.as_bytes());

    // Export private key as PKCS8 DER -> base64
    let pkcs8_der = private_key
        .to_pkcs8_der()
        .expect("failed to serialize private key");
    let pkcs8_b64 = BASE64.encode(pkcs8_der.as_bytes());

    // PEM for reference/debugging
    let public_key_pem = public_key
        .to_public_key_pem(Default::default())
        .expect("failed to PEM encode public key");

    Keypair {
        public_key_spki_b64: spki_b64,
        private_key_pkcs8_b64: pkcs8_b64,
        public_key_pem,
    }
}

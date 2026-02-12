use wasm_bindgen::prelude::*;
use tokenizers::Tokenizer;
use std::str::FromStr;

/// DeepSeek tokenizer wrapper for WASM.
///
/// Loads the HuggingFace tokenizer.json format and provides
/// encode/decode/count operations callable from JavaScript.
///
/// All tokenizer data (vocab, merges) lives in WASM linear memory,
/// keeping the JS heap footprint under 2 MB.
#[wasm_bindgen]
pub struct DeepSeekTokenizer {
    tokenizer: Tokenizer,
}

#[wasm_bindgen]
impl DeepSeekTokenizer {
    /// Create a tokenizer from the tokenizer.json content.
    ///
    /// The JSON string is copied from JS into WASM linear memory,
    /// parsed by serde_json, and the resulting data structures
    /// (vocab HashMap, merge rules Vec) remain in WASM memory.
    ///
    /// The JS string can be GC'd after this constructor returns.
    #[wasm_bindgen(constructor)]
    pub fn new(json: &str) -> Result<DeepSeekTokenizer, JsError> {
        let tokenizer = Tokenizer::from_str(json)
            .map_err(|e| JsError::new(&format!("Failed to load tokenizer: {}", e)))?;
        Ok(DeepSeekTokenizer { tokenizer })
    }

    /// Count tokens in text. This is the primary method for context management.
    ///
    /// Does NOT add special tokens (BOS/EOS) - those are added by the API,
    /// not by us. We count the raw content tokens for budget calculation.
    pub fn count_tokens(&self, text: &str) -> Result<u32, JsError> {
        let encoding = self.tokenizer.encode(text, false)
            .map_err(|e| JsError::new(&format!("Encode failed: {}", e)))?;
        Ok(encoding.get_ids().len() as u32)
    }

    /// Encode text to token IDs. Returns a Uint32Array.
    ///
    /// Useful for advanced context management (e.g., truncating at
    /// a token boundary rather than a character boundary).
    pub fn encode(&self, text: &str, add_special_tokens: bool) -> Result<js_sys::Uint32Array, JsError> {
        let encoding = self.tokenizer.encode(text, add_special_tokens)
            .map_err(|e| JsError::new(&format!("Encode failed: {}", e)))?;
        let ids = encoding.get_ids();
        let array = js_sys::Uint32Array::new_with_length(ids.len() as u32);
        array.copy_from(ids);
        Ok(array)
    }

    /// Decode token IDs back to text.
    pub fn decode(&self, ids: &[u32], skip_special_tokens: bool) -> Result<String, JsError> {
        self.tokenizer.decode(ids, skip_special_tokens)
            .map_err(|e| JsError::new(&format!("Decode failed: {}", e)))
    }

    /// Get the vocabulary size (128,000 for DeepSeek V3).
    pub fn vocab_size(&self) -> u32 {
        self.tokenizer.get_vocab_size(false) as u32
    }
}

// src/hardware/catalog.js — the curated set of Ollama-pullable local models the
// S6 recommender ranks against the detected hardware.
//
// Deliberately STATIC + reviewed-in-repo (not fetched from Ollama's library at
// runtime): the names are exact Ollama pull tags, the param counts are public
// facts, and a curated list keeps the recommender's behaviour auditable and the
// pull surface constrained to known-good names. A spread of sizes from "runs on
// a laptop" to "needs a serious GPU" so every machine gets a real suggestion.
//
// paramsB = total parameters in billions. kvParamsB (optional) = active params
// for the KV-cache term (only differs for MoE; omitted = dense = paramsB).

export const CATALOG = Object.freeze([
  { name: 'qwen2.5:1.5b',  paramsB: 1.5,  defaultQuant: 'Q4_K_M', ctx: 8192, blurb: 'Tiny + fast — runs on almost anything (≈2 GB).' },
  { name: 'llama3.2:3b',   paramsB: 3.2,  defaultQuant: 'Q4_K_M', ctx: 8192, blurb: 'Small, capable everyday model (≈3 GB).' },
  { name: 'qwen2.5:7b',    paramsB: 7.6,  defaultQuant: 'Q4_K_M', ctx: 8192, blurb: 'Strong 7B all-rounder (≈5 GB).' },
  { name: 'llama3.1:8b',   paramsB: 8.0,  defaultQuant: 'Q4_K_M', ctx: 8192, blurb: 'The popular 8B baseline (≈5–6 GB).' },
  { name: 'gemma2:9b',     paramsB: 9.2,  defaultQuant: 'Q4_K_M', ctx: 8192, blurb: 'Google Gemma 2, sharp for its size (≈6 GB).' },
  { name: 'qwen2.5:14b',   paramsB: 14.8, defaultQuant: 'Q4_K_M', ctx: 8192, blurb: 'Mid-size, noticeably more capable (≈9 GB).' },
  { name: 'gemma2:27b',    paramsB: 27.2, defaultQuant: 'Q4_K_M', ctx: 8192, blurb: 'Large, near-frontier quality (≈16 GB).' },
  { name: 'qwen2.5:32b',   paramsB: 32.8, defaultQuant: 'Q4_K_M', ctx: 8192, blurb: 'Heavyweight reasoning (≈20 GB).' },
  { name: 'llama3.3:70b',  paramsB: 70.6, defaultQuant: 'Q4_K_M', ctx: 8192, blurb: 'Frontier-class local model — needs a serious GPU (≈40 GB).' },
]);

export default CATALOG;

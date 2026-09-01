/**
 * FarmMate Sahayak — 2-step retrieval logic for Cloudflare Worker
 *
 * Why: sending the full 275 KB CIB knowledge base with every farmer
 * message would multiply the Claude API cost per conversation.
 * Instead we send only a 48 KB "index" (product + crop + pest names)
 * on the first call, let Claude pick 1-5 candidate products, then
 * fetch only THOSE products' full CIB detail for the second call.
 *
 * Files needed alongside this worker (upload to Workers KV or bundle
 * as static assets):
 *   - farmmate_retrieval_index.json   (~48 KB, always sent)
 *   - farmmate_product_lookup.json    (~280 KB, only matched entries sent)
 *
 * Deploy: wrangler.toml should bind KV namespace "FARMMATE_KB" with
 * both files uploaded as keys "index" and "lookup".
 */

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Use POST", { status: 405 });
    }

    const { message, imageBase64, history = [] } = await request.json();

    // Load the compact index once (cache in memory across requests in this isolate)
    const index = JSON.parse(await env.FARMMATE_KB.get("index"));

    // ---- STEP 1: ask Claude to shortlist candidate products ----
    const shortlistPrompt = `You are a triage assistant for an agri-input chatbot.
Below is a compact index of ${index.length} products FarmMate sells, each with
its active ingredient(s), the crops it's used on, and the pests/diseases it targets.

INDEX (JSON):
${JSON.stringify(index)}

Farmer's message: "${message}"

Return ONLY a JSON array of up to 5 product names from the index whose crop
and pest/disease match the farmer's message best. If the message doesn't
clearly indicate a crop or problem yet, return an empty array [] — do not guess.
Example output: ["Aconite Chlorantraniliprole 18.5% SC Insecticide", "Tarzan Chlorantraniliprole 18.5% SC Insecticide"]`;

    const shortlistResp = await callClaude(env, {
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      messages: [{ role: "user", content: shortlistPrompt }],
    });

    let candidateNames = [];
    try {
      const text = shortlistResp.content[0].text.trim();
      candidateNames = JSON.parse(text.match(/\[[\s\S]*\]/)[0]);
    } catch (e) {
      candidateNames = []; // fall back to asking a clarifying question
    }

    // ---- STEP 2: fetch only the matched products' full CIB detail ----
    let detailContext = "";
    if (candidateNames.length > 0) {
      const lookup = JSON.parse(await env.FARMMATE_KB.get("lookup"));
      detailContext = candidateNames
        .map((name) => lookup[name])
        .filter(Boolean)
        .join("\n\n---\n\n");
    }

    const systemPrompt = detailContext
      ? `You are FarmMate Sahayak, a farmer-facing assistant. Use the CIB-approved
data below (dosages are per hectare — convert to per-acre by dividing by ~2.47)
to recommend the right FarmMate product and correct per-acre dose. Reply in the
farmer's own language (Hindi/Punjabi/Tamil/etc. as they wrote). Be concise and
practical. Always mention the waiting period before harvest if given.

CIB PRODUCT DATA:
${detailContext}`
      : `You are FarmMate Sahayak, a farmer-facing assistant. The farmer's message
doesn't yet give enough detail (crop name + visible problem) to recommend a
product. Ask ONE short clarifying question in their language — e.g. which crop,
and what the pest/disease looks like (or ask them to send a photo).`;

    const userContent = imageBase64
      ? [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
          { type: "text", text: message },
        ]
      : message;

    const finalResp = await callClaude(env, {
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [...history, { role: "user", content: userContent }],
    });

    return new Response(JSON.stringify({ reply: finalResp.content[0].text }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};

async function callClaude(env, body) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

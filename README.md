# FarmMate Sahayak — Chatbot Worker

Cloudflare Worker backend for the FarmMate.in farmer chatbot. Uses a 2-step
retrieval flow so only the relevant slice of the CIB (Central Insecticide
Board) knowledge base is sent to Claude per farmer query, instead of the
full ~280 KB dataset every time.

```
farmmate-chatbot-worker/
├── src/index.js        ← Worker code (2-step retrieval logic)
├── data/index.json      ← compact index (product, active ingredient, crops, pests) — always sent
├── data/lookup.json     ← full CIB detail per product — only matched entries sent
├── data/farmmate_cib_knowledge_base.md  ← human-readable version, for reference only (not used at runtime)
├── wrangler.jsonc       ← Cloudflare Worker config
└── package.json
```

## One-time setup (new FarmMate-only GitHub + Cloudflare accounts)

### 1. Push this repo to GitHub
1. Create a new empty repo under your new FarmMate GitHub account, e.g. `farmmate-chatbot-worker`.
2. Unzip this folder locally, then from inside it:
   ```
   git init
   git add .
   git commit -m "Initial FarmMate chatbot worker"
   git branch -M main
   git remote add origin https://github.com/<your-farmmate-github>/farmmate-chatbot-worker.git
   git push -u origin main
   ```

### 2. Connect Cloudflare to this GitHub repo
1. Log in to your new Cloudflare account → **Workers & Pages** → **Create** → **Workers** → **Connect to Git**.
2. Authorize Cloudflare to access your new FarmMate GitHub account, select this repo.
3. Build settings: framework preset "None", build command empty, deploy command `npx wrangler deploy` (Cloudflare usually auto-detects this from `wrangler.jsonc`).
4. Every push to `main` will now auto-deploy, same as your other Cloudflare Worker sites.

### 3. Create the KV namespace (stores the knowledge-base data)
Install Wrangler locally once (`npm install`), then log in and create the namespace:
```
npx wrangler login
npx wrangler kv namespace create FARMMATE_KB
```
This prints a namespace `id`. Copy it into `wrangler.jsonc`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`. Commit and push that change so it deploys.

### 4. Upload the knowledge-base data into KV
```
npm run kv:upload-all
```
This uploads `data/index.json` and `data/lookup.json` into the KV namespace
under the keys `index` and `lookup` — exactly what `src/index.js` reads at
runtime. Re-run this any time you regenerate the CIB data (e.g. after adding
more products or university data later).

### 5. Set your Anthropic API key as a secret
```
npx wrangler secret put ANTHROPIC_API_KEY
```
Paste your API key when prompted. This keeps it out of the repo/GitHub entirely.

### 6. Test it
After the first deploy, Cloudflare gives you a `*.workers.dev` URL. Test with:
```
curl -X POST https://farmmate-chatbot.<your-subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"message": "Cotton mein safed makkhi lag gayi hai, kya use karun?"}'
```
You should get back a JSON `{ "reply": "..." }` recommending a matching
FarmMate product with the correct per-acre dose.

### 7. Point the Shopify widget at this Worker
Update the chatbot widget's fetch URL (in your Shopify theme / embedded
script) to this Worker's URL — either the `workers.dev` one, or a custom
route/domain if you attach one under Cloudflare → Workers → Triggers →
Custom Domains.

## Notes
- Dosage figures in the CIB data are **per hectare** — the worker's system
  prompt already instructs Claude to convert to per-acre (÷ ~2.47) when
  replying to farmers.
- `data/farmmate_cib_knowledge_base.md` is not read by the Worker at
  runtime — it's kept in the repo just as a human-readable reference of
  what's inside `lookup.json`.
- Fertilizers/micronutrients are intentionally excluded from this dataset —
  CIB doesn't regulate them (that's under FCO), so they weren't cross-matched.

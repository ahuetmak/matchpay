# MatchPay (root) — Cloudflare Workers layout

Estructura EXACTA para Cloudflare:

- `wrangler.jsonc` ✅
- `src/index.ts` ✅ (porque `main` apunta ahí)
- `package.json` ✅
- `migrations/` ✅ (D1)

## En Cloudflare (Git deploy)
**Build command**
```bash
npm install
```

**Deploy command**
```bash
npx wrangler deploy
```

## Bindings necesarios
- D1: `MATCHPAY_DB`
- KV: `MATCHPAY_KV`

Luego corre migraciones:
```bash
npx wrangler d1 migrations apply MATCHPAY_DB --remote
```

## Health
`GET /health`

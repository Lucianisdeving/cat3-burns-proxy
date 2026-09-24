// CAT³ burn history proxy
// Runs on Vercel. Reads burn transactions for the CAT³ mint straight from
// the chain through Helius RPC, and returns a small clean JSON list.
// The Helius key stays on the server, the website never sees it.
//
// Environment variables (set in Vercel → Project → Settings → Environment Variables):
//   HELIUS_API_KEY   required  Helius key WITHOUT domain restrictions (server key)
//   MINT             optional  token mint, defaults to the CAT³ mint
//   ALLOWED_ORIGINS  optional  comma separated sites allowed to call this, e.g.
//                              https://cat3.games,https://cat3poker.framer.website
//   TAX_WALLET       optional  wallet that burns the token tax  → labelled "Token Tax"
//   RAKE_WALLET      optional  wallet that burns the poker rake → labelled "Poker Rake"

const DEFAULT_MINT = "C3FRzBZns86gP4ALAK38FiKnLbuVJEjbWzPsX2nQZ7tp"

async function rpc(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error("RPC HTTP " + res.status)
  return res.json()
}

// Collect every instruction, top level and inner (burns often sit inside CPIs).
function allInstructions(tx) {
  const list = [...(tx?.transaction?.message?.instructions || [])]
  for (const inner of tx?.meta?.innerInstructions || []) {
    list.push(...(inner.instructions || []))
  }
  return list
}

module.exports = async (req, res) => {
  // CORS: only our own sites may read this.
  const origin = req.headers.origin || ""
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (!allowed.length || allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", allowed.length ? origin : "*")
  }
  res.setHeader("Vary", "Origin")
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
  if (req.method === "OPTIONS") return res.status(204).end()

  const key = process.env.HELIUS_API_KEY
  if (!key) return res.status(500).json({ error: "Missing HELIUS_API_KEY", burns: [] })

  const mint = process.env.MINT || DEFAULT_MINT
  const url = `https://mainnet.helius-rpc.com/?api-key=${key}`
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 10, 50))

  const labels = {}
  if (process.env.TAX_WALLET) labels[process.env.TAX_WALLET.trim()] = "Token Tax"
  if (process.env.RAKE_WALLET) labels[process.env.RAKE_WALLET.trim()] = "Poker Rake"

  try {
    // 1. Token decimals, needed for plain "burn" instructions (raw amounts).
    const supply = await rpc(url, { jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: [mint] })
    const decimals = supply?.result?.value?.decimals ?? 0

    // 2. Latest signatures that touch the mint (every burn touches the mint).
    const sigRes = await rpc(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [mint, { limit: 100 }],
    })
    const sigs = (sigRes?.result || []).filter((s) => !s.err).map((s) => s.signature)
    if (!sigs.length) {
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600")
      return res.status(200).json({ burns: [], updated: Date.now() })
    }

    // 3. Fetch all those transactions in one batch request.
    const batch = sigs.map((sig, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "getTransaction",
      params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    }))
    const txs = await rpc(url, batch)

    // 4. Keep only burn instructions for our mint.
    const burns = []
    for (const item of Array.isArray(txs) ? txs : []) {
      const tx = item?.result
      if (!tx || tx.meta?.err) continue
      const signature = tx.transaction?.signatures?.[0]
      let amount = 0
      let authority = ""
      for (const ix of allInstructions(tx)) {
        const p = ix?.parsed
        if (!p || (p.type !== "burn" && p.type !== "burnChecked")) continue
        if (p.info?.mint && p.info.mint !== mint) continue
        const ui =
          p.info?.tokenAmount?.uiAmount ??
          (p.info?.amount ? Number(p.info.amount) / Math.pow(10, decimals) : 0)
        amount += Number(ui) || 0
        authority = authority || p.info?.authority || p.info?.multisigAuthority || ""
      }
      if (amount > 0) {
        burns.push({
          signature,
          timestamp: tx.blockTime ? tx.blockTime * 1000 : null,
          amount,
          source: labels[authority] || "Burn",
        })
      }
    }

    burns.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))

    // Cache on Vercel's edge for 5 minutes so the key is barely used.
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600")
    return res.status(200).json({ burns: burns.slice(0, limit), updated: Date.now() })
  } catch (e) {
    return res.status(502).json({ error: "Could not read the chain right now", burns: [] })
  }
}

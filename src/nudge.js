// build-nudge (BOOK-ONE-TO-QUARTZ §0a, §8 step 10). It starts quartz-book's
// `reconcile` workflow, and does nothing else:
//
//   POST /   a book's nudge.yml sends its GitHub OIDC token after a push. If the
//            token is genuine and names a branch of a book on the builder, this
//            dispatches `reconcile` for that book with woken_by "nudge".
//   cron     every 15 minutes, dispatches `reconcile` for every book with
//            woken_by "cron". GitHub schedules would switch themselves off in a
//            quiet public repo; a Cron Trigger doesn't.
//   GET /    what the serving version is, and whether its token works.
//
// Its one secret, DISPATCH_TOKEN, is a fine-grained token on quartz-book alone
// with Actions: write. The registry check is a spam filter, not a security
// boundary: the nudge only names a book, and `reconcile` reads the book's repo
// and branches from the registry itself. So a forged or replayed nudge costs at
// most one `reconcile` run that finds nothing to do.

export const ISSUER = "https://token.actions.githubusercontent.com"
const JWKS_URL = `${ISSUER}/.well-known/jwks`
const BUILDER = "quartz-book"

const JWKS_TTL = 60 * 60 * 1000
const REGISTRY_TTL = 5 * 60 * 1000
const STATUS_TTL = 5 * 60 * 1000
const CLOCK_SKEW = 60

// A nudge for a book whose run was dispatched this recently is coalesced
// without asking GitHub: the run's plan job can't have read the branch heads
// yet. After that, and up to COALESCE_WINDOW, a nudge is coalesced only while
// GitHub still lists that run as waiting to start. A run that has started may
// already have read the heads, so it can't stand in for a later push.
const COALESCE_CERTAIN = 10 * 1000
const COALESCE_WINDOW = 30 * 1000

let jwksCache = null // { keys, at }
let registryCache = null // { registry, at }
let statusCache = null // { status, at }
const lastDispatch = new Map() // slug -> ms

/** For tests: forget everything this isolate remembers. */
export function resetCaches() {
  jwksCache = registryCache = statusCache = null
  lastDispatch.clear()
}

export const json = (status, body) =>
  new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })

export class Refusal extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ---- The OIDC token ----------------------------------------------------------

const b64urlBytes = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)))

async function signingKey(kid, now) {
  const fresh = jwksCache && now - jwksCache.at < JWKS_TTL
  let jwk = fresh ? jwksCache.keys.find((k) => k.kid === kid) : undefined
  // GitHub rotates keys, so an unknown kid refetches once rather than refusing.
  if (!jwk) {
    const res = await fetch(JWKS_URL)
    if (!res.ok) throw new Error(`GitHub's signing keys answered ${res.status}.`)
    jwksCache = { keys: (await res.json()).keys ?? [], at: now }
    jwk = jwksCache.keys.find((k) => k.kid === kid)
  }
  if (!jwk) throw new Refusal(401, "The token was not signed by any of GitHub's current keys.")
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  )
}

/**
 * Checks the token's signature against GitHub's published keys, then its
 * issuer, audience and time, and returns its claims. Throws a Refusal (401).
 */
export async function verifyToken(token, { audience, now = Date.now() }) {
  const parts = String(token).split(".")
  if (parts.length !== 3) throw new Refusal(401, "The bearer value is not a JWT.")
  let header, claims
  try {
    header = b64urlJson(parts[0])
    claims = b64urlJson(parts[1])
  } catch {
    throw new Refusal(401, "The token's header or claims are not JSON.")
  }
  if (header.alg !== "RS256") throw new Refusal(401, `The token's algorithm is ${header.alg}, not RS256.`)

  const key = await signingKey(header.kid, now)
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), signed)
  if (!ok) throw new Refusal(401, "The token's signature does not verify.")

  const secs = Math.floor(now / 1000)
  if (claims.iss !== ISSUER) throw new Refusal(401, `The token's issuer is ${claims.iss}, not GitHub Actions.`)
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(audience)) throw new Refusal(401, `The token's audience is not ${audience}.`)
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW < secs) throw new Refusal(401, "The token has expired.")
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW > secs) throw new Refusal(401, "The token is not valid yet.")
  return claims
}

// ---- The registry ----------------------------------------------------------

async function readRegistry(url, now) {
  if (registryCache && now - registryCache.at < REGISTRY_TTL) return registryCache.registry
  const res = await fetch(url, { headers: { "user-agent": "build-nudge" } })
  if (!res.ok) {
    // Better a registry a little older than five minutes than no nudges at all.
    if (registryCache) return registryCache.registry
    throw new Error(`The registry answered ${res.status}.`)
  }
  registryCache = { registry: await res.json(), at: now }
  return registryCache.registry
}

/**
 * The book a pushed ref belongs to, the same books `reconcile` builds: on the
 * builder and not retired. Returns { slug, branch, built } or throws a Refusal (403).
 * `built` is false for a branch that is neither the book's live nor drafts branch.
 */
export function bookForPush(registry, claims) {
  if (claims.event_name !== "push") {
    throw new Refusal(403, `The token is from a ${claims.event_name} run. Only push runs nudge.`)
  }
  const ref = String(claims.ref ?? "")
  if (!ref.startsWith("refs/heads/")) throw new Refusal(403, `${ref || "The ref"} is not a branch.`)
  const branch = ref.slice("refs/heads/".length)

  const repo = String(claims.repository ?? "").toLowerCase()
  const book = (registry?.books ?? []).find(
    (b) =>
      b.site?.host?.builder === BUILDER &&
      b.status !== "retired" &&
      String(b.content?.repo ?? "").toLowerCase() === repo,
  )
  if (!book) {
    throw new Refusal(403, `${claims.repository} is not the repository of a book on the builder in the registry.`)
  }
  const built = branch === book.content.live_branch || branch === book.content.drafts_branch
  return { slug: book.slug, branch, built }
}

// ---- GitHub ----------------------------------------------------------------

const github = (env, path, init = {}) =>
  fetch(`https://api.github.com/repos/${env.BUILDER_REPO}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.DISPATCH_TOKEN}`,
      "user-agent": "build-nudge",
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  })

/** Starts `reconcile` on quartz-book's main. Throws if GitHub refuses. */
export async function dispatch(env, { slug, wokenBy }) {
  if (!env.DISPATCH_TOKEN) throw new Error("DISPATCH_TOKEN is not set on the serving version.")
  const res = await github(env, `/actions/workflows/${env.WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs: { slug, woken_by: wokenBy } }),
  })
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    throw new Error(`GitHub refused the dispatch with ${res.status}: ${detail}`)
  }
}

/** Whether a nudged run for this book is still waiting to start. */
async function nudgeRunWaiting(env, slug, now) {
  const since = new Date(now - COALESCE_WINDOW).toISOString()
  const res = await github(
    env,
    `/actions/workflows/${env.WORKFLOW}/runs?event=workflow_dispatch&per_page=30&created=${encodeURIComponent(">=" + since)}`,
  )
  // Can't tell: dispatch. A duplicate run costs seconds; a missed push costs 15 minutes.
  if (!res.ok) return false
  const { workflow_runs: runs = [] } = await res.json()
  return runs.some(
    (r) => r.display_title === `reconcile: nudge, ${slug}` && ["queued", "requested", "pending", "waiting"].includes(r.status),
  )
}

// ---- Handlers (src/index.js routes to these) -------------------------------

export async function handleNudge(request, env, now = Date.now()) {
  const auth = request.headers.get("authorization") ?? ""
  const match = auth.match(/^Bearer\s+(\S+)$/i)
  if (!match) throw new Refusal(401, "Send the OIDC token as Authorization: Bearer <token>.")

  const claims = await verifyToken(match[1], { audience: env.AUDIENCE, now })
  const registry = await readRegistry(env.REGISTRY_URL, now)
  const { slug, branch, built } = bookForPush(registry, claims)
  const said = { slug, branch, repository: claims.repository }

  if (!built) return json(200, { ...said, dispatched: false, reason: "Only the book's live and drafts branches are built." })

  const last = lastDispatch.get(slug)
  if (last !== undefined && now - last < COALESCE_CERTAIN) {
    return json(200, { ...said, dispatched: false, reason: "Coalesced: this book's run was dispatched seconds ago." })
  }
  if (await nudgeRunWaiting(env, slug, now)) {
    return json(200, { ...said, dispatched: false, reason: "Coalesced: this book's nudged run hasn't started yet." })
  }

  await dispatch(env, { slug, wokenBy: "nudge" })
  lastDispatch.set(slug, now)
  console.log(`nudge: dispatched reconcile for ${slug} (${claims.repository} ${branch} ${claims.sha})`)
  return json(202, { ...said, dispatched: true })
}

/** GET /: enough to tell, from outside, which version serves and whether its token works. */
export async function handleStatus(env, now = Date.now()) {
  if (!statusCache || now - statusCache.at >= STATUS_TTL) {
    let token = "missing"
    let tokenExpires = null
    if (env.DISPATCH_TOKEN) {
      const res = await github(env, "")
      token = res.ok ? "works" : `refused (${res.status})`
      // Sent with every API answer to a token that has an expiry date.
      tokenExpires = res.headers.get("github-authentication-token-expiration")
    }
    statusCache = { status: { token, token_expires: tokenExpires, checked_at: new Date(now).toISOString() }, at: now }
  }
  return json(200, {
    worker: "build-nudge",
    version: env.VERSION?.id ?? null,
    // The commit deploy.yml tagged this version with (`wrangler deploy --tag`),
    // or null for a version deployed by hand without one.
    commit: env.VERSION?.tag || null,
    builder: env.BUILDER_REPO,
    workflow: env.WORKFLOW,
    ...statusCache.status,
  })
}

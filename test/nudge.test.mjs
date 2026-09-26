// The Worker's decisions, against a key pair made here in place of GitHub's, a
// stubbed fetch in place of GitHub and the registry, and a fixed clock.
import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"
import worker from "../src/index.js"
import { ISSUER, bookForPush, handleNudge, handleStatus, resetCaches, verifyToken } from "../src/nudge.js"

const AUDIENCE = "https://build-nudge.brandonproject2026.workers.dev"
// Now, to the second: the tests through worker.fetch use the real clock.
const NOW = Math.floor(Date.now() / 1000) * 1000
const SECS = NOW / 1000

const env = {
  AUDIENCE,
  BUILDER_REPO: "textbookproject2026-alt/quartz-book",
  WORKFLOW: "reconcile.yml",
  REGISTRY_URL: "https://registry.test/registry.json",
  DISPATCH_TOKEN: "github_pat_test",
  VERSION: { id: "v-123", tag: "a".repeat(40) },
}

const book = (slug, repo, host, extra = {}) => ({
  slug,
  status: "live",
  content: { repo, live_branch: "main", drafts_branch: "drafts" },
  site: { host },
  ...extra,
})
const registry = {
  books: [
    book("social-research-methods", "textbookproject2026-alt/textbook", {
      kind: "obsidian-publish",
      builder: "quartz-book",
      project: "social-research-methods",
    }),
    book("platform-test-book", "dept-coordinator-test/platform-test-book", {
      kind: "static",
      provider: "cloudflare-pages",
      project: "platform-test-book",
    }),
    book("old-book", "someone/old-book", { kind: "static", builder: "quartz-book", project: "old-book" }, { status: "retired" }),
  ],
}

const newKeyPair = () =>
  crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )
const { publicKey, privateKey } = await newKeyPair()
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1", use: "sig" }
const b64url = (bytes) => Buffer.from(bytes).toString("base64url")

async function mint(claims = {}, { alg = "RS256", kid = "k1", key = privateKey } = {}) {
  const header = b64url(JSON.stringify({ alg, kid, typ: "JWT" }))
  const body = b64url(
    JSON.stringify({
      iss: ISSUER,
      aud: AUDIENCE,
      iat: SECS - 10,
      nbf: SECS - 10,
      exp: SECS + 290,
      event_name: "push",
      ref: "refs/heads/drafts",
      sha: "abc123",
      repository: "textbookproject2026-alt/textbook",
      ...claims,
    }),
  )
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${body}`))
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`
}

// Every outbound request, and GitHub's answers.
let calls
let runs
let dispatchStatus
beforeEach(() => {
  resetCaches()
  calls = []
  runs = []
  dispatchStatus = 204
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers })
    if (u === `${ISSUER}/.well-known/jwks`) return Response.json({ keys: [jwk] })
    if (u === env.REGISTRY_URL) return Response.json(registry)
    if (u.endsWith("/actions/workflows/reconcile.yml/dispatches")) return new Response(null, { status: dispatchStatus })
    if (u.includes("/actions/workflows/reconcile.yml/runs?")) return Response.json({ workflow_runs: runs })
    if (u === "https://api.github.com/repos/textbookproject2026-alt/quartz-book") {
      return Response.json({}, { headers: { "github-authentication-token-expiration": "2027-09-24 00:00:00 UTC" } })
    }
    throw new Error(`unexpected fetch ${u}`)
  }
})

const dispatches = () => calls.filter((c) => c.url.endsWith("/dispatches"))
const nudge = async (token, now = NOW) =>
  handleNudge(new Request(AUDIENCE, { method: "POST", headers: { authorization: `Bearer ${token}` } }), env, now)
const post = async (token, e = env) =>
  worker.fetch(new Request(AUDIENCE, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} }), e)

describe("verifyToken", () => {
  it("accepts a token GitHub signed for this audience", async () => {
    const claims = await verifyToken(await mint(), { audience: AUDIENCE, now: NOW })
    assert.equal(claims.repository, "textbookproject2026-alt/textbook")
  })

  const refused = [
    ["another audience", () => mint({ aud: "https://elsewhere.example" })],
    ["another issuer", () => mint({ iss: "https://evil.example" })],
    ["an expired token", () => mint({ exp: SECS - 120 })],
    ["a token not valid yet", () => mint({ nbf: SECS + 120 })],
    ["alg none", () => mint({}, { alg: "none" })],
    ["an unknown key", () => mint({}, { kid: "k9" })],
  ]
  for (const [what, make] of refused) {
    it(`refuses ${what}`, async () => {
      await assert.rejects(verifyToken(await make(), { audience: AUDIENCE, now: NOW }), { status: 401 })
    })
  }

  it("refuses a token whose claims were changed after signing", async () => {
    const [h, , s] = (await mint()).split(".")
    const forged = b64url(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, exp: SECS + 60, repository: "x/y" }))
    await assert.rejects(verifyToken(`${h}.${forged}.${s}`, { audience: AUDIENCE, now: NOW }), { status: 401 })
  })

  it("refuses a token signed by another key with GitHub's kid", async () => {
    const other = await newKeyPair()
    await assert.rejects(verifyToken(await mint({}, { key: other.privateKey }), { audience: AUDIENCE, now: NOW }), {
      status: 401,
    })
  })
})

describe("bookForPush", () => {
  const push = (claims) => ({ event_name: "push", ref: "refs/heads/drafts", repository: "textbookproject2026-alt/textbook", ...claims })

  it("finds book one from its repository, ignoring case", () => {
    assert.deepEqual(bookForPush(registry, push({ repository: "TextbookProject2026-alt/Textbook" })), {
      slug: "social-research-methods",
      branch: "drafts",
      built: true,
    })
  })
  it("marks a branch other than live and drafts as not built", () => {
    assert.equal(bookForPush(registry, push({ ref: "refs/heads/cms/chapters/x" })).built, false)
  })
  it("refuses a repository that is no book's", () => {
    assert.throws(() => bookForPush(registry, push({ repository: "stranger/repo" })), { status: 403 })
  })
  it("refuses a book that isn't on the builder", () => {
    assert.throws(() => bookForPush(registry, push({ repository: "dept-coordinator-test/platform-test-book" })), { status: 403 })
  })
  it("refuses a retired book", () => {
    assert.throws(() => bookForPush(registry, push({ repository: "someone/old-book" })), { status: 403 })
  })
  it("refuses a tag and a pull request", () => {
    assert.throws(() => bookForPush(registry, push({ ref: "refs/tags/v1" })), { status: 403 })
    assert.throws(() => bookForPush(registry, push({ event_name: "pull_request" })), { status: 403 })
  })
})

describe("handleNudge", () => {
  it("dispatches reconcile on main for the book, woken_by nudge", async () => {
    const res = await nudge(await mint())
    assert.equal(res.status, 202)
    assert.deepEqual(dispatches().map((c) => c.body), [
      { ref: "main", inputs: { slug: "social-research-methods", woken_by: "nudge" } },
    ])
    assert.equal(dispatches()[0].headers.authorization, "Bearer github_pat_test")
  })

  it("answers 403 and dispatches nothing for an unregistered repository", async () => {
    const res = await post(await mint({ repository: "stranger/repo" }))
    assert.equal(res.status, 403)
    assert.equal(dispatches().length, 0)
  })

  it("answers 401 with no token, and 401 for a bad one", async () => {
    assert.equal((await post()).status, 401)
    assert.equal((await post("a.b.c")).status, 401)
    assert.equal(dispatches().length, 0)
  })

  it("dispatches nothing for a branch that isn't built", async () => {
    const res = await nudge(await mint({ ref: "refs/heads/feature" }))
    assert.equal(res.status, 200)
    assert.equal(dispatches().length, 0)
  })

  it("coalesces a replayed token seconds later", async () => {
    const token = await mint()
    assert.equal((await nudge(token)).status, 202)
    const again = await nudge(token, NOW + 3000)
    assert.equal(again.status, 200)
    assert.match((await again.json()).reason, /Coalesced/)
    assert.equal(dispatches().length, 1)
  })

  it("coalesces into a nudged run GitHub lists as queued, from another isolate", async () => {
    runs = [{ display_title: "reconcile: nudge, social-research-methods", status: "queued" }]
    assert.equal((await nudge(await mint())).status, 200)
    assert.equal(dispatches().length, 0)
  })

  it("dispatches again once the earlier run has started", async () => {
    await nudge(await mint())
    runs = [{ display_title: "reconcile: nudge, social-research-methods", status: "in_progress" }]
    assert.equal((await nudge(await mint(), NOW + 15000)).status, 202)
    assert.equal(dispatches().length, 2)
  })

  it("does not coalesce with a cron run or another book's run", async () => {
    runs = [
      { display_title: "reconcile: cron, every book", status: "queued" },
      { display_title: "reconcile: nudge, other-book", status: "queued" },
    ]
    assert.equal((await nudge(await mint())).status, 202)
  })

  it("answers 502 when GitHub refuses the dispatch", async () => {
    dispatchStatus = 401
    const res = await post(await mint())
    assert.equal(res.status, 502)
    assert.match((await res.json()).error, /401/)
  })

  it("answers 502, not a dispatch, when the serving version has no token", async () => {
    const res = await post(await mint(), { ...env, DISPATCH_TOKEN: undefined })
    assert.equal(res.status, 502)
    assert.match((await res.json()).error, /DISPATCH_TOKEN is not set/)
  })
})

describe("scheduled", () => {
  it("dispatches reconcile for every book, woken_by cron", async () => {
    await worker.scheduled({}, env)
    assert.deepEqual(dispatches().map((c) => c.body), [{ ref: "main", inputs: { slug: "", woken_by: "cron" } }])
  })
  it("throws when the dispatch fails, so the Cron event shows as failed", async () => {
    dispatchStatus = 403
    await assert.rejects(worker.scheduled({}, env), /403/)
  })
})

describe("status", () => {
  it("reports the serving version, and that its token works, with its expiry", async () => {
    const body = await (await handleStatus(env, NOW)).json()
    assert.equal(body.version, "v-123")
    assert.equal(body.commit, "a".repeat(40))
    assert.equal(body.token, "works")
    assert.equal(body.token_expires, "2027-09-24 00:00:00 UTC")
  })
  it("reports no commit for a version deployed without a tag", async () => {
    const body = await (await handleStatus({ ...env, VERSION: { id: "v-9", tag: "" } }, NOW)).json()
    assert.equal(body.commit, null)
  })
  it("reports a missing token without calling GitHub", async () => {
    const body = await (await handleStatus({ ...env, DISPATCH_TOKEN: undefined }, NOW)).json()
    assert.equal(body.token, "missing")
    assert.equal(calls.length, 0)
  })
})

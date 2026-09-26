# build-nudge

The Cloudflare Worker that starts builds (BOOK-ONE-TO-QUARTZ §0a, §8 step 10 in
`textbook-registry`). It dispatches `quartz-book`'s `reconcile` workflow, and
does nothing else:

- **A nudge.** A book's `.github/workflows/nudge.yml` runs on every push and
  POSTs a GitHub OIDC token here. The Worker checks the token's signature against
  GitHub's published keys, its issuer, its audience (this Worker's address) and
  its expiry. It also checks that it came from a `push` to a branch, and that its
  `repository` is the content repo of a book on the builder in the registry. Then
  it dispatches `reconcile` with `slug` and `woken_by: nudge`. A push to a branch
  other than the book's live or drafts branch dispatches nothing.
- **The tick.** A Cron Trigger (`*/15 * * * *`) dispatches `reconcile` for every
  book with `woken_by: cron`. This catches what nudges miss (bot merges, a book
  with Actions off) and registry or builder changes. It is here, not a GitHub
  `schedule:`, because GitHub turns schedules off in a public repo after 60 quiet
  days.
- **`GET /`** reports the serving version's ID, the commit it was deployed from, and
  whether its token works:

  ```json
  { "worker": "build-nudge", "version": "…", "commit": "…", "token": "works", "token_expires": "2027-09-23 22:00:00 UTC" }
  ```

`reconcile` never trusts what woke it: it compares each book's served marker with
what it would build. So the registry check here is a spam filter, not a security
boundary, and a forged or replayed nudge costs at most one run that does nothing.
Repeat nudges for one book are coalesced while the run they would start is still
waiting to start.

**Address:** `https://build-nudge.brandonproject2026.workers.dev`, in the
Cloudflare account `brandonproject2026`. Every book's `nudge.yml` names it as the
token audience, so it must not move.

## Its one secret

`DISPATCH_TOKEN`: a fine-grained personal access token of
`textbookproject2026-alt` named **`build-nudge dispatch`**, on the repository
`quartz-book` only, with one permission, *Actions: Read and write* (plus the
*Metadata: Read* GitHub adds to every token). `workflow_dispatch` needs exactly
that. It can't read or write code, and it can't reach any other repository. Its
expiry date is in `textbook-registry/docs/INFRASTRUCTURE.md` (§7). When it lapses,
**nothing rebuilds automatically**, and `builder-alive` in the registry goes red.

There's no other secret. GitHub's signing keys and the registry are public.

## Deploying

**Every merge to `main` deploys.** When `test` is green on a push to `main`,
`.github/workflows/deploy.yml` runs `wrangler deploy --tag <commit>`. It then waits up to
five minutes for `GET /` to report that `commit` with `"token": "works"`, and goes red on
the merge commit if it doesn't. It needs two repository secrets: `CLOUDFLARE_API_TOKEN`
(Account → Workers Scripts: Edit, on `brandonproject2026`) and `CLOUDFLARE_ACCOUNT_ID`.
Without them the job fails and says so, and the Worker keeps its previous version.
`wrangler deploy` keeps the secret the serving version already has, so the GitHub token
is never held in Actions.

By hand, for example while those secrets are missing: from this directory, on a Mac
logged in to `brandonproject2026` (`npx wrangler login`, then `npx wrangler whoami` lists
that account):

```sh
npm ci
npm test
npx wrangler deploy --tag "$(git rev-parse HEAD)"
```

`wrangler deploy` keeps the secret the serving version already has. The tag is what
`GET /` reports as `commit` (`null` for a version deployed without one). Then check:

```sh
curl -s https://build-nudge.brandonproject2026.workers.dev/
npx wrangler deployments status
```

**Pass:** `"token": "works"`, `commit` is the commit you deployed, and the `version` in
the first equals the version at 100% in the second.

## Changing the token

Set a secret **only** with `wrangler versions secret put`, then deploy the version
it made. Don't set it in the dashboard. The CMS relay was down for an hour
because a dashboard secret attached itself to a version that wasn't serving,
while every setting looked right.

```sh
npx wrangler versions secret put DISPATCH_TOKEN
npx wrangler versions list
npx wrangler versions deploy <newest version ID>@100% --yes
curl -s https://build-nudge.brandonproject2026.workers.dev/
```

The status answer can be up to five minutes old within one running instance. A new
version always starts fresh, so `version` changes at once.

## When it is down

Nothing rebuilds on its own, and every book keeps serving its last deployment.
Run `reconcile` by hand until the Worker is back: `quartz-book` → Actions →
`reconcile` → Run workflow, branch `main`, `slug` empty. Logs: Cloudflare
dashboard → Workers & Pages → `build-nudge` → Observability, or
`npx wrangler tail`.

## Tests

`npm test` covers the token checks (against a key pair the test makes), the
registry match, coalescing, and both handlers, with GitHub stubbed.
`npm run check` bundles the Worker without deploying it.

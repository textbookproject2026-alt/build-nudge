// The Worker's entry point (§8 step 10). Only the default export may live here:
// workerd treats every named export of the main module as an entrypoint. The
// logic, and what the Worker is for, are in nudge.js.
import { Refusal, dispatch, handleNudge, handleStatus, json } from "./nudge.js"

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)
    if (pathname !== "/") return json(404, { error: "Not found." })
    try {
      if (request.method === "GET") return await handleStatus(env)
      if (request.method === "POST") return await handleNudge(request, env)
      return json(405, { error: "GET for status, POST to nudge." })
    } catch (err) {
      if (err instanceof Refusal) {
        console.log(`refused (${err.status}): ${err.message}`)
        return json(err.status, { dispatched: false, error: err.message })
      }
      console.error(`nudge failed: ${err.message}`)
      return json(502, { dispatched: false, error: err.message })
    }
  },

  // Every 15 minutes: reconcile for every book, and c4n-api's five-minute jobs (its
  // write backstop and history refresh) through the service binding C4N_JOBS, because
  // Cloudflare never ran c4n-api's own five-minute schedule (13 Oct). Neither waits on
  // or stops the other. Throws if either failed, so the Cron Trigger's event shows as
  // failed in the Worker's logs. builder-alive in the registry notices missing runs.
  async scheduled(event, env) {
    const [reconcile, jobs] = await Promise.allSettled([
      dispatch(env, { slug: "", wokenBy: "cron" }),
      env.C4N_JOBS ? env.C4N_JOBS.run(`build-nudge ${event?.cron || "*/15 * * * *"}`) : "no C4N_JOBS binding",
    ])
    if (reconcile.status === "fulfilled") console.log("cron: dispatched reconcile for every book")
    else console.error(`cron: reconcile not dispatched: ${reconcile.reason?.message}`)
    if (jobs.status === "fulfilled") console.log(`cron: c4n-api jobs: ${jobs.value}`)
    else console.error(`cron: c4n-api jobs failed: ${jobs.reason?.message}`)
    if (reconcile.status === "rejected") throw reconcile.reason
    if (jobs.status === "rejected") throw jobs.reason
  },
}

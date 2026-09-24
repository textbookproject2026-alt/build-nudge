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

  // Throws on failure, so the Cron Trigger's event shows as failed in the
  // Worker's logs. builder-alive in the registry notices the missing runs.
  async scheduled(_event, env) {
    await dispatch(env, { slug: "", wokenBy: "cron" })
    console.log("cron: dispatched reconcile for every book")
  },
}

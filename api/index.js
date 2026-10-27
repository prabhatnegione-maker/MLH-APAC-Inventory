import { createApp } from "../server.js";

export function createVercelHandler(factory = createApp) {
  let app;
  return async function handler(req, res) {
    try {
      // Initialise once per warm function instance. Never use temporary files as
      // inventory storage, and require authentication for an Internet deployment.
      app ||= factory({ hosted: true });
    } catch {
      res.writeHead(503, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(
        JSON.stringify({
          error:
            "Deployment setup is incomplete. Configure TURSO_DATABASE_URL, TURSO_AUTH_TOKEN and INVENTORY_PASSWORD in Vercel, then redeploy.",
        }),
      );
    }
    return app.handler(req, res);
  };
}
export default createVercelHandler();

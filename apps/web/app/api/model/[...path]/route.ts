import { NextResponse } from "next/server";
import { accountFromAuthHeader } from "@/lib/session";
import { recordUsage } from "@/lib/db";

/**
 * The shared-key model gateway.
 *
 * This is what makes one nvapi key serve every account without any of them
 * holding it. A logged-in terminal points Recursive here and authenticates with
 * its ACCOUNT token (from `recursive login`), not the model key. The gateway:
 *
 *   1. resolves the account from the token,
 *   2. forwards the request upstream with the real key, held only here,
 *   3. records how many tokens that account just spent.
 *
 * So the key lives in exactly one place (this server's env), and the dashboard
 * can show precisely which account used how much of the shared limit.
 *
 * The upstream key's own limit still applies across everyone. For the NVIDIA
 * free tier that is 40 RPM total; swap MODEL_UPSTREAM_KEY for a paid key at
 * launch and nothing else changes.
 */

const UPSTREAM = (process.env.MODEL_UPSTREAM_BASE || "https://integrate.api.nvidia.com").replace(
  /\/+$/,
  "",
);
const KEY = process.env.MODEL_UPSTREAM_KEY; // the shared nvapi key, server-side only

async function handle(request: Request, path: string[]): Promise<Response> {
  const account = await accountFromAuthHeader(request.headers.get("authorization"));
  if (!account) {
    return NextResponse.json(
      { error: "Not signed in. Run `recursive login` to connect this terminal." },
      { status: 401 },
    );
  }
  if (!KEY) {
    return NextResponse.json(
      { error: "The dashboard has no model key configured (set MODEL_UPSTREAM_KEY)." },
      { status: 503 },
    );
  }

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM}/${path.join("/")}`, {
      method: request.method,
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body,
    });
  } catch (error) {
    return NextResponse.json({ error: `upstream unreachable: ${String(error)}` }, { status: 502 });
  }

  const text = await upstream.text();

  // Meter the call. The usage block is on chat/completions responses; parse it
  // best-effort so a shape we do not recognise never breaks the proxy.
  try {
    if (path.join("/").includes("chat/completions")) {
      const json = JSON.parse(text) as {
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      await recordUsage({
        accountId: account.id,
        model: json.model ?? "unknown",
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        ok: upstream.ok,
      });
    }
  } catch {
    /* not JSON, or no usage block; still forward the response verbatim */
  }

  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return handle(request, path);
}

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return handle(request, path);
}

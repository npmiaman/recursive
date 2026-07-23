# Recursive model proxy

Host the model key in one place so no laptop needs it.

Recursive itself runs locally (it reads your code, drives a browser, edits
files), so you cannot host *Recursive* for other machines. But you can host the
*model*: this proxy holds one upstream key server-side and forwards
OpenAI-compatible requests to it. A laptop then points Recursive at the proxy and
presents a shared token instead of the real key.

```
laptop (recursive)  --Bearer PROXY_TOKEN-->  proxy (holds NVIDIA_API_KEY)  -->  NVIDIA
```

The upstream key never leaves the proxy. Rotate it once, everyone keeps working.

## Deploy

It is one file with no dependencies. Anywhere that runs Node works.

Set two environment variables on the host:

| Var | Purpose |
|---|---|
| `NVIDIA_API_KEY` | the real `nvapi-...` key (required) |
| `PROXY_TOKEN` | a shared secret laptops must present (strongly recommended) |
| `UPSTREAM_BASE` | override the upstream (default `https://integrate.api.nvidia.com`) |

`PROXY_TOKEN` is not the upstream key. It only grants access to the proxy, and
you can rotate it without touching the real key. Without it the proxy is open to
anyone who finds the URL.

### Railway / Render / Fly / a VPS

```bash
NVIDIA_API_KEY=nvapi-...  PROXY_TOKEN=pick-a-long-secret  node apps/proxy/server.mjs
```

Point the host at `apps/proxy/server.mjs` as the start command, set the two env
vars in its dashboard, and expose the port (default 8787).

### Vercel / Cloudflare

The handler is plain `fetch`-style forwarding; adapt the body of `server.mjs`
into a single serverless function or Worker, reading the same env vars. The
forwarding logic is the same fifteen lines.

## Point a laptop at it

Once deployed at, say, `https://models.yourteam.dev`:

```bash
recursive config proxy https://models.yourteam.dev/v1 pick-a-long-secret
```

That is the whole setup on each machine. No `nvapi-` key anywhere on the laptop.
`recursive doctor` will verify the model works through the proxy with a live
call.

Note the `/v1` on the URL: Recursive appends `/chat/completions`, so the proxy
must receive `/v1/chat/completions`.

## The limit still applies

One upstream key means one rate limit shared across every laptop pointed here. On
NVIDIA's free tier that is 40 requests/min total, which suits a few machines
testing. For launch, put a paid key in `NVIDIA_API_KEY` (or set `UPSTREAM_BASE`
and the key to another provider) and the same proxy keeps working, with the
higher limit, still with nothing on the laptops.

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const apiKey = process.env.ODDSPAPI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "ODDSPAPI_API_KEY is not configured" });
    }

    const allowed = [
      "fixtureId", "bookmakers", "oddsFormat", "language", "verbosity"
    ];

    const params = new URLSearchParams();
    for (const name of allowed) {
      if (req.query?.[name] !== undefined) {
        params.set(name, String(req.query[name]));
      }
    }

    if (!params.get("fixtureId")) {
      return res.status(400).json({ ok: false, error: "fixtureId is required" });
    }

    params.set("apiKey", apiKey);

    const url = `https://api.oddspapi.io/v4/odds?${params.toString()}`;
    const response = await fetch(url);
    const text = await response.text();

    res.status(response.status);
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Proxy error",
      details: error instanceof Error ? error.message : String(error)
    });
  }
}

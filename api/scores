export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed"
      });
    }

    const apiKey = process.env.ODDSPAPI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "ODDSPAPI_API_KEY is not configured"
      });
    }

    const fixtureId = req.query?.fixtureId;

    if (
      typeof fixtureId !== "string" ||
      fixtureId.trim() === ""
    ) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId is required"
      });
    }

    const params = new URLSearchParams();

    params.set("fixtureId", fixtureId);
    params.set("apiKey", apiKey);

    const url =
      `https://api.oddspapi.io/v4/scores?${params.toString()}`;

    const response = await fetch(url);

    const text = await response.text();

    res.status(response.status);

    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") ||
      "application/json"
    );

    return res.send(text);

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Scores proxy error",
      details:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
}

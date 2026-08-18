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

    if (!fixtureId) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId is required"
      });
    }

    /*
     * Zabezpieczenie przed przypadkowym wysłaniem
     * nieprawidłowego identyfikatora.
     */
    if (
      typeof fixtureId !== "string" ||
      (!fixtureId.startsWith("id") && !fixtureId.startsWith("pn"))
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid fixtureId",
        details: "fixtureId must start with id or pn"
      });
    }

    /*
     * Domyślnie pobieramy tylko Pinnacle.
     * To znacząco ogranicza rozmiar odpowiedzi.
     */
    const bookmakers =
      req.query?.bookmakers
        ? String(req.query.bookmakers)
        : "pinnacle";

    /*
     * Dla naszego zastosowania wystarczy minimalna
     * szczegółowość odpowiedzi.
     */
    const language =
      req.query?.language
        ? String(req.query.language)
        : "en";

    const verbosity = 1;

    const params = new URLSearchParams();

    params.set("fixtureId", fixtureId);
    params.set("bookmakers", bookmakers);
    params.set("oddsFormat", "decimal");
    params.set("language", language);
    params.set("verbosity", String(verbosity));
    params.set("apiKey", apiKey);

    const url =
      `https://api.oddspapi.io/v4/odds?${params.toString()}`;

    const response = await fetch(url);

    const text = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: "OddsPAPI error",
        status: response.status,
        details: text.slice(0, 2000)
      });
    }

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({
        ok: false,
        error: "Invalid JSON returned by OddsPAPI"
      });
    }

    /*
     * Jeżeli fixture istnieje, ale nie ma aktualnych kursów.
     */
    if (!data.hasOdds || !data.bookmakerOdds) {
      return res.status(200).json({
        ok: true,
        fixtureId: data.fixtureId || fixtureId,
        hasOdds: false,
        message: "No odds available for this fixture"
      });
    }

    /*
     * Budujemy MAŁĄ odpowiedź dla ChatGPT.
     *
     * Nie przekazujemy całego bookmakerOdds,
     * tylko aktualny rynek Winner.
     *
     * Tennis Winner market:
     * 121 = player 1
     * 122 = player 2
     */
    const result = {
      ok: true,
      fixtureId: data.fixtureId || fixtureId,
      sportId: data.sportId,
      tournamentId: data.tournamentId,
      statusId: data.statusId,
      hasOdds: data.hasOdds,
      startTime: data.startTime,
      participant1Id: data.participant1Id,
      participant2Id: data.participant2Id,
      participant1Name: data.participant1Name,
      participant2Name: data.participant2Name,
      tournamentName: data.tournamentName,
      bookmakers: {}
    };

    for (const [bookmakerName, bookmaker] of Object.entries(
      data.bookmakerOdds
    )) {
      if (!bookmaker || !bookmaker.markets) {
        continue;
      }

      /*
       * Główny rynek tenisa: Winner / Moneyline.
       */
      const market = bookmaker.markets["121"];

      if (!market || !market.outcomes) {
        continue;
      }

      const player1 = market.outcomes["121"];
      const player2 = market.outcomes["122"];

      const bookmakerResult = {
        bookmakerIsActive:
          bookmaker.bookmakerIsActive ?? null,

        suspended:
          bookmaker.suspended ?? null,

        marketActive:
          market.marketActive ?? null,

        player1: null,
        player2: null
      };

      if (player1?.players?.["0"]) {
        const price = player1.players["0"];

        bookmakerResult.player1 = {
          price: price.price ?? null,
          changedAt: price.changedAt ?? null,
          active: price.active ?? null
        };
      }

      if (player2?.players?.["0"]) {
        const price = player2.players["0"];

        bookmakerResult.player2 = {
          price: price.price ?? null,
          changedAt: price.changedAt ?? null,
          active: price.active ?? null
        };
      }

      result.bookmakers[bookmakerName] = bookmakerResult;
    }

    /*
     * Jeżeli nie znaleźliśmy rynku Winner,
     * zwracamy informację zamiast ogromnej odpowiedzi.
     */
    if (Object.keys(result.bookmakers).length === 0) {
      return res.status(200).json({
        ok: true,
        fixtureId: data.fixtureId || fixtureId,
        hasOdds: true,
        participant1Name: data.participant1Name,
        participant2Name: data.participant2Name,
        tournamentName: data.tournamentName,
        message: "Odds available, but Winner market was not found"
      });
    }

    res.status(200);
    res.setHeader("Content-Type", "application/json");

    return res.json(result);

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Proxy error",
      details:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
}

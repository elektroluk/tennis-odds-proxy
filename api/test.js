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

    // ==========================================
    // 1. OKNO 24 GODZIN
    // ==========================================

    const now = new Date();
    const to = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const fromIso = now.toISOString();
    const toIso = to.toISOString();

    // ==========================================
    // 2. POBIERAMY MECZE TENISOWE
    // ==========================================

    const fixturesParams = new URLSearchParams({
      sportId: "12",
      from: fromIso,
      to: toIso,
      hasOdds: "true",
      statusId: "0",
      apiKey
    });

    const fixturesUrl =
      `https://api.oddspapi.io/v4/fixtures?${fixturesParams.toString()}`;

    const fixturesResponse = await fetch(fixturesUrl);
    const fixturesText = await fixturesResponse.text();

    if (!fixturesResponse.ok) {
      return res.status(fixturesResponse.status).json({
        ok: false,
        step: "fixtures",
        error: "OddsPapi fixtures request failed",
        status: fixturesResponse.status,
        details: fixturesText.slice(0, 1000)
      });
    }

    let fixturesData;

    try {
      fixturesData = JSON.parse(fixturesText);
    } catch {
      return res.status(502).json({
        ok: false,
        step: "fixtures",
        error: "Invalid JSON returned by OddsPapi"
      });
    }

    const fixtures = Array.isArray(fixturesData)
      ? fixturesData
      : Array.isArray(fixturesData?.fixtures)
        ? fixturesData.fixtures
        : [];

    // ==========================================
    // 3. FILTRUJEMY TYLKO NADCHODZĄCE MECZE
    // ==========================================

    const validFixtures = fixtures
      .filter((fixture) => {
        return (
          fixture &&
          fixture.statusId === 0 &&
          fixture.hasOdds === true &&
          typeof fixture.fixtureId === "string" &&
          /^(id|pn)/.test(fixture.fixtureId)
        );
      })
      .sort((a, b) => {
        return new Date(a.startTime) - new Date(b.startTime);
      });

    // ==========================================
    // 4. JEŻELI NIE MA MECZÓW
    // ==========================================

    if (validFixtures.length === 0) {
      return res.status(200).json({
        ok: false,
        message: "No suitable upcoming tennis fixtures with odds found",
        window: {
          from: fromIso,
          to: toIso,
          hours: 24
        },
        fixturesFound: fixtures.length
      });
    }

    // ==========================================
    // 5. POBIERAMY KURSY DLA MECZÓW
    //
    // Na razie testujemy pierwszy mecz.
    // Później możemy zrobić automatyczne
    // pobieranie kursów dla całej listy.
    // ==========================================

    const fixture = validFixtures[0];
    const fixtureId = fixture.fixtureId;

    const oddsParams = new URLSearchParams({
      fixtureId,
      bookmakers: "pinnacle",
      oddsFormat: "decimal",
      language: "en",
      verbosity: "1",
      apiKey
    });

    const oddsUrl =
      `https://api.oddspapi.io/v4/odds?${oddsParams.toString()}`;

    const oddsResponse = await fetch(oddsUrl);
    const oddsText = await oddsResponse.text();

    if (!oddsResponse.ok) {
      return res.status(oddsResponse.status).json({
        ok: false,
        step: "odds",
        error: "OddsPapi odds request failed",
        fixtureId,
        status: oddsResponse.status,
        details: oddsText.slice(0, 1000)
      });
    }

    let oddsData;

    try {
      oddsData = JSON.parse(oddsText);
    } catch {
      return res.status(502).json({
        ok: false,
        step: "odds",
        error: "Invalid JSON returned by OddsPapi",
        fixtureId
      });
    }

    // ==========================================
    // 6. TYLKO MARKET 121 = WINNER
    // ==========================================

    const pinnacle = oddsData?.bookmakerOdds?.pinnacle;

    const winnerMarket =
      pinnacle?.markets?.["121"] || null;

    let player1Price = null;
    let player2Price = null;

    if (winnerMarket?.outcomes) {

      const player1 =
        winnerMarket.outcomes["121"]?.players?.["0"];

      const player2 =
        winnerMarket.outcomes["122"]?.players?.["0"];

      if (player1?.price !== undefined) {
        player1Price = Number(player1.price);
      }

      if (player2?.price !== undefined) {
        player2Price = Number(player2.price);
      }
    }

    // ==========================================
    // 7. ZWRACAMY TYLKO MAŁY JSON
    // ==========================================

    return res.status(200).json({
      ok: true,

      testedAt: now.toISOString(),

      window: {
        from: fromIso,
        to: toIso,
        hours: 24
      },

      fixturesFound: fixtures.length,
      suitableFixturesFound: validFixtures.length,

      fixture: {
        fixtureId: fixture.fixtureId,
        participant1Id: fixture.participant1Id,
        participant2Id: fixture.participant2Id,
        participant1Name: fixture.participant1Name,
        participant2Name: fixture.participant2Name,
        sportId: fixture.sportId,
        tournamentId: fixture.tournamentId,
        tournamentName: fixture.tournamentName,
        statusId: fixture.statusId,
        hasOdds: fixture.hasOdds,
        startTime: fixture.startTime
      },

      odds: {
        bookmaker: "pinnacle",
        market: "winner",
        marketId: "121",
        suspended: pinnacle?.suspended ?? null,
        player1: player1Price,
        player2: player2Price
      }
    });

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

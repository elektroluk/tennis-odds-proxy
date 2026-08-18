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

    // --------------------------------------------------
    // 1. USTALAMY OKNO CZASOWE: TERAZ -> +6 GODZIN
    // --------------------------------------------------

    const now = new Date();
    const to = new Date(now.getTime() + 6 * 60 * 60 * 1000);

    const fromIso = now.toISOString();
    const toIso = to.toISOString();

    // --------------------------------------------------
    // 2. POBIERAMY AKTUALNE MECZE TENISOWE
    // --------------------------------------------------

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

    // API może zwrócić tablicę albo obiekt z polem fixtures.
    const fixtures = Array.isArray(fixturesData)
      ? fixturesData
      : Array.isArray(fixturesData?.fixtures)
        ? fixturesData.fixtures
        : [];

    // --------------------------------------------------
    // 3. DODATKOWA WALIDACJA
    // --------------------------------------------------

    const validFixtures = fixtures
      .filter((fixture) => {
        return (
          fixture &&
          fixture.statusId === 0 &&
          fixture.hasOdds === true &&
          typeof fixture.fixtureId === "string" &&
          /^id|^pn/.test(fixture.fixtureId)
        );
      })
      .sort((a, b) => {
        return new Date(a.startTime) - new Date(b.startTime);
      });

    if (validFixtures.length === 0) {
      return res.status(200).json({
        ok: false,
        step: "fixtures",
        message: "No suitable upcoming tennis fixture with odds found",
        window: {
          from: fromIso,
          to: toIso
        },
        fixturesFound: fixtures.length
      });
    }

    // --------------------------------------------------
    // 4. WYBIERAMY PIERWSZY ŚWIEŻY MECZ
    // --------------------------------------------------

    const fixture = validFixtures[0];

    const fixtureId = fixture.fixtureId;

    // --------------------------------------------------
    // 5. POBIERAMY TYLKO PINNACLE
    //    I TYLKO DECIMAL ODDS
    // --------------------------------------------------

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

    // --------------------------------------------------
    // 6. WYCIĄGAMY TYLKO PINNACLE MONEYLINE
    // --------------------------------------------------

    const pinnacle = oddsData?.bookmakerOdds?.pinnacle;

    let moneyline = null;

    if (pinnacle?.markets) {
      for (const [marketId, market] of Object.entries(pinnacle.markets)) {

        // Rynek moneyline dla tenisa zwykle znajduje się
        // pod odpowiednim marketId. Nie zakładamy jednak
        // konkretnego numeru.

        if (!market?.outcomes) continue;

        for (const [outcomeId, outcome] of Object.entries(
          market.outcomes
        )) {

          const players = outcome?.players;

          if (!players || typeof players !== "object") continue;

          for (const [playerId, player] of Object.entries(players)) {

            if (!player || player.active === false) continue;

            const bookmakerOutcomeId =
              player.bookmakerOutcomeId;

            const price = Number(player.price);

            if (
              bookmakerOutcomeId &&
              Number.isFinite(price) &&
              price > 1
            ) {
              if (!moneyline) {
                moneyline = [];
              }

              moneyline.push({
                marketId,
                outcomeId,
                playerId,
                bookmakerOutcomeId,
                playerName: player.playerName ?? null,
                price
              });
            }
          }
        }
      }
    }

    // --------------------------------------------------
    // 7. ZWRACAMY MAŁĄ ODPOWIEDŹ
    // --------------------------------------------------

    return res.status(200).json({
      ok: true,

      testedAt: now.toISOString(),

      window: {
        from: fromIso,
        to: toIso,
        hours: 6
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
        hasOdds: Boolean(pinnacle),
        suspended: pinnacle?.suspended ?? null,
        moneyline
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

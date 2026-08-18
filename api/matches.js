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

    // =====================================================
    // 1. OKNO 24 GODZIN
    // =====================================================

    const now = new Date();

    const to = new Date(
      now.getTime() + 24 * 60 * 60 * 1000
    );

    const fromIso = now.toISOString();
    const toIso = to.toISOString();

    // =====================================================
    // 2. POBIERAMY MECZE TENISOWE
    // =====================================================

    const fixturesParams = new URLSearchParams({
      sportId: "12",
      from: fromIso,
      to: toIso,
      statusId: "0",
      hasOdds: "true",
      bookmakers: "pinnacle",
      language: "en",
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
        details: fixturesText.slice(0, 2000)
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

    // =====================================================
    // 3. FILTRUJEMY MECZE Z NASZEGO OKNA
    // =====================================================

    const validFixtures = fixtures
      .filter((fixture) => {
        if (!fixture) return false;

        if (fixture.statusId !== 0) return false;

        if (fixture.hasOdds !== true) return false;

        if (
          typeof fixture.fixtureId !== "string" ||
          !/^(id|pn)/.test(fixture.fixtureId)
        ) {
          return false;
        }

        const startTime = new Date(fixture.startTime);

        if (Number.isNaN(startTime.getTime())) {
          return false;
        }

        return (
          startTime >= now &&
          startTime <= to
        );
      })
      .sort((a, b) => {
        return (
          new Date(a.startTime) -
          new Date(b.startTime)
        );
      });

    if (validFixtures.length === 0) {
      return res.status(200).json({
        ok: true,
        window: {
          from: fromIso,
          to: toIso,
          hours: 24
        },
        fixturesFound: fixtures.length,
        suitableFixturesFound: 0,
        matchesWithWinnerOdds: 0,
        matches: []
      });
    }

    // =====================================================
    // 4. UNIKALNE TURNIEJE
    // =====================================================

    const tournamentIds = [
      ...new Set(
        validFixtures
          .map((fixture) => fixture.tournamentId)
          .filter(
            (id) =>
              id !== undefined &&
              id !== null
          )
          .map(String)
      )
    ];

    // =====================================================
    // 5. PACZKI MAKS. 5 TURNIEJÓW
    // =====================================================

    const tournamentBatches = [];

    for (
      let i = 0;
      i < tournamentIds.length;
      i += 5
    ) {
      tournamentBatches.push(
        tournamentIds.slice(i, i + 5)
      );
    }

    // =====================================================
    // 6. ODDS BY TOURNAMENTS
    //    RATE LIMIT 429 OBSŁUGIWANY AUTOMATYCZNIE
    // =====================================================

    const oddsFixtures = [];

    for (
      let batchIndex = 0;
      batchIndex < tournamentBatches.length;
      batchIndex++
    ) {
      const batch =
        tournamentBatches[batchIndex];

      let attempt = 0;
      let batchCompleted = false;

      while (!batchCompleted && attempt < 5) {
        attempt++;

        const oddsParams = new URLSearchParams({
          tournamentIds: batch.join(","),
          bookmakers: "pinnacle",
          language: "en",
          oddsFormat: "decimal",
          verbosity: "1",
          apiKey
        });

        const oddsUrl =
          `https://api.oddspapi.io/v4/odds-by-tournaments?${oddsParams.toString()}`;

        const oddsResponse = await fetch(oddsUrl);
        const oddsText = await oddsResponse.text();

        // -----------------------------------------------
        // RATE LIMIT
        // -----------------------------------------------

        if (oddsResponse.status === 429) {
          let retryMs = 1100;

          try {
            const errorData =
              JSON.parse(oddsText);

            if (
              errorData?.error?.retryMs &&
              Number.isFinite(
                Number(errorData.error.retryMs)
              )
            ) {
              retryMs =
                Number(
                  errorData.error.retryMs
                ) + 150;
            }
          } catch {
            // Domyślne 1100 ms.
          }

          await new Promise((resolve) =>
            setTimeout(resolve, retryMs)
          );

          continue;
        }

        // -----------------------------------------------
        // INNY BŁĄD
        // -----------------------------------------------

        if (!oddsResponse.ok) {
          return res.status(oddsResponse.status).json({
            ok: false,
            step: "odds-by-tournaments",
            error:
              "OddsPapi odds-by-tournaments request failed",
            status: oddsResponse.status,
            tournamentIds: batch,
            attempt,
            details:
              oddsText.slice(0, 2000)
          });
        }

        // -----------------------------------------------
        // PARSOWANIE
        // -----------------------------------------------

        let oddsData;

        try {
          oddsData =
            JSON.parse(oddsText);
        } catch {
          return res.status(502).json({
            ok: false,
            step: "odds-by-tournaments",
            error:
              "Invalid JSON returned by OddsPapi",
            tournamentIds: batch
          });
        }

        const batchFixtures =
          Array.isArray(oddsData)
            ? oddsData
            : Array.isArray(
                oddsData?.fixtures
              )
              ? oddsData.fixtures
              : [];

        oddsFixtures.push(
          ...batchFixtures
        );

        batchCompleted = true;
      }

      if (!batchCompleted) {
        return res.status(429).json({
          ok: false,
          step: "odds-by-tournaments",
          error:
            "OddsPapi rate limit could not be cleared",
          tournamentIds: batch,
          attempts: attempt
        });
      }

      // Przerwa pomiędzy kolejnymi batchami.
      if (
        batchIndex <
        tournamentBatches.length - 1
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1100)
        );
      }
    }

    // =====================================================
    // 7. MAPA ODDS PO fixtureId
    // =====================================================

    const oddsByFixtureId = new Map();

    for (const fixture of oddsFixtures) {
      if (
        fixture &&
        typeof fixture.fixtureId === "string"
      ) {
        oddsByFixtureId.set(
          fixture.fixtureId,
          fixture
        );
      }
    }

    // =====================================================
    // 8. BUDUJEMY PEŁNE MATCH INVENTORY
    //    + WINNER / PINNACLE JEŚLI DOSTĘPNY
    // =====================================================

    const matches = [];

    for (const fixture of validFixtures) {
      const oddsFixture =
        oddsByFixtureId.get(
          fixture.fixtureId
        );

      const pinnacle =
        oddsFixture?.bookmakerOdds?.pinnacle;

      const winnerMarket =
        pinnacle?.markets?.["121"];

      let player1Price = null;
      let player2Price = null;

      if (winnerMarket?.outcomes) {
        const player1 =
          winnerMarket.outcomes["121"]
            ?.players?.["0"];

        const player2 =
          winnerMarket.outcomes["122"]
            ?.players?.["0"];

        if (
          player1 &&
          player1.active !== false &&
          Number.isFinite(
            Number(player1.price)
          )
        ) {
          player1Price =
            Number(player1.price);
        }

        if (
          player2 &&
          player2.active !== false &&
          Number.isFinite(
            Number(player2.price)
          )
        ) {
          player2Price =
            Number(player2.price);
        }
      }

      const winnerAvailable =
        player1Price !== null &&
        player2Price !== null;

      matches.push({
        fixtureId:
          fixture.fixtureId,

        participant1Id:
          fixture.participant1Id,

        participant2Id:
          fixture.participant2Id,

        participant1Name:
          fixture.participant1Name,

        participant2Name:
          fixture.participant2Name,

        tournamentId:
          fixture.tournamentId,

        tournamentName:
          fixture.tournamentName,

        startTime:
          fixture.startTime,

        statusId:
          fixture.statusId,

        hasOdds:
          fixture.hasOdds === true,

        winnerAvailable,

        odds: {
          bookmaker: "pinnacle",
          market: "winner",
          marketId: "121",
          suspended:
            pinnacle?.suspended ?? null,
          player1:
            player1Price,
          player2:
            player2Price
        }
      });
    }

    // =====================================================
    // 9. ODPOWIEDŹ PRODUKCYJNA
    // =====================================================

    return res.status(200).json({
      ok: true,

      window: {
        from: fromIso,
        to: toIso,
        hours: 24
      },

      fixturesFound:
        fixtures.length,

      suitableFixturesFound:
        validFixtures.length,

      tournamentCount:
        tournamentIds.length,

      tournamentBatches:
        tournamentBatches.length,

      oddsFixturesReturned:
        oddsFixtures.length,

      matchesWithWinnerOdds:
        matches.filter(
          (match) =>
            match.winnerAvailable === true
        ).length,

      matches
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

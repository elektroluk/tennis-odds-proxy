export default async function handler(req, res) {
  try {
    // =====================================================
    // 0. KONFIGURACJA
    // =====================================================

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const trackerKey = process.env.TRACKER_API_KEY;

    if (!supabaseUrl || !supabaseKey || !trackerKey) {
      return res.status(500).json({
        ok: false,
        error: "Tracker environment is not fully configured"
      });
    }

    // =====================================================
    // 1. AUTORYZACJA
    // =====================================================

    const receivedKey = req.headers["x-tracker-key"];

    if (
      typeof receivedKey !== "string" ||
      receivedKey !== trackerKey
    ) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    // =====================================================
    // 2. GET — HISTORIA PREDYKCJI
    // =====================================================

    if (req.method === "GET") {
      const rawFixtureId = req.query?.fixtureId;
      const rawMarket = req.query?.market;
      const rawSelection = req.query?.selection;

      const market =
        typeof rawMarket === "string" &&
        rawMarket.trim() !== ""
          ? rawMarket.trim()
          : "winner";

      const fixtureId =
        typeof rawFixtureId === "string"
          ? rawFixtureId.trim()
          : "";

      const selection =
        typeof rawSelection === "string" &&
        rawSelection.trim() !== ""
          ? rawSelection.trim()
          : null;

      // ---------------------------------------------------
      // Specjalne wartości oznaczające:
      // "daj najnowszy snapshot"
      // ---------------------------------------------------

      const latestAliases = new Set([
        "",
        "latest",
        "unknown",
        "current",
        "most_recent"
      ]);

      const requestLatest =
        latestAliases.has(fixtureId.toLowerCase());

      // ---------------------------------------------------
      // Walidacja market
      // ---------------------------------------------------

      if (!market) {
        return res.status(400).json({
          ok: false,
          error: "market must be a non-empty string"
        });
      }

      // ---------------------------------------------------
      // Walidacja selection
      // ---------------------------------------------------

      if (
        rawSelection !== undefined &&
        rawSelection !== null &&
        (
          typeof rawSelection !== "string" ||
          rawSelection.trim() === ""
        )
      ) {
        return res.status(400).json({
          ok: false,
          error: "selection must be a non-empty string when provided"
        });
      }

      // ===================================================
      // 2A. BUDOWA ZAPYTANIA SUPABASE
      // ===================================================

      const params = new URLSearchParams();

      // Zawsze filtrujemy po rynku.
      params.set(
        "market",
        `eq.${market}`
      );

      // Jeżeli podano PRAWDZIWY fixtureId,
      // filtrujemy konkretny mecz.
      //
      // Jeżeli Action wysłał:
      // - latest
      // - unknown
      // - current
      // - most_recent
      // albo nie podał fixtureId,
      // pobieramy najnowsze snapshoty z danego marketu.
      if (!requestLatest) {
        params.set(
          "fixture_id",
          `eq.${fixtureId}`
        );
      }

      // Jeżeli selection została podana,
      // historia dotyczy WYŁĄCZNIE tej selection.
      if (selection !== null) {
        params.set(
          "selection",
          `eq.${selection}`
        );
      }

      // Rzeczywista kolejność snapshotów.
      params.set(
        "order",
        "created_at.desc"
      );

      // Dla konkretnego fixture'u możemy pobrać historię.
      // Dla latest/unknown pobieramy ostatnie snapshoty,
      // żeby mieć również previous.
      params.set(
        "limit",
        "50"
      );

      const supabaseEndpoint =
        `${supabaseUrl}/rest/v1/tennis_predictions?${params.toString()}`;

      // ===================================================
      // 2B. ODCZYT Z SUPABASE
      // ===================================================

      const supabaseResponse = await fetch(
        supabaseEndpoint,
        {
          method: "GET",
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
            "Content-Type": "application/json"
          }
        }
      );

      const responseText =
        await supabaseResponse.text();

      if (!supabaseResponse.ok) {
        return res.status(502).json({
          ok: false,
          error: "Supabase read failed",
          status: supabaseResponse.status,
          details: responseText.slice(0, 3000)
        });
      }

      let rows;

      try {
        rows = JSON.parse(responseText);
      } catch {
        rows = [];
      }

      if (!Array.isArray(rows)) {
        rows = [];
      }

      // ===================================================
      // 2C. LATEST / PREVIOUS
      // ===================================================

      const latest =
        rows.length > 0
          ? rows[0]
          : null;

      const previous =
        rows.length > 1
          ? rows[1]
          : null;

      // Jeżeli Action użył latest/unknown,
      // zwracamy rzeczywiste fixtureId najnowszego snapshotu.
      const resolvedFixtureId =
        latest?.fixture_id ??
        (
          requestLatest
            ? null
            : fixtureId
        );

      let deltaP = null;
      let deltaQuickP = null;

      // ---------------------------------------------------
      // Porównanie tylko:
      // fixtureId + market + selection
      // ---------------------------------------------------

      let sameSelection = false;

      if (latest && previous) {
        sameSelection =
          latest.fixture_id === previous.fixture_id &&
          latest.market === previous.market &&
          latest.selection === previous.selection;
      }

      if (
        sameSelection &&
        typeof latest.final_p === "number" &&
        Number.isFinite(latest.final_p) &&
        typeof previous.final_p === "number" &&
        Number.isFinite(previous.final_p)
      ) {
        deltaP =
          latest.final_p - previous.final_p;
      }

      if (
        sameSelection &&
        typeof latest.quick_p === "number" &&
        Number.isFinite(latest.quick_p) &&
        typeof previous.quick_p === "number" &&
        Number.isFinite(previous.quick_p)
      ) {
        deltaQuickP =
          latest.quick_p - previous.quick_p;
      }

      // ===================================================
      // 2D. ODPOWIEDŹ GET
      // ===================================================

      return res.status(200).json({
        ok: true,

        // To jest ID podane przez klienta.
        // Dla latest/unknown może być null/puste.
        fixtureId:
          fixtureId || null,

        // To jest rzeczywiste ID znalezionego snapshotu.
        resolvedFixtureId,

        market,

        selection,

        selectionFiltered:
          selection !== null,

        latestRequested:
          requestLatest,

        count:
          rows.length,

        latest,

        previous,

        sameSelection,

        deltaP,

        deltaQuickP,

        predictions:
          rows
      });
    }

    // =====================================================
    // 3. TYLKO GET / POST
    // =====================================================

    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed"
      });
    }

    // =====================================================
    // 4. POST — ZAPIS PREDYKCJI
    // =====================================================

    const body = req.body;

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Request body must be a JSON object"
      });
    }

    const {
      testId,
      modelVersion = "v3.9",
      predictions
    } = body;

    // -----------------------------------------------------
    // testId
    // -----------------------------------------------------

    if (
      typeof testId !== "string" ||
      testId.trim() === ""
    ) {
      return res.status(400).json({
        ok: false,
        error: "testId is required"
      });
    }

    // -----------------------------------------------------
    // predictions
    // -----------------------------------------------------

    if (!Array.isArray(predictions)) {
      return res.status(400).json({
        ok: false,
        error: "predictions must be an array"
      });
    }

    if (predictions.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "predictions array is empty"
      });
    }

    // =====================================================
    // 5. WALIDACJA I NORMALIZACJA
    // =====================================================

    const rows = [];

    for (let i = 0; i < predictions.length; i++) {
      const p = predictions[i];

      // ---------------------------------------------------
      // prediction object
      // ---------------------------------------------------

      if (
        !p ||
        typeof p !== "object" ||
        Array.isArray(p)
      ) {
        return res.status(400).json({
          ok: false,
          error: `Invalid prediction at index ${i}`
        });
      }

      // ---------------------------------------------------
      // fixtureId
      // ---------------------------------------------------

      if (
        typeof p.fixtureId !== "string" ||
        p.fixtureId.trim() === ""
      ) {
        return res.status(400).json({
          ok: false,
          error:
            `fixtureId is required at index ${i}`
        });
      }

      // ---------------------------------------------------
      // player1 / player2
      // ---------------------------------------------------

      if (
        typeof p.player1 !== "string" ||
        p.player1.trim() === "" ||
        typeof p.player2 !== "string" ||
        p.player2.trim() === ""
      ) {
        return res.status(400).json({
          ok: false,
          error:
            `player1 and player2 are required at index ${i}`
        });
      }

      // ---------------------------------------------------
      // selection
      // ---------------------------------------------------

      if (
        typeof p.selection !== "string" ||
        p.selection.trim() === ""
      ) {
        return res.status(400).json({
          ok: false,
          error:
            `selection is required at index ${i}`
        });
      }

      // ---------------------------------------------------
      // entryOdds
      // ---------------------------------------------------

      if (
        typeof p.entryOdds !== "number" ||
        !Number.isFinite(p.entryOdds) ||
        p.entryOdds <= 1
      ) {
        return res.status(400).json({
          ok: false,
          error:
            `entryOdds must be a number > 1 at index ${i}`
        });
      }

      // ---------------------------------------------------
      // finalP
      // ---------------------------------------------------

      if (
        typeof p.finalP !== "number" ||
        !Number.isFinite(p.finalP) ||
        p.finalP < 0 ||
        p.finalP > 100
      ) {
        return res.status(400).json({
          ok: false,
          error:
            `finalP must be between 0 and 100 at index ${i}`
        });
      }

      // ---------------------------------------------------
      // decision
      // ---------------------------------------------------

      if (
        typeof p.decision !== "string" ||
        p.decision.trim() === ""
      ) {
        return res.status(400).json({
          ok: false,
          error:
            `decision is required at index ${i}`
        });
      }

      // ===================================================
      // 5A. NORMALIZOWANY ROW
      // ===================================================

      rows.push({
        test_id:
          testId.trim(),

        model_version:
          typeof modelVersion === "string" &&
          modelVersion.trim() !== ""
            ? modelVersion.trim()
            : "v3.9",

        fixture_id:
          p.fixtureId.trim(),

        tournament:
          p.tournament ?? null,

        round:
          p.round ?? null,

        player1:
          p.player1.trim(),

        player2:
          p.player2.trim(),

        start_time:
          p.startTime ?? null,

        market:
          typeof p.market === "string" &&
          p.market.trim() !== ""
            ? p.market.trim()
            : "winner",

        selection:
          p.selection.trim(),

        entry_odds:
          p.entryOdds,

        quick_p:
          p.quickP ?? null,

        final_p:
          p.finalP,

        p_lower:
          p.pLower ?? null,

        p_upper:
          p.pUpper ?? null,

        implied_p:
          p.impliedP ?? null,

        fair_odds:
          p.fairOdds ?? null,

        edge_pp:
          p.edgePp ?? null,

        ev:
          p.ev ?? null,

        ev_conservative:
          p.evConservative ?? null,

        break_even:
          p.breakEven ?? null,

        bet_threshold_odds:
          p.betThresholdOdds ?? null,

        confidence:
          p.confidence ?? null,

        data_quality:
          p.dataQuality ?? null,

        market_quality:
          p.marketQuality ?? null,

        deviation_class:
          p.deviationClass ?? null,

        market_move_flag:
          p.marketMoveFlag ?? false,

        decision:
          p.decision.trim(),

        notes:
          p.notes ?? null
      });
    }

    // =====================================================
    // 6. ZAPIS DO SUPABASE
    // =====================================================

    const supabaseEndpoint =
      `${supabaseUrl}/rest/v1/tennis_predictions` +
      `?on_conflict=test_id,fixture_id,market,selection`;

    const supabaseResponse = await fetch(
      supabaseEndpoint,
      {
        method: "POST",

        headers: {
          "apikey": supabaseKey,

          "Authorization":
            `Bearer ${supabaseKey}`,

          "Content-Type":
            "application/json",

          "Prefer":
            "resolution=merge-duplicates,return=representation"
        },

        body:
          JSON.stringify(rows)
      }
    );

    const responseText =
      await supabaseResponse.text();

    if (!supabaseResponse.ok) {
      return res.status(502).json({
        ok: false,
        error: "Supabase insert failed",
        status: supabaseResponse.status,
        details:
          responseText.slice(0, 3000)
      });
    }

    // =====================================================
    // 7. PARSOWANIE ODPOWIEDZI
    // =====================================================

    let savedRows;

    try {
      savedRows =
        JSON.parse(responseText);
    } catch {
      savedRows = [];
    }

    // =====================================================
    // 8. ODPOWIEDŹ POST
    // =====================================================

    return res.status(200).json({
      ok: true,

      testId:
        testId.trim(),

      modelVersion:
        typeof modelVersion === "string" &&
        modelVersion.trim() !== ""
          ? modelVersion.trim()
          : "v3.9",

      received:
        rows.length,

      saved:
        Array.isArray(savedRows)
          ? savedRows.length
          : rows.length
    });

  } catch (error) {
    // =====================================================
    // 9. NIEOCZEKIWANY BŁĄD
    // =====================================================

    return res.status(500).json({
      ok: false,

      error:
        "Tracker proxy error",

      details:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
}

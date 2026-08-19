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
    // 2. GET — ODCZYT OSTATNIEJ PREDYKCJI
    // =====================================================

    if (req.method === "GET") {
      const fixtureId = req.query?.fixtureId;
      const market = req.query?.market || "winner";

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

      params.set(
        "fixture_id",
        `eq.${fixtureId}`
      );

      params.set(
        "market",
        `eq.${market}`
      );

      // testId ma format:
      // daily-YYYY-MM-DD-v3.9-HHMMSS
      // więc sortowanie malejące daje najnowszy snapshot.
      params.set(
        "order",
        "test_id.desc"
      );

      params.set(
        "limit",
        "20"
      );

      const supabaseEndpoint =
        `${supabaseUrl}/rest/v1/tennis_predictions?${params.toString()}`;

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

      return res.status(200).json({
        ok: true,
        fixtureId,
        market,
        count: Array.isArray(rows) ? rows.length : 0,
        predictions: Array.isArray(rows) ? rows : []
      });
    }

    // =====================================================
    // 3. POST — ZAPIS PREDYKCJI
    // =====================================================

    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed"
      });
    }

    // =====================================================
    // 4. WALIDACJA BODY
    // =====================================================

    const body = req.body;

    if (!body || typeof body !== "object") {
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

    if (
      typeof testId !== "string" ||
      testId.trim() === ""
    ) {
      return res.status(400).json({
        ok: false,
        error: "testId is required"
      });
    }

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
    // 5. NORMALIZACJA I WALIDACJA
    // =====================================================

    const rows = [];

    for (let i = 0; i < predictions.length; i++) {
      const p = predictions[i];

      if (!p || typeof p !== "object") {
        return res.status(400).json({
          ok: false,
          error: `Invalid prediction at index ${i}`
        });
      }

      if (
        typeof p.fixtureId !== "string" ||
        p.fixtureId.trim() === ""
      ) {
        return res.status(400).json({
          ok: false,
          error: `fixtureId is required at index ${i}`
        });
      }

      if (
        typeof p.player1 !== "string" ||
        typeof p.player2 !== "string"
      ) {
        return res.status(400).json({
          ok: false,
          error: `player1 and player2 are required at index ${i}`
        });
      }

      if (
        typeof p.selection !== "string" ||
        p.selection.trim() === ""
      ) {
        return res.status(400).json({
          ok: false,
          error: `selection is required at index ${i}`
        });
      }

      if (
        typeof p.entryOdds !== "number" ||
        !Number.isFinite(p.entryOdds) ||
        p.entryOdds <= 1
      ) {
        return res.status(400).json({
          ok: false,
          error: `entryOdds must be a number > 1 at index ${i}`
        });
      }

      if (
        typeof p.finalP !== "number" ||
        !Number.isFinite(p.finalP) ||
        p.finalP < 0 ||
        p.finalP > 100
      ) {
        return res.status(400).json({
          ok: false,
          error: `finalP must be between 0 and 100 at index ${i}`
        });
      }

      if (
        typeof p.decision !== "string" ||
        p.decision.trim() === ""
      ) {
        return res.status(400).json({
          ok: false,
          error: `decision is required at index ${i}`
        });
      }

      rows.push({
        test_id: testId,
        model_version: modelVersion,

        fixture_id: p.fixtureId,
        tournament: p.tournament ?? null,
        round: p.round ?? null,
        player1: p.player1,
        player2: p.player2,
        start_time: p.startTime ?? null,

        market: p.market ?? "winner",
        selection: p.selection,
        entry_odds: p.entryOdds,

        quick_p: p.quickP ?? null,
        final_p: p.finalP,
        p_lower: p.pLower ?? null,
        p_upper: p.pUpper ?? null,

        implied_p: p.impliedP ?? null,
        fair_odds: p.fairOdds ?? null,
        edge_pp: p.edgePp ?? null,
        ev: p.ev ?? null,
        ev_conservative: p.evConservative ?? null,
        break_even: p.breakEven ?? null,
        bet_threshold_odds: p.betThresholdOdds ?? null,

        confidence: p.confidence ?? null,
        data_quality: p.dataQuality ?? null,
        market_quality: p.marketQuality ?? null,

        deviation_class: p.deviationClass ?? null,
        market_move_flag: p.marketMoveFlag ?? false,

        decision: p.decision,

        notes: p.notes ?? null
      });
    }

    // =====================================================
    // 6. ZAPIS DO SUPABASE
    // =====================================================

    const supabaseEndpoint =
      `${supabaseUrl}/rest/v1/tennis_predictions?on_conflict=test_id,fixture_id,market,selection`;

    const supabaseResponse = await fetch(
      supabaseEndpoint,
      {
        method: "POST",
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates,return=representation"
        },
        body: JSON.stringify(rows)
      }
    );

    const responseText =
      await supabaseResponse.text();

    if (!supabaseResponse.ok) {
      return res.status(502).json({
        ok: false,
        error: "Supabase insert failed",
        status: supabaseResponse.status,
        details: responseText.slice(0, 3000)
      });
    }

    let savedRows;

    try {
      savedRows = JSON.parse(responseText);
    } catch {
      savedRows = [];
    }

    // =====================================================
    // 7. ODPOWIEDŹ
    // =====================================================

    return res.status(200).json({
      ok: true,
      testId,
      modelVersion,
      received: rows.length,
      saved: Array.isArray(savedRows)
        ? savedRows.length
        : rows.length
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Tracker proxy error",
      details:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
}

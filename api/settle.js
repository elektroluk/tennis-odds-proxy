export default async function handler(req, res) {
  try {
    // =====================================================
    // 0. TYLKO POST
    // =====================================================

    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed"
      });
    }

    // =====================================================
    // 1. KONFIGURACJA
    // =====================================================

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const trackerKey = process.env.TRACKER_API_KEY;

    if (!supabaseUrl) {
      return res.status(500).json({
        ok: false,
        error: "SUPABASE_URL is not configured"
      });
    }

    if (!supabaseKey) {
      return res.status(500).json({
        ok: false,
        error: "SUPABASE_SERVICE_ROLE_KEY is not configured"
      });
    }

    if (!trackerKey) {
      return res.status(500).json({
        ok: false,
        error: "TRACKER_API_KEY is not configured"
      });
    }

    // =====================================================
    // 2. AUTORYZACJA
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
    // 3. FIXTURE ID
    // =====================================================

    const { fixtureId } = req.body || {};

    if (
      typeof fixtureId !== "string" ||
      fixtureId.trim() === ""
    ) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId is required"
      });
    }

    // =====================================================
    // 4. POBIERZ PREDYKCJE Z SUPABASE
    // =====================================================

    const selectUrl =
      `${supabaseUrl}/rest/v1/tennis_predictions` +
      `?fixture_id=eq.${encodeURIComponent(fixtureId)}` +
      `&select=*`;

    const predictionsResponse = await fetch(selectUrl, {
      method: "GET",
      headers: {
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`
      }
    });

    const predictionsText =
      await predictionsResponse.text();

    if (!predictionsResponse.ok) {
      return res.status(502).json({
        ok: false,
        error: "Supabase select failed",
        status: predictionsResponse.status,
        details: predictionsText.slice(0, 3000)
      });
    }

    let predictions;

    try {
      predictions = JSON.parse(predictionsText);
    } catch {
      predictions = [];
    }

    if (!Array.isArray(predictions) || predictions.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "No predictions found for fixture",
        fixtureId
      });
    }

    // =====================================================
    // 5. POBIERZ WYNIK
    // =====================================================

    const host =
      req.headers.host || "tennis-odds-proxy.vercel.app";

    const protocol =
      req.headers["x-forwarded-proto"] || "https";

    const scoresUrl =
      `${protocol}://${host}/api/scores?fixtureId=${encodeURIComponent(fixtureId)}`;

    const scoresResponse = await fetch(scoresUrl);
    const scoresText = await scoresResponse.text();

    if (!scoresResponse.ok) {
      return res.status(502).json({
        ok: false,
        error: "Scores request failed",
        status: scoresResponse.status,
        details: scoresText.slice(0, 3000)
      });
    }

    let scoreData;

    try {
      scoreData = JSON.parse(scoresText);
    } catch {
      return res.status(502).json({
        ok: false,
        error: "Invalid scores response"
      });
    }

    // =====================================================
    // 6. ODCZYTAJ WYNIK MECZU
    // =====================================================

    const result =
      scoreData?.scores?.periods?.result;

    if (!result) {
      return res.status(409).json({
        ok: false,
        error: "Match result is not available yet",
        fixtureId
      });
    }

    const p1Score = Number(result.participant1Score);
    const p2Score = Number(result.participant2Score);

    if (
      !Number.isFinite(p1Score) ||
      !Number.isFinite(p2Score)
    ) {
      return res.status(409).json({
        ok: false,
        error: "Invalid match result",
        fixtureId
      });
    }

    // =====================================================
    // 7. USTAL ZWYCIĘZCĘ
    // =====================================================

    let winner;

    if (p1Score > p2Score) {
      winner = predictions[0].player1;
    } else if (p2Score > p1Score) {
      winner = predictions[0].player2;
    } else {
      return res.status(409).json({
        ok: false,
        error: "Draw result is invalid for tennis",
        fixtureId
      });
    }

    // =====================================================
    // 8. ROZLICZ KAŻDĄ PREDYKCJĘ
    // =====================================================

    const settled = [];

    for (const prediction of predictions) {
      const selection =
        String(prediction.selection || "").trim();

      const player1 =
        String(prediction.player1 || "").trim();

      const player2 =
        String(prediction.player2 || "").trim();

      const normalizedSelection =
        selection.toLowerCase();

      const normalizedWinner =
        String(winner).trim().toLowerCase();

      const normalizedPlayer1 =
        player1.toLowerCase();

      const normalizedPlayer2 =
        player2.toLowerCase();

      let resultStatus;

      if (
        normalizedSelection === normalizedWinner
      ) {
        resultStatus = "WIN";
      } else if (
        normalizedSelection === normalizedPlayer1 ||
        normalizedSelection === normalizedPlayer2
      ) {
        resultStatus = "LOSS";
      } else {
        resultStatus = "VOID";
      }

      // ---------------------------------------------------
      // PROFIT
      // ---------------------------------------------------

      let profit = null;

      const odds = Number(prediction.entry_odds);

      if (
        Number.isFinite(odds) &&
        odds > 1
      ) {
        if (resultStatus === "WIN") {
          profit = odds - 1;
        } else if (resultStatus === "LOSS") {
          profit = -1;
        } else if (resultStatus === "VOID") {
          profit = 0;
        }
      }

      // ---------------------------------------------------
      // UPDATE
      // ---------------------------------------------------

      const updateUrl =
        `${supabaseUrl}/rest/v1/tennis_predictions` +
        `?id=eq.${encodeURIComponent(prediction.id)}`;

      const updateResponse = await fetch(updateUrl, {
        method: "PATCH",
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
        body: JSON.stringify({
          result: resultStatus,
          profit,
          settled_at: new Date().toISOString()
        })
      });

      const updateText =
        await updateResponse.text();

      if (!updateResponse.ok) {
        return res.status(502).json({
          ok: false,
          error: "Supabase update failed",
          status: updateResponse.status,
          details: updateText.slice(0, 3000),
          predictionId: prediction.id
        });
      }

      settled.push({
        id: prediction.id,
        selection,
        result: resultStatus,
        profit
      });
    }

    // =====================================================
    // 9. ODPOWIEDŹ
    // =====================================================

    return res.status(200).json({
      ok: true,
      fixtureId,
      score: `${p1Score}:${p2Score}`,
      winner,
      predictions: settled.length,
      settled
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Settlement error",
      details:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
}

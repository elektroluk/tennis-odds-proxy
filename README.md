# tennis-odds-proxy

Small Vercel proxy for OddsPapi.

## Endpoints
- GET /api/fixtures
- GET /api/odds?fixtureId=...

The OddsPapi API key is read only from the Vercel environment variable:
ODDSPAPI_API_KEY

Do not put the key into these files.

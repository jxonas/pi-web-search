# pi-web-search

Pi extension package that adds two web tools:

- `web_search` — search the web through Perplexity Search API
- `web_fetch` — fetch and extract readable text from a specific URL

## Install (git)

```bash
pi install git:github.com/jxonas/pi-web-search
```

Or run it without installing permanently:

```bash
pi -e git:github.com/jxonas/pi-web-search
```

## Configuration

Set your Perplexity API key:

```bash
export PERPLEXITY_API_KEY="your_api_key_here"
```

Create/manage your key at: https://www.perplexity.ai/account/api

The key is read at tool execution time, so you can set/update it without restarting pi.

## Tools

### web_search

Searches the web and returns ranked results with title, URL, date, and snippet.

Parameters:
- `query` (required)
- `max_results` (optional, default: `5`, range: `1-20`)
- `allowed_domains` (optional)
- `blocked_domains` (optional)
- `search_recency_filter` (optional: `hour | day | week | month | year`)

Notes:
- `allowed_domains` and `blocked_domains` are mutually exclusive.
- Tool returns structured text errors with `isError: true` for recoverable handling.

### web_fetch

Fetches a known URL and returns readable text content.

Parameters:
- `url` (required, `http`/`https`)
- `max_chars` (optional, default: `15000`)

Notes:
- HTML is converted to plain text via lightweight extraction.
- Binary content types are rejected.

## Package metadata

This package is a Pi package (`"keywords": ["pi-package"]`) and exposes extensions via:

```json
"pi": {
  "extensions": ["./extensions"]
}
```

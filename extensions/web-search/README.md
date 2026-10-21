# Web Search

Web search tool backed by the [DeepSeek Search API](https://api-docs.deepseek.com/zh-cn/guides/search/).

## Setup

1. Create a DeepSeek API key in the [DeepSeek platform](https://platform.deepseek.com/).
2. Create `auth.json` in this directory with your key:

```json
{
  "deepseek_api_key": "YOUR_DEEPSEEK_API_KEY"
}
```

`auth.json` is ignored by git. The extension reads the key only from that file; no Google credentials or environment variables are used.

## Behavior

- The `web_search` tool posts to `https://api.deepseek.com/v1/tools/search`.
- `query`, `exactPhrases`, `excludeTerms`, and `site` are composed into one DeepSeek search query.
- `count` defaults to 5 and is capped at 10 results.
- Results keep each title, URL, and snippet. If DeepSeek returns no snippet, its longer `summary` is used instead.
- Empty searches return `No results found.`
- Missing/invalid credentials, HTTP errors, and malformed responses produce clear error messages.

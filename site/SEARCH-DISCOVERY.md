# Search and AI Discovery Handoff

Status date: 2026-09-30 (Asia/Seoul)

Maintainer handoff for measuring discovery and verifying the published result.

## Verified baseline

- The published site is `https://cappyeo.github.io/discord-mcp/`.
- The live root, `/start/`, `/tools/`, `/showcase/live-gaming-server/`,
  `robots.txt`, `sitemap-index.xml`, and `llms.txt` were reachable over HTTPS.
- The technical crawl baseline was healthy on September 30: canonical URLs,
  crawlable robots rules, sitemap publication, page titles/descriptions, and
  generated internal links were present.
- At the start of the audit the homepage had a generic title. This change sets
  `Discord MCP Server`, adds a direct product description, and identifies the
  publisher in visible content and structured data. Verify the deployed HTML.
- The GitHub repository description was observed live as corrected from 208 to
  209 tools.
- A Glama listing exists. Its overview was observed at 208 while generated tool
  schemas report 209; its changelog also contains older version information.
  Treat this as a listing freshness task, not evidence that the listing is
  absent.
- At the start of the audit the signed-in Chrome Search Console account showed
  only the Mindustry property. This change adds Google's public verification
  tag for the Discord MCP URL-prefix property. Complete verification after
  deployment before interpreting Search Console data. Keep account credentials
  and private analytics exports out of this document.

## Canonical project references

- Site: <https://cappyeo.github.io/discord-mcp/>
- Tutorial: <https://cappyeo.github.io/discord-mcp/start/>
- Tool reference: <https://cappyeo.github.io/discord-mcp/tools/>
- Live showcase: <https://cappyeo.github.io/discord-mcp/showcase/live-gaming-server/>
- Sitemap: <https://cappyeo.github.io/discord-mcp/sitemap-index.xml>
- LLM summary: <https://cappyeo.github.io/discord-mcp/llms.txt>
- Source: <https://github.com/cappyeo/discord-mcp>
- MCP Registry: <https://registry.modelcontextprotocol.io/v0.1/servers/io.github.cappyeo%2Fdiscord-mcp/versions/latest>

## Next measurements

After Search Console verification and the title correction deploy:

1. Run URL Inspection for the root, `/start/`, `/tools/`, and the showcase.
2. Record sitemap read/index status and any discovered-but-not-indexed URLs.
3. Record the first 28-day Search Console baseline, then compare with the next
   28 days: impressions, clicks, CTR, average position, exact queries,
   country, and device.
4. Separate indexing evidence from ranking evidence. A URL can be indexed
   without ranking for `discord mcp`, and a ranking change is not proof that
   crawlability changed.
5. Recheck the Glama overview, tool count, and changelog against the current
   release after its maintainer update.

Do not automate submissions or outreach from this handoff. Do not buy
backlinks, use link spam, or claim citations/ranking from `llms.txt` or JSON-LD.
Those files help machines understand the project but do not guarantee Google
ranking or AI citations.

## Official guidance

- [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)
- [SEO Starter Guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)
- [Google Search documentation](https://developers.google.com/search/docs)

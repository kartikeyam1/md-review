'use strict';
// Server-built doc links (#22 rule 1, 00 §6), with x = slug if set, else id.
// #21/#23 and the meta route use these; the MCP server and the CLI build the
// same links from their own env (server/mcp-server.js `docUrl`).
const { FRONTEND_URL, PUBLIC_BASE_URL, PUBLIC_BASE_URL_SET } = require('./config.cjs');

/** The SPA route for a doc: FRONTEND_URL/d/x. */
const appUrl = (x) => `${FRONTEND_URL}/d/${x}`;
/** The backend meta page for a doc: PUBLIC_BASE_URL/d/x (default origin included). */
const shareUrl = (x) => `${PUBLIC_BASE_URL}/d/${x}`;
/** The link handed out in REST/MCP/CLI responses: share_url only when PUBLIC_BASE_URL is set explicitly. */
const handedOutUrl = (x) => (PUBLIC_BASE_URL_SET ? shareUrl(x) : appUrl(x));

module.exports = { appUrl, shareUrl, handedOutUrl };

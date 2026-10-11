'use strict';
// Route: GET /github?url=. Returns NEXT when the request is not one of its own.
const { NEXT } = require('../http-util.cjs');

module.exports = async function github(req, res) {
  // GET /github?url=<github-url> — fetch file from GitHub
  if (req.method === 'GET' && req.url.startsWith('/github?')) {
    const params = new URL(req.url, `http://${req.headers.host}`);
    const ghUrl = params.searchParams.get('url');

    if (!ghUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
    }

    // Parse github.com blob URLs → raw URL
    // Supports: github.com/{owner}/{repo}/blob/{ref}/{path}
    //           raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
    let rawUrl = null;
    let filename = null;

    const blobMatch = ghUrl.match(
      /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/
    );
    const rawMatch = ghUrl.match(
      /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
    );

    if (blobMatch) {
      const [, owner, repo, ref, filePath] = blobMatch;
      rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
      filename = filePath.split('/').pop();
    } else if (rawMatch) {
      rawUrl = ghUrl;
      filename = rawMatch[4].split('/').pop();
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Not a recognized GitHub file URL' }));
    }

    const token = process.env.GITHUB_TOKEN || '';
    const headers = { 'User-Agent': 'md-review-paste-service' };
    if (token) headers['Authorization'] = `token ${token}`;

    const https = require('https');
    https.get(rawUrl, { headers }, (ghRes) => {
      if (ghRes.statusCode === 404) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'File not found on GitHub' }));
      }
      if (ghRes.statusCode < 200 || ghRes.statusCode >= 300) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `GitHub returned ${ghRes.statusCode}` }));
      }

      let body = '';
      ghRes.on('data', (chunk) => { body += chunk; });
      ghRes.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: body, filename }));
      });
    }).on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch from GitHub' }));
    });

    return;
  }

  return NEXT;
};

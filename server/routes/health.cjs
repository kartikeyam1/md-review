'use strict';
// Route: GET / health check. Returns NEXT when the request is not one of its own.
const { NEXT } = require('../http-util.cjs');

module.exports = async function health(req, res) {
  // GET / — health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  return NEXT;
};

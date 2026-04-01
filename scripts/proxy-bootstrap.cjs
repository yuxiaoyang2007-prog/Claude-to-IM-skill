/**
 * Bootstrap script: patches the `ws` WebSocket module to use an HTTPS proxy agent.
 * Loaded via NODE_OPTIONS="--require ./scripts/proxy-bootstrap.cjs"
 */
const proxyUrl = process.env.CTI_DISCORD_PROXY || process.env.HTTPS_PROXY;
if (!proxyUrl) return;

const noProxy = (process.env.NO_PROXY || '').split(',').map(s => s.trim()).filter(Boolean);

try {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  const agent = new HttpsProxyAgent(proxyUrl);
  const maskedUrl = proxyUrl.replace(/:[^:@]+@/, ':****@');
  console.log(`[proxy-bootstrap] Proxy agent ready: ${maskedUrl}`);

  // Monkey-patch the ws WebSocket constructor to inject the agent
  const WS = require('ws');
  const OrigWebSocket = WS.WebSocket || WS;
  const patchedWS = function PatchedWebSocket(url, protocols, options) {
    // Check NO_PROXY
    let urlStr = typeof url === 'string' ? url : url?.toString?.() || '';
    let skip = false;
    for (const pattern of noProxy) {
      if (pattern && urlStr.includes(pattern.replace(/^\*\./, '').replace(/^\./, ''))) {
        skip = true;
        break;
      }
    }
    if (!skip) {
      if (typeof protocols === 'object' && !Array.isArray(protocols)) {
        options = protocols;
        protocols = undefined;
      }
      options = options || {};
      if (!options.agent) {
        options.agent = agent;
      }
    }
    if (protocols) {
      return new OrigWebSocket(url, protocols, options);
    }
    return new OrigWebSocket(url, options);
  };
  patchedWS.prototype = OrigWebSocket.prototype;
  Object.setPrototypeOf(patchedWS, OrigWebSocket);
  // Copy static properties
  for (const key of Object.getOwnPropertyNames(OrigWebSocket)) {
    if (key !== 'prototype' && key !== 'length' && key !== 'name') {
      try { patchedWS[key] = OrigWebSocket[key]; } catch {}
    }
  }
  // Replace in module cache
  const wsModule = require.cache[require.resolve('ws')];
  if (wsModule) {
    wsModule.exports = patchedWS;
    wsModule.exports.WebSocket = patchedWS;
    wsModule.exports.Server = OrigWebSocket.Server;
    wsModule.exports.Receiver = OrigWebSocket.Receiver;
    wsModule.exports.Sender = OrigWebSocket.Sender;
    wsModule.exports.createWebSocketStream = OrigWebSocket.createWebSocketStream;
  }
} catch (e) {
  console.warn('[proxy-bootstrap] Failed to set up proxy:', e.message);
}

/**
 * ESM bootstrap: patches the `ws` WebSocket module to use an HTTPS proxy agent.
 * Loaded via node --import ./scripts/proxy-bootstrap.mjs
 */
const proxyUrl = process.env.CTI_DISCORD_PROXY || process.env.HTTPS_PROXY;
if (proxyUrl) {
  const noProxy = (process.env.NO_PROXY || 'feishu.cn,larksuite.com,127.0.0.1,localhost').split(',').map(s => s.trim()).filter(Boolean);

  try {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    const agent = new HttpsProxyAgent(proxyUrl);
    const maskedUrl = proxyUrl.replace(/:[^:@]+@/, ':****@');
    console.log(`[proxy-bootstrap] Proxy agent ready: ${maskedUrl}`);

    // Monkey-patch ws via module hook — we need to intercept require('ws')
    // Since ws is loaded via CJS require by discord.js, use Module._load hook
    const { createRequire } = await import('node:module');
    const Module = await import('node:module');
    const origLoad = Module.default._load;

    Module.default._load = function(request, parent, isMain) {
      const result = origLoad.call(this, request, parent, isMain);
      if ((request === 'ws' || request === 'ws/wrapper.mjs') && result && typeof result === 'function' && !result.__proxyPatched) {
        console.log(`[proxy-bootstrap] Patching ws module (request=${request})`);

        const OrigWS = result;
        const patchedWS = function PatchedWebSocket(url, protocols, options) {
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
            return new OrigWS(url, protocols, options);
          }
          return new OrigWS(url, options);
        };
        patchedWS.prototype = OrigWS.prototype;
        Object.setPrototypeOf(patchedWS, OrigWS);
        for (const key of Object.getOwnPropertyNames(OrigWS)) {
          if (key !== 'prototype' && key !== 'length' && key !== 'name') {
            try { Object.defineProperty(patchedWS, key, Object.getOwnPropertyDescriptor(OrigWS, key)); } catch {}
          }
        }
        patchedWS.__proxyPatched = true;
        // Replace in module cache
        if (parent && parent.exports === OrigWS) {
          parent.exports = patchedWS;
        }
        return patchedWS;
      }
      return result;
    };
  } catch (e) {
    console.warn('[proxy-bootstrap] Failed to set up proxy:', e.message);
  }
}

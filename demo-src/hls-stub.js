// Live-demo stand-in for hls.js: there is no HLS server on static hosting, so "live channels" play a looping sample clip.
// (The real app ships the actual hls.js and plays genuine HLS streams through its hardened proxy.)
(() => {
  const SRC = new URL('media/sample-h264.mp4', document.currentScript.src).href;
  const Events = { ERROR: 'hlsError', FRAG_LOADED: 'hlsFragLoaded', MANIFEST_PARSED: 'hlsManifestParsed', LEVEL_UPDATED: 'hlsLevelUpdated' };
  const ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
  class Hls {
    static isSupported() { return true; }
    static get Events() { return Events; }
    static get ErrorTypes() { return ErrorTypes; }
    constructor() { this.h = {}; }
    on(e, f) { (this.h[e] ||= []).push(f); }
    loadSource() {}
    attachMedia(v) {
      this.v = v; v.loop = true; v.src = SRC;
      setTimeout(() => { for (const f of this.h[Events.MANIFEST_PARSED] || []) f(); for (const f of this.h[Events.FRAG_LOADED] || []) f(); }, 60);
    }
    startLoad() {} recoverMediaError() {} swapAudioCodec() {}
    destroy() { if (this.v) this.v.loop = false; }
  }
  window.Hls = Hls;
})();

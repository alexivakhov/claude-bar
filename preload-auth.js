// Registered on the scraper session (see main.js) so it also covers the OAuth
// popups. Runs before any page script on accounts.google.com.
//
// Electron has no WebAuthn platform authenticator on macOS: no passkey sheet
// ever appears. Google still sees `PublicKeyCredential` and, for an account
// with a passkey, lands on "Verifying it's you… Complete sign-in using your
// passkey" — a screen that waits forever, with the widget stuck logged out.
// Hiding WebAuthn makes Google fall back to the other sign-in methods
// (password, 2-step prompt) instead of offering the one that cannot work here.
const { webFrame } = require('electron');

if (location.hostname === 'accounts.google.com') {
  webFrame.executeJavaScript(`(() => {
    try {
      Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true });
    } catch (e) {}
    try {
      const creds = navigator.credentials;
      for (const method of ['get', 'create']) {
        const orig = creds[method].bind(creds);
        creds[method] = (opts) => (opts && opts.publicKey)
          ? Promise.reject(new DOMException('WebAuthn is not supported in this window', 'NotAllowedError'))
          : orig(opts);
      }
    } catch (e) {}
  })()`);
}

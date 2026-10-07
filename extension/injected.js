/**
 * Injected into the page's MAIN world on flow.google.com — has access to window.grecaptcha.
 *
 * Used solely for reCAPTCHA solving. Media urls still come back on the
 * generation response itself, so no response interception is needed here.
 *
 * Wrapped in an IIFE with a run-once guard: the manifest injects this file in
 * the MAIN world AND content.js adds it as a <script> tag (for tabs opened
 * before the extension loaded). Without the guard a second run would register
 * a second listener and mint two captchas per request. Events are prefixed
 * FS_ so this never cross-talks with the old Flowboard Bridge on the same tab.
 */
(() => {
  const RUN_ONCE = Symbol.for('flow-hub.injected');
  if (window[RUN_ONCE]) return;
  Object.defineProperty(window, RUN_ONCE, { value: true });

  const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

  /**
   * Protect grecaptcha.enterprise.execute from being hijacked by Google Flow page scripts.
   * Since late Sep 2026, Flow page scripts re-bind grecaptcha.enterprise.execute to force
   * action: "extension_hijack_detected", causing PUBLIC_ERROR_UNUSUAL_ACTIVITY on RPCs.
   * This trap captures the real grecaptcha.enterprise.execute from Google reCAPTCHA Enterprise
   * and blocks Flow from overwriting it via property assignment or Object.defineProperty.
   */
  (function protectGrecaptcha() {
    let realExecute = null;

    // 1. Trap Object.defineProperty to block Flow from redefining grecaptcha.enterprise.execute
    const origDefineProperty = Object.defineProperty;
    Object.defineProperty = function (obj, prop, descriptor) {
      if (prop === 'execute' && descriptor && (descriptor.value || descriptor.get)) {
        const fn = descriptor.value || (typeof descriptor.get === 'function' ? descriptor.get() : null);
        if (typeof fn === 'function') {
          const src = fn.toString();
          if (src.includes('extension_hijack_detected')) {
            console.warn('[FlowHub] Blocked Object.defineProperty hijack attempt on grecaptcha.enterprise.execute');
            return obj;
          }
          if (!realExecute && !src.includes('extension_hijack_detected')) {
            realExecute = fn;
          } else if (realExecute && fn !== realExecute) {
            console.warn('[FlowHub] Ignored Object.defineProperty re-definition on grecaptcha.enterprise.execute');
            return obj;
          }
        }
      }
      return origDefineProperty.call(this, obj, prop, descriptor);
    };

    // 2. Property descriptor trap for window.grecaptcha.enterprise.execute
    function trapExecute(enterpriseObj) {
      if (!enterpriseObj || typeof enterpriseObj !== 'object') return;

      let target = enterpriseObj.execute;
      if (typeof target === 'function' && !target.toString().includes('extension_hijack_detected')) {
        realExecute = target;
      }

      try {
        origDefineProperty.call(Object, enterpriseObj, 'execute', {
          configurable: true,
          enumerable: true,
          get() {
            return realExecute || target;
          },
          set(fn) {
            if (typeof fn === 'function') {
              const src = fn.toString();
              if (src.includes('extension_hijack_detected')) {
                console.warn('[FlowHub] Prevented grecaptcha.enterprise.execute hijack assignment');
                return;
              }
              if (!realExecute) {
                realExecute = fn;
                target = fn;
              } else {
                console.warn('[FlowHub] Ignored grecaptcha.enterprise.execute re-assignment');
              }
            }
          },
        });
      } catch (e) {
        console.error('[FlowHub] Failed to trap enterprise.execute', e);
      }
    }

    function trapEnterprise(grecaptchaObj) {
      if (!grecaptchaObj || typeof grecaptchaObj !== 'object') return;

      let target = grecaptchaObj.enterprise;
      if (target) trapExecute(target);

      try {
        origDefineProperty.call(Object, grecaptchaObj, 'enterprise', {
          configurable: true,
          enumerable: true,
          get() {
            return target;
          },
          set(val) {
            target = val;
            if (val) trapExecute(val);
          },
        });
      } catch (e) {
        console.error('[FlowHub] Failed to trap grecaptcha.enterprise', e);
      }
    }

    let currentGrecaptcha = window.grecaptcha;
    if (currentGrecaptcha) trapEnterprise(currentGrecaptcha);

    try {
      origDefineProperty.call(Object, window, 'grecaptcha', {
        configurable: true,
        enumerable: true,
        get() {
          return currentGrecaptcha;
        },
        set(val) {
          currentGrecaptcha = val;
          if (val) trapEnterprise(val);
        },
      });
    } catch (e) {
      console.error('[FlowHub] Failed to trap window.grecaptcha', e);
    }
  })();

  // Mints are serialised. On the batchexecute path every RPC carries its own
  // single-use token, and an image dispatch fires up to four RPCs at once —
  // overlapping grecaptcha.enterprise.execute() calls for the same action return
  // interfering tokens, and a replayed or crossed one comes back from Flow as
  // PUBLIC_ERROR_UNUSUAL_ACTIVITY. Queueing them costs a few hundred ms per
  // variant and removes that whole failure mode.
  let captchaMintTail = Promise.resolve();

  async function mintCaptcha(pageAction) {
    const previous = captchaMintTail.catch(() => {});
    let release;
    captchaMintTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      await waitForGrecaptcha();
      return await window.grecaptcha.enterprise.execute(SITE_KEY, {
        action: pageAction,
      });
    } finally {
      release();
    }
  }

  window.addEventListener('FS_GET_CAPTCHA', async ({ detail }) => {
    const { requestId, pageAction } = detail;
    try {
      const token = await mintCaptcha(pageAction);
      window.dispatchEvent(new CustomEvent('FS_CAPTCHA_RESULT', {
        detail: { requestId, token },
      }));
    } catch (e) {
      window.dispatchEvent(new CustomEvent('FS_CAPTCHA_RESULT', {
        detail: { requestId, error: e.message },
      }));
    }
  });

  function waitForGrecaptcha(timeout = 22000) {   // lazily loaded; 10s was optimistic
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.grecaptcha?.enterprise?.execute) return resolve();
        if (Date.now() - start > timeout) return reject(new Error('grecaptcha not available'));
        setTimeout(check, 200);
      };
      check();
    });
  }
})();

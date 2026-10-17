"""The extension's credit badge: the nzlxg call, and the read of its answer.

Pinned against the request and response Flow's own page produced on 2026-10-15
for an account holding 186 credits — the capture the badge is built from:

* the body must be byte-identical to what the page put in ``f.req``, asserted
  here in Python against the constant in extension/background.js;
* the reader in extension/background.js must turn that very response into 186.
  It runs under node against the real file (skipped when node is missing), since
  a parser that only works on a hand-built answer proves nothing;
* the popup must render it next to the extension's name.
"""
import base64
import json
import re
import shutil
import subprocess
import urllib.parse
from pathlib import Path

import pytest

from flowhub.protocol import batch as fb

ROOT = Path(__file__).resolve().parent.parent
BACKGROUND = ROOT / "extension" / "background.js"

#: The page's own ``f.req`` for a credits read, URL-encoded as captured.
FREQ_CAPTURED = "%5B%5B%5B%22nzlxg%22%2C%22%5B%5D%22%2Cnull%2C%22generic%22%5D%5D%5D"

#: The answer, byte for byte: one wrb.fr result (payload slot 0 is the balance),
#: the page's bookkeeping entries, then the trailing ``["e",4,…]`` chunk.
RESPONSE_OK = (
    ")]}'\n\n"
    '147\n[["wrb.fr","nzlxg","[186,1,2,2,null,186,[1794124265,641376000]]",'
    'null,null,null,"generic"],["di",325],["af.httprm",324,"4509030541557100783",67]]\n'
    '25\n[["e",4,null,null,183]]'
)
#: Same shape with the balance only in slot 5 — the reader's fallback.
RESPONSE_SLOT5 = ("])}'\n\n10\n"
                  + '[["wrb.fr","nzlxg","[null,1,2,2,null,42,[1,2]]",null,null,null,"generic"]]')
#: A rejected RPC must raise, never be read as a balance.
RESPONSE_ERROR = ("])}'\n\n192\n"
                  + json.dumps([["wrb.fr", "nzlxg", None, None, None,
                                 [7, None, [["type.googleapis.com/google.rpc.ErrorInfo",
                                             ["PUBLIC_ERROR_UNUSUAL_ACTIVITY"]]]], "generic"]]))
#: Another RPC's answer carries no balance at all.
RESPONSE_OTHER = ("])}'\n\n99\n"
                  + json.dumps([["wrb.fr", "Zzl0ze", "[]", None, None, None, "generic"]]))

HARNESS = r"""
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const [srcPath, ok, slot5, err, other] = process.argv.slice(2).map(
  (a, i) => (i ? Buffer.from(a, 'base64').toString('utf8') : a),
);

// background.js is an MV3 service worker: it needs a chrome namespace and
// timers that do not exist outside Chrome. Stub just enough to load the file —
// the config is empty, so startup stops at 'unconfigured' and no network runs.
const noop = () => {};
const event = () => ({ addListener: noop });
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: 'test' }), onInstalled: event(), onStartup: event(), onMessage: event() },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  alarms: { create: noop, onAlarm: event() },
  tabs: { onUpdated: event(), onRemoved: event(), onActivated: event() },
  webRequest: { onBeforeRequest: event(), onSendHeaders: event(), onCompleted: event(), onErrorOccurred: event() },
  debugger: { onEvent: event(), onDetach: event() },
  action: { setBadgeText: async () => {}, setTitle: async () => {} },
};
globalThis.setInterval = () => 0;   // keepalive timers would pin the process open

const src = readFileSync(srcPath, 'utf8');
vm.runInThisContext(
  src + '\n;globalThis.__credits = { CREDITS_FREQ, decodeEnvelope, readCredits };',
  { filename: srcPath },
);
const { CREDITS_FREQ, decodeEnvelope, readCredits } = globalThis.__credits;

assert.equal(CREDITS_FREQ, '[[["nzlxg","[]",null,"generic"]]]', 'body differs from the page f.req');
assert.equal(readCredits(ok), 186, 'the captured balance');
assert.equal(decodeEnvelope(ok).length, 1, 'bookkeeping and the ["e",…] chunk carry no result');
assert.equal(readCredits(slot5), 42, 'slot 5 stands in when slot 0 is null');
assert.throws(() => readCredits(err), /PUBLIC_ERROR_UNUSUAL_ACTIVITY/);
assert.throws(() => readCredits(other), /no nzlxg envelope/);
assert.throws(() => readCredits(''), /no nzlxg envelope/);
console.log('extension credits: ok = 186, error/missing/slot-5 handled');
"""


def b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def test_request_body_is_what_the_page_sent():
    """extension/background.js must post the very body Flow's page posted."""
    source = BACKGROUND.read_text(encoding="utf-8")
    match = re.search(r"const CREDITS_FREQ = '([^']*)';", source)
    assert match, "background.js must declare CREDITS_FREQ"
    assert match.group(1) == urllib.parse.unquote(FREQ_CAPTURED)
    assert json.loads(match.group(1)) == [[["nzlxg", "[]", None, "generic"]]]
    # The server's own codec must read it back as the no-parameter call it is.
    assert fb.decode_envelope(match.group(1)) == [("nzlxg", [])]


def test_response_reader_returns_the_captured_balance(tmp_path):
    """The extension's own reader turns the real response into 186."""
    node = shutil.which("node")
    if node is None:
        pytest.skip("node not installed")
    harness = tmp_path / "credits.mjs"
    harness.write_text(HARNESS, encoding="utf-8")
    proc = subprocess.run(
        [node, str(harness), str(BACKGROUND),
         b64(RESPONSE_OK), b64(RESPONSE_SLOT5), b64(RESPONSE_ERROR), b64(RESPONSE_OTHER)],
        capture_output=True, text=True, encoding="utf-8",
    )
    assert proc.returncode == 0, f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    assert "ok = 186" in proc.stdout


def test_popup_shows_the_balance_next_to_the_name():
    html = (ROOT / "extension" / "popup.html").read_text(encoding="utf-8")
    js = (ROOT / "extension" / "popup.js").read_text(encoding="utf-8")
    background = BACKGROUND.read_text(encoding="utf-8")
    # Same header block as the name — beside it, not in a row further down.
    assert html.index("Flow Hub Worker") < html.index('id="credits"') < html.index('id="state"')
    assert 'id="credits-detail"' in html and 'id="refresh-credits"' in html
    assert "paintCredits(s.credits)" in js and "GET_CREDITS" in js
    # The toolbar icon stays clear — no number over it while the popup is
    # closed: the badge is explicitly emptied and the balance moved to the
    # icon's tooltip, refreshed by the alarm and after each generation.
    assert "chrome.action.setBadgeText({ text: '' })" in background
    assert "setBadgeBackgroundColor" not in background
    assert "`Flow Hub Worker — ${credits.value} credit" in background
    assert "case 'GET_CREDITS'" in background
    assert "chrome.alarms.create(CREDITS_ALARM" in background
